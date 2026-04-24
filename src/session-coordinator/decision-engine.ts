/**
 * Session Execution Coordinator — Decision Engine
 *
 * Pure function: (CoordinatorState, Observation, FallbackConfig) → Decision
 * This is the "brain" — the single place where lifecycle decisions are made.
 * No side effects, no IO, no async.
 */

import type { CoordinatorState, Observation, Decision, FallbackConfigSnapshot } from "./types"

const MAX_CONSECUTIVE_RECOVERIES = 3
const MAX_CONSECUTIVE_TIMEOUTS = 5
const VISIBLE_PROGRESS_RECENCY_MS = 2_000
const LONG_RUNNING_TIMEOUT_MULTIPLIER = 4

export function decide(
  state: CoordinatorState,
  observation: Observation,
  config: FallbackConfigSnapshot,
): Decision {

  // ==================================================================
  // GLOBAL GUARD: If an action is already in-flight — WAIT
  // This is the key guard that eliminates conflicts #1, #4, #6
  // ==================================================================

  if (state.recoveryInFlight && observation.kind !== "recovery_result") {
    if (
      observation.kind === "timeout_fired" ||
      observation.kind === "assistant_empty" ||
      observation.kind === "delegation_timeout_fired"
    ) {
      return { action: "wait", reason: "recovery_in_flight" }
    }
  }

  if (state.fallbackInFlight && observation.kind !== "fallback_session_active") {
    if (
      observation.kind === "timeout_fired" ||
      observation.kind === "assistant_empty" ||
      observation.kind === "delegation_timeout_fired"
    ) {
      return { action: "wait", reason: "fallback_in_flight" }
    }
  }

  // ==================================================================
  // ANTI-LOOP GUARD: Prevent infinite retry cycles
  // Eliminates conflict #4 (promotion loops)
  // ==================================================================

  if (state.consecutiveRecoveryCount >= MAX_CONSECUTIVE_RECOVERIES) {
    if (observation.kind === "assistant_empty" || observation.kind === "timeout_fired") {
      return { action: "abort_session", reason: "max_consecutive_recoveries_reached" }
    }
  }

  if (state.consecutiveTimeoutCount >= MAX_CONSECUTIVE_TIMEOUTS) {
    if (observation.kind === "timeout_fired") {
      return { action: "abort_session", reason: "max_consecutive_timeouts_reached" }
    }
  }

  // ==================================================================
  // Per-observation decisions
  // ==================================================================

  switch (observation.kind) {

    // --- EMPTY TURN (conflicts #1, #3) ---
    case "assistant_empty": {
      // Child tasks still working? → not a recovery, wait
      if (state.activeChildTaskIDs.size > 0) {
        return { action: "wait", reason: "child_tasks_active" }
      }
      // Visible progress was recent? → streamed delta, not truly empty
      if (
        state.lastVisibleProgressAt > 0 &&
        Date.now() - state.lastVisibleProgressAt < VISIBLE_PROGRESS_RECENCY_MS
      ) {
        return { action: "none" }
      }
      // Watchdog armed? → let the timeout path handle it (don't duplicate)
      if (state.watchdogArmed) {
        return { action: "wait", reason: "watchdog_will_handle" }
      }
      return { action: "recover_empty_turn" }
    }

    // --- TIMEOUT (conflicts #1, #2, #5) ---
    case "timeout_fired": {
      const extendedTimeoutMs = config.baseTimeoutMs * LONG_RUNNING_TIMEOUT_MULTIPLIER

      // Child tasks active? → extend watchdog, don't fallback
      if (state.activeChildTaskIDs.size > 0) {
        return {
          action: "extend_watchdog",
          timeoutMs: extendedTimeoutMs,
          reason: "child_tasks_active",
        }
      }
      // Delegation in progress? → delegation has its own timeout
      if (state.phase === "delegating") {
        return { action: "wait", reason: "delegation_in_progress" }
      }
      // Waiting for provider retry? → let provider finish
      if (state.phase === "waiting_provider") {
        return {
          action: "extend_watchdog",
          timeoutMs: config.baseTimeoutMs,
          reason: "provider_retry_in_progress",
        }
      }
      // Fallback to next model
      if (config.hasFallbackModels) {
        return { action: "fallback_next_model" }
      }
      return { action: "abort_session", reason: "timeout_no_fallback_models" }
    }

    // --- DELEGATION TIMEOUT (conflict #5) ---
    case "delegation_timeout_fired": {
      return { action: "abort_session", reason: "delegation_timed_out" }
    }

    // --- PROGRESS (conflict #3) ---
    case "assistant_progress": {
      if (observation.hasVisibleContent) {
        return state.watchdogArmed
          ? {
              action: "extend_watchdog",
              timeoutMs: config.baseTimeoutMs,
              reason: "visible_progress",
            }
          : {
              action: "arm_watchdog",
              timeoutMs: config.baseTimeoutMs,
              reason: "new_progress",
            }
      }
      // Non-visible progress (reasoning, meta, etc.) — keep watchdog as-is
      if (!state.watchdogArmed && state.phase !== "idle") {
        return {
          action: "arm_watchdog",
          timeoutMs: config.baseTimeoutMs,
          reason: "non_visible_progress",
        }
      }
      return { action: "none" }
    }

    // --- COMPLETION ---
    case "assistant_complete": {
      return { action: "disarm_watchdog", reason: "completed" }
    }

    // --- SESSION STATUS ---
    case "session_status_active": {
      if (!state.watchdogArmed && state.phase !== "idle") {
        return {
          action: "arm_watchdog",
          timeoutMs: config.baseTimeoutMs,
          reason: "active_status_pulse",
        }
      }
      if (state.watchdogArmed) {
        return {
          action: "extend_watchdog",
          timeoutMs: config.baseTimeoutMs,
          reason: "active_status_pulse",
        }
      }
      return { action: "none" }
    }

    case "session_status_retry": {
      // Provider is auto-retrying — wait for it
      return { action: "none" }
    }

    case "session_status_idle": {
      if (state.watchdogArmed) {
        return { action: "disarm_watchdog", reason: "session_idle" }
      }
      return { action: "none" }
    }

    // --- ERROR ---
    case "session_error": {
      if (observation.isLocalToolAbort) {
        return { action: "retry_same_model" }
      }
      if (observation.isRetryable) {
        return { action: "retry_same_model" }
      }
      if (config.hasFallbackModels) {
        return { action: "fallback_next_model" }
      }
      return { action: "abort_session", reason: "non_retryable_error" }
    }

    // --- CHILD TASK EVENTS (conflict #2) ---
    case "child_task_started": {
      if (state.watchdogArmed) {
        return {
          action: "extend_watchdog",
          timeoutMs: config.baseTimeoutMs * LONG_RUNNING_TIMEOUT_MULTIPLIER,
          reason: "child_task_started",
        }
      }
      return { action: "none" }
    }

    case "child_task_completed":
    case "child_task_failed": {
      // If this was the last child and we're in waiting_child — mark completed
      if (state.activeChildTaskIDs.size === 0 && state.phase === "waiting_child") {
        return { action: "mark_completed" }
      }
      return { action: "none" }
    }

    // --- STOP ---
    case "session_stopped": {
      return { action: "disarm_watchdog", reason: "user_stopped" }
    }

    // --- FEEDBACK observations (after executing a Decision) ---
    case "fallback_dispatched":
    case "fallback_session_active":
    case "recovery_dispatched":
    case "recovery_result":
      // State is updated by observation-reducer; no new decision needed
      return { action: "none" }

    default:
      return { action: "none" }
  }
}
