import { describe, expect, test } from "bun:test"
import { evaluateCouncilQuorum } from "./council-quorum"

describe("evaluateCouncilQuorum", () => {
  test("#given partial failures with enough successful members #when evaluating #then quorum reached with graceful degradation", () => {
    // given
    const input = {
      totalMembers: 5,
      successfulMembers: 3,
      failedMembers: 2,
    }

    // when
    const result = evaluateCouncilQuorum(input)

    // then
    expect(result.required).toBe(3)
    expect(result.reached).toBe(true)
    expect(result.gracefulDegradation).toBe(true)
  })

  test("#given too many failures #when evaluating #then quorum is unreachable", () => {
    // given
    const input = {
      totalMembers: 4,
      successfulMembers: 1,
      failedMembers: 3,
    }

    // when
    const result = evaluateCouncilQuorum(input)

    // then
    expect(result.required).toBe(2)
    expect(result.reached).toBe(false)
    expect(result.canStillReach).toBe(false)
  })
})
