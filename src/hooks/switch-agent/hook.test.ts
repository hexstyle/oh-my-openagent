import { describe, expect, test, beforeEach } from "bun:test"
import { createSwitchAgentHook } from "./hook"
import {
  _resetForTesting,
  getSessionAgent,
  setPendingSessionAgentSwitch,
} from "../../features/claude-code-session-state"

describe("switch-agent hook", () => {
  beforeEach(() => {
    _resetForTesting()
  })

  test("#given pending switch #when chat.message hook runs #then output agent is switched and persisted", async () => {
    // given
    const hook = createSwitchAgentHook()
    setPendingSessionAgentSwitch("ses-1", "explore")
    const input = { sessionID: "ses-1", agent: "sisyphus" }
    const output = {
      message: {} as Record<string, unknown>,
      parts: [] as Array<{ type: string; text?: string }>,
    }

    // when
    await hook["chat.message"](input, output)

    // then
    expect(input.agent).toBe("explore")
    expect(output.message["agent"]).toBe("explore")
    expect(getSessionAgent("ses-1")).toBe("explore")
  })
})
