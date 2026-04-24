/**
 * Session Execution Coordinator — Observation Reducer
 *
 * Pure functions that mutate CoordinatorState based on Observations and Decisions.
 * No side effects, no IO.
 */

import type { CoordinatorState, Observation, Decision } from "./types"

export function applyObservation(state: CoordinatorState, obs: Observation): void {
  state.lastObservationAt = Date.now()

  switch (obs.kind) {
    case "assistant_progress":
      if (obs.hasVisibleContent) {
        state.lastVisibleProgressAt = Date.now()
        // Visible progress resets loop counters
        state.consecutiveRecoveryCount = 0
        state.consecutiveTimeoutCount = 0
      }
      break

    case "assistant_complete":
      if (obs.hasVisibleContent) {
        state.consecutiveRecoveryCount = 0
        state.consecutiveTimeoutCount = 0
      }
      break

    case "child_task_started":
      state.activeChildTaskIDs.add(obs.taskID)
      break

    case "child_task_completed":
    case "child_task_failed":
      state.activeChildTaskIDs.delete(obs.taskID)
      break

    case "fallback_dispatched":
      // Only track in-flight for scoped handoffs (which have a child session
      // lifecycle to await). Same-session retries are fire-and-forget — the
      // session will produce progress or timeout again.
      if (obs.isScopedHandoff) {
        state.fallbackInFlight = true
        state.delegationStartedAt = Date.now()
      }
      break

    case "fallback_session_active":
      state.fallbackInFlight = false
      state.delegationStartedAt = undefined
      break

    case "recovery_dispatched":
      state.recoveryInFlight = true
      state.consecutiveRecoveryCount += 1
      break

    case "recovery_result":
      state.recoveryInFlight = false
      break

    case "timeout_fired":
      state.consecutiveTimeoutCount += 1
      state.watchdogArmed = false
      break

    case "session_stopped":
      state.watchdogArmed = false
      state.recoveryInFlight = false
      state.fallbackInFlight = false
      state.delegationStartedAt = undefined
      state.consecutiveRecoveryCount = 0
      state.consecutiveTimeoutCount = 0
      break

    case "session_status_idle":
      // If the session is idle but in-flight flags are set, something
      // was missed (e.g. recovery_result never arrived). Clear them so
      // the session doesn't get permanently stuck.
      state.recoveryInFlight = false
      state.fallbackInFlight = false
      break

    default:
      break
  }
}

export function applyDecision(state: CoordinatorState, decision: Decision): void {
  switch (decision.action) {
    case "arm_watchdog":
    case "extend_watchdog":
      state.watchdogArmed = true
      break

    case "disarm_watchdog":
      state.watchdogArmed = false
      break

    // Pre-set recoveryInFlight for empty turn recovery: closes the gap
    // between the coordinator's decision and the module's
    // recovery_dispatched observation. Without this, a second
    // assistant_empty event in the same tick could trigger a duplicate.
    // NOTE: only recover_empty_turn is pre-set because it is the only
    // recovery decision that is GATED by coordinator code (event.ts
    // checks the decision before proceeding). Timeout decisions
    // (retry_same_model, fallback_next_model) fall through to legacy
    // code which sends its own observations — pre-setting their flags
    // would cause the flag to stick because legacy never sends
    // recovery_result for these paths.
    case "recover_empty_turn":
      state.recoveryInFlight = true
      break

    case "mark_completed":
      state.watchdogArmed = false
      break

    case "abort_session":
      state.watchdogArmed = false
      state.recoveryInFlight = false
      state.fallbackInFlight = false
      break

    default:
      break
  }
}
