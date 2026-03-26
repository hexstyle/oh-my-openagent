import { describe, expect, test, beforeEach } from "bun:test"
import {
  clearPendingSessionAgentSwitch,
  consumePendingSessionAgentSwitch,
  getPendingSessionAgentSwitch,
  resetPendingSessionAgentSwitchesForTesting,
  setPendingSessionAgentSwitch,
} from "./switch-agent-state"

describe("switch-agent-state", () => {
  beforeEach(() => {
    resetPendingSessionAgentSwitchesForTesting()
  })

  test("#given pending switch #when consuming #then consumes once and clears", () => {
    // given
    setPendingSessionAgentSwitch("ses-1", "explore")

    // when
    const first = consumePendingSessionAgentSwitch("ses-1")
    const second = consumePendingSessionAgentSwitch("ses-1")

    // then
    expect(first?.agent).toBe("explore")
    expect(second).toBeUndefined()
  })

  test("#given pending switch #when clearing #then state is removed", () => {
    // given
    setPendingSessionAgentSwitch("ses-1", "librarian")

    // when
    clearPendingSessionAgentSwitch("ses-1")

    // then
    expect(getPendingSessionAgentSwitch("ses-1")).toBeUndefined()
  })
})
