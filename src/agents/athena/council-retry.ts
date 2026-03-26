export type CouncilMemberTaskStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"

export interface CouncilMemberTaskState {
  status: CouncilMemberTaskStatus
  attempts: number
  nudges: number
  startedAt: number
  lastProgressAt: number
}

export interface CouncilRetryPolicy {
  maxAttempts: number
  maxNudges: number
  stuckAfterMs: number
}

export type CouncilRecoveryAction = "wait" | "nudge" | "retry" | "give_up"

export interface CouncilRecoveryDecision {
  action: CouncilRecoveryAction
  reason: string
}

export function isCouncilMemberStuck(
  now: number,
  lastProgressAt: number,
  stuckAfterMs: number,
): boolean {
  return now - lastProgressAt >= stuckAfterMs
}

export function decideCouncilRecoveryAction(
  state: CouncilMemberTaskState,
  policy: CouncilRetryPolicy,
  now: number,
): CouncilRecoveryDecision {
  if (state.status === "completed" || state.status === "cancelled") {
    return { action: "give_up", reason: "Task already reached terminal status" }
  }

  if (state.status === "failed" || state.status === "timed_out") {
    if (state.attempts < policy.maxAttempts) {
      return { action: "retry", reason: "Terminal failure with retries remaining" }
    }
    return { action: "give_up", reason: "Terminal failure and retry budget exhausted" }
  }

  const stuck = isCouncilMemberStuck(now, state.lastProgressAt, policy.stuckAfterMs)
  if (!stuck) {
    return { action: "wait", reason: "Task is still making progress" }
  }

  if (state.nudges < policy.maxNudges) {
    return { action: "nudge", reason: "Task appears stuck and nudge budget remains" }
  }

  if (state.attempts < policy.maxAttempts) {
    return { action: "retry", reason: "Task stuck after nudges, retrying with fresh run" }
  }

  return { action: "give_up", reason: "Task stuck and all recovery budgets exhausted" }
}
