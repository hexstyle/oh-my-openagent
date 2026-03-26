import { describe, expect, test } from "bun:test"
import { parseCouncilMemberResponse } from "./council-response-parser"

describe("parseCouncilMemberResponse", () => {
  test("#given valid raw json #when parsing #then returns parsed council payload", () => {
    // given
    const raw = JSON.stringify({
      member: "architect",
      verdict: "support",
      confidence: 0.9,
      rationale: "Matches existing module boundaries",
      risks: ["Regression in edge-case parser"],
      evidence: [{ source: "src/agents/athena.ts", detail: "Current prompt is too generic" }],
      proposed_actions: ["Add strict orchestration workflow"],
      missing_information: ["Need runtime timeout budget"],
    })

    // when
    const result = parseCouncilMemberResponse(raw)

    // then
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toBe("raw_json")
    expect(result.value.member).toBe("architect")
    expect(result.value.verdict).toBe("support")
  })

  test("#given tagged json payload #when parsing #then extracts from COUNCIL_MEMBER_RESPONSE tag", () => {
    // given
    const raw = [
      "analysis intro",
      "<COUNCIL_MEMBER_RESPONSE>",
      JSON.stringify({
        member: "skeptic",
        verdict: "mixed",
        confidence: 0.62,
        rationale: "Quorum logic exists but retry handling is weak",
        risks: ["Timeout blind spot"],
        evidence: [{ source: "src/tools/background-task/create-background-wait.ts", detail: "No nudge semantics" }],
        proposed_actions: ["Add stuck detection policy"],
        missing_information: [],
      }),
      "</COUNCIL_MEMBER_RESPONSE>",
    ].join("\n")

    // when
    const result = parseCouncilMemberResponse(raw)

    // then
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.source).toBe("tagged_json")
    expect(result.value.member).toBe("skeptic")
    expect(result.value.proposed_actions).toEqual(["Add stuck detection policy"])
  })

  test("#given malformed payload #when parsing #then returns structured parse failure", () => {
    // given
    const raw = "Council says: maybe this works"

    // when
    const result = parseCouncilMemberResponse(raw)

    // then
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.source).toBe("none")
    expect(result.error.length).toBeGreaterThan(0)
  })
})
