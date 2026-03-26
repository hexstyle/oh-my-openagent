import { describe, expect, test } from "bun:test"
import { getAgentToolRestrictions, hasAgentToolRestrictions } from "./agent-tool-restrictions"

describe("agent-tool-restrictions council-member", () => {
  test("returns council-member restrictions as read-only and non-delegating", () => {
    // given

    // when
    const restrictions = getAgentToolRestrictions("council-member")

    // then
    expect(restrictions.write).toBe(false)
    expect(restrictions.edit).toBe(false)
    expect(restrictions.apply_patch).toBe(false)
    expect(restrictions.task).toBe(false)
    expect(restrictions["task_*"]).toBe(false)
    expect(restrictions.call_omo_agent).toBe(false)
    expect(restrictions.switch_agent).toBe(false)
    expect(restrictions.teammate).toBe(false)
  })

  test("matches council-member case-insensitively", () => {
    // given

    // when
    const restrictions = getAgentToolRestrictions("Council-Member")

    // then
    expect(restrictions.write).toBe(false)
    expect(hasAgentToolRestrictions("Council-Member")).toBe(true)
  })

  test("matches dynamic council-member names by prefix", () => {
    // given

    // when
    const restrictions = getAgentToolRestrictions("council-member-architect")

    // then
    expect(restrictions.write).toBe(false)
    expect(restrictions.task).toBe(false)
    expect(hasAgentToolRestrictions("council-member-architect")).toBe(true)
  })
})
