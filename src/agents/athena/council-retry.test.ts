import { describe, expect, test } from "bun:test"
import { decideCouncilRecoveryAction } from "./council-retry"

describe("decideCouncilRecoveryAction", () => {
  test("#given running member with stale progress and nudge budget #when deciding #then nudge", () => {
    // given
    const now = 10_000
    const decision = decideCouncilRecoveryAction(
      {
        status: "running",
        attempts: 1,
        nudges: 0,
        startedAt: 1_000,
        lastProgressAt: 1_000,
      },
      {
        maxAttempts: 2,
        maxNudges: 1,
        stuckAfterMs: 2_000,
      },
      now,
    )

    // then
    expect(decision.action).toBe("nudge")
  })

  test("#given stuck member after nudge with retry budget #when deciding #then retry", () => {
    // given
    const now = 20_000
    const decision = decideCouncilRecoveryAction(
      {
        status: "running",
        attempts: 1,
        nudges: 1,
        startedAt: 1_000,
        lastProgressAt: 1_000,
      },
      {
        maxAttempts: 3,
        maxNudges: 1,
        stuckAfterMs: 5_000,
      },
      now,
    )

    // then
    expect(decision.action).toBe("retry")
  })
})
