export interface CouncilQuorumInput {
  totalMembers: number
  successfulMembers: number
  failedMembers: number
  requestedQuorum?: number
}

export interface CouncilQuorumResult {
  required: number
  reached: boolean
  canStillReach: boolean
  gracefulDegradation: boolean
}

function clampMinimumQuorum(totalMembers: number, requestedQuorum?: number): number {
  if (requestedQuorum && requestedQuorum > 0) {
    return Math.min(totalMembers, requestedQuorum)
  }

  return Math.max(1, Math.ceil(totalMembers / 2))
}

export function evaluateCouncilQuorum(input: CouncilQuorumInput): CouncilQuorumResult {
  const required = clampMinimumQuorum(input.totalMembers, input.requestedQuorum)
  const reached = input.successfulMembers >= required
  const remainingPossible = input.totalMembers - input.failedMembers
  const canStillReach = remainingPossible >= required
  const gracefulDegradation = reached && input.failedMembers > 0

  return {
    required,
    reached,
    canStillReach,
    gracefulDegradation,
  }
}
