/**
 * Session Execution Coordinator — Types
 *
 * Single source of truth for session lifecycle decisions.
 * All types are intentionally minimal: coordinator tracks only cross-module
 * state that no single module can see on its own.
 */

// ---------------------------------------------------------------------------
// Session Phase — the lifecycle state machine
// ---------------------------------------------------------------------------

export type SessionPhase =
  | "idle"
  | "running"
  | "tool_executing"
  | "delegating"
  | "waiting_child"
  | "waiting_provider"
  | "recovering"
  | "completed"
  | "failed"

// ---------------------------------------------------------------------------
// Observations — what modules SEE (not what they DECIDE)
// ---------------------------------------------------------------------------

export type Observation =
  // From runtime-fallback event-handler / message-update-handler
  | {
      kind: "assistant_progress"
      hasVisibleContent: boolean
      partType?: string
      toolName?: string
      toolStatus?: string
      isStreaming: boolean
    }
  | {
      kind: "assistant_complete"
      finishReason: string
      hasVisibleContent: boolean
    }
  | { kind: "assistant_empty"; messageID: string }
  | { kind: "session_status_active" }
  | { kind: "session_status_retry"; isQuota: boolean }
  | { kind: "session_status_idle" }
  | {
      kind: "session_error"
      isRetryable: boolean
      isQuota: boolean
      isLocalToolAbort: boolean
    }
  | { kind: "session_stopped" }
  // From background-agent manager
  | { kind: "child_task_started"; taskID: string }
  | { kind: "child_task_completed"; taskID: string }
  | { kind: "child_task_failed"; taskID: string }
  // From runtime-fallback (feedback after executing a Decision)
  | {
      kind: "fallback_dispatched"
      targetModel: string
      isScopedHandoff: boolean
    }
  | { kind: "fallback_session_active" }
  | { kind: "recovery_dispatched"; recoveryKind: string }
  | { kind: "recovery_result"; success: boolean }
  // Timers
  | { kind: "timeout_fired" }
  | { kind: "delegation_timeout_fired" }

// ---------------------------------------------------------------------------
// Decisions — what the coordinator DECIDES
// ---------------------------------------------------------------------------

export type Decision =
  | { action: "none" }
  | { action: "arm_watchdog"; timeoutMs: number; reason: string }
  | { action: "extend_watchdog"; timeoutMs: number; reason: string }
  | { action: "disarm_watchdog"; reason: string }
  | { action: "retry_same_model" }
  | { action: "fallback_next_model" }
  | { action: "scoped_handoff" }
  | { action: "recover_empty_turn" }
  | { action: "abort_session"; reason: string }
  | { action: "mark_completed" }
  | { action: "wait"; reason: string }

// ---------------------------------------------------------------------------
// Coordinator State — MINIMAL cross-module state per session
// ---------------------------------------------------------------------------

export interface CoordinatorState {
  phase: SessionPhase
  phaseEnteredAt: number
  previousPhase: SessionPhase

  // Cross-module visibility
  activeChildTaskIDs: Set<string>
  recoveryInFlight: boolean
  fallbackInFlight: boolean
  watchdogArmed: boolean

  // Timestamps for guards (cross-module only, not duplicating FallbackState)
  lastVisibleProgressAt: number
  lastObservationAt: number
  delegationStartedAt: number | undefined

  // Anti-loop
  consecutiveRecoveryCount: number
  consecutiveTimeoutCount: number
}

// ---------------------------------------------------------------------------
// Fallback config resolver — injected by the host module
// ---------------------------------------------------------------------------

export interface FallbackConfigSnapshot {
  baseTimeoutMs: number
  hasFallbackModels: boolean
}

export type FallbackConfigResolver = (sessionID: string) => FallbackConfigSnapshot

export function createInitialState(): CoordinatorState {
  const now = Date.now()
  return {
    phase: "idle",
    phaseEnteredAt: now,
    previousPhase: "idle",
    activeChildTaskIDs: new Set(),
    recoveryInFlight: false,
    fallbackInFlight: false,
    watchdogArmed: false,
    lastVisibleProgressAt: 0,
    lastObservationAt: now,
    delegationStartedAt: undefined,
    consecutiveRecoveryCount: 0,
    consecutiveTimeoutCount: 0,
  }
}
