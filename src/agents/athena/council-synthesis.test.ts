import { describe, expect, test } from "bun:test"
import { synthesizeCouncilOutcome } from "./council-synthesis"
import type { CouncilMemberResponse } from "./council-contract"

function response(overrides: Partial<CouncilMemberResponse>): CouncilMemberResponse {
  return {
    member: "member-a",
    verdict: "support",
    confidence: 0.8,
    rationale: "default rationale",
    risks: [],
    evidence: [{ source: "file.ts", detail: "detail" }],
    proposed_actions: ["Ship with tests"],
    missing_information: [],
    ...overrides,
  }
}

describe("synthesizeCouncilOutcome", () => {
  test("#given majority support with one failure #when synthesizing #then reports agreement and graceful degradation", () => {
    // given
    const responses = [
      response({ member: "architect", verdict: "support", proposed_actions: ["Ship with tests"] }),
      response({ member: "skeptic", verdict: "support", proposed_actions: ["Ship with tests"] }),
      response({ member: "critic", verdict: "oppose", risks: ["Parser drift"] }),
    ]

    // when
    const result = synthesizeCouncilOutcome({
      responses,
      failedMembers: ["perf"],
      quorumReached: true,
    })

    // then
    expect(result.majorityVerdict).toBe("support")
    expect(result.agreementMembers).toEqual(["architect", "skeptic"])
    expect(result.disagreementMembers).toContain("critic")
    expect(result.disagreementMembers).toContain("perf")
    expect(result.commonActions).toEqual(["Ship with tests"])
    expect(result.gracefulDegradation).toBe(true)
  })
})
