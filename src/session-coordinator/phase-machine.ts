/**
 * Session Execution Coordinator — Phase Machine
 *
 * Pure functions defining valid state transitions and phase derivation.
 * Zero side effects, zero imports beyond local types.
 */

import type { SessionPhase, Observation } from "./types"

// ---------------------------------------------------------------------------
// Valid transitions
// ---------------------------------------------------------------------------

export const VALID_TRANSITIONS: Record<SessionPhase, readonly SessionPhase[]> = {
  idle:             ["running", "waiting_child"],
  running:          ["tool_executing", "delegating", "waiting_child",
                     "waiting_provider", "recovering", "completed", "failed"],
  tool_executing:   ["running", "completed", "failed", "recovering"],
  delegating:       ["waiting_child", "failed", "idle"],
  waiting_child:    ["running", "completed", "failed"],
  waiting_provider: ["running", "failed", "recovering"],
  recovering:       ["running", "completed", "failed", "idle"],
  completed:        ["idle", "running"],
  failed:           ["idle", "recovering"],
} as const

export function canTransition(from: SessionPhase, to: SessionPhase): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false
}

// ---------------------------------------------------------------------------
// Phase derivation — given current phase + observation, what phase next?
// Returns undefined when the phase should not change.
// ---------------------------------------------------------------------------

export function derivePhase(
  current: SessionPhase,
  obs: Observation,
): SessionPhase | undefined {
  switch (obs.kind) {
    case "assistant_progress": {
      if (obs.partType === "tool" && obs.toolStatus === "running") {
        return current !== "tool_executing" ? "tool_executing" : undefined
      }
      if (obs.isStreaming) {
        return current !== "running" ? "running" : undefined
      }
      return current === "idle" ? "running" : undefined
    }

    case "assistant_complete":
      return current !== "completed" ? "completed" : undefined

    case "assistant_empty":
      return current !== "completed" ? "completed" : undefined

    case "session_status_active":
      return current === "idle" ? "running" : undefined

    case "session_status_retry":
      return current !== "waiting_provider" ? "waiting_provider" : undefined

    case "session_status_idle":
      return (current === "running" || current === "tool_executing")
        ? "completed"
        : undefined

    case "session_error":
      return current !== "failed" ? "failed" : undefined

    case "session_stopped":
      return current !== "idle" ? "idle" : undefined

    case "child_task_started":
      return current !== "waiting_child" ? "waiting_child" : undefined

    case "child_task_completed":
    case "child_task_failed":
      // Transition handled by coordinator after checking activeChildTaskIDs.size
      return undefined

    case "fallback_dispatched":
      return obs.isScopedHandoff ? "delegating" : "recovering"

    case "fallback_session_active":
      return current === "delegating" ? "waiting_child" : undefined

    case "recovery_dispatched":
      return current !== "recovering" ? "recovering" : undefined

    case "recovery_result":
      return obs.success ? "running" : "failed"

    case "timeout_fired":
      // Decision engine decides what to do; phase does not change until action
      return undefined

    case "delegation_timeout_fired":
      return current === "delegating" ? "failed" : undefined

    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Phase staleness — maximum duration per phase before auto-reset to idle
// ---------------------------------------------------------------------------

export const MAX_PHASE_DURATION_MS: Record<SessionPhase, number> = {
  idle:             Infinity,
  running:          30 * 60 * 1000,        // 30 min
  tool_executing:   10 * 60 * 1000,        // 10 min
  delegating:       60 * 1000,             // 1 min
  waiting_child:    60 * 60 * 1000,        // 1 hour
  waiting_provider: 15 * 60 * 1000,        // 15 min
  recovering:       60 * 1000,             // 1 min
  completed:        5 * 60 * 1000,         // 5 min
  failed:           5 * 60 * 1000,         // 5 min
}

export function isPhaseStale(phase: SessionPhase, phaseEnteredAt: number, now: number = Date.now()): boolean {
  const maxDuration = MAX_PHASE_DURATION_MS[phase]
  return now - phaseEnteredAt > maxDuration
}
