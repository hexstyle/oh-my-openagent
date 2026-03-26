import { describe, expect, test, beforeEach } from "bun:test"
import { createSwitchAgentTool } from "./tools"
import {
  _resetForTesting,
  getPendingSessionAgentSwitch,
} from "../../features/claude-code-session-state"

describe("switch_agent tool", () => {
  beforeEach(() => {
    _resetForTesting()
  })

  test("#given empty agent #when executing #then returns validation error", async () => {
    // given
    const client = {
      app: {
        agents: async () => ({ data: [{ name: "sisyphus" }] }),
      },
    } as unknown as Parameters<typeof createSwitchAgentTool>[0]
    const tool = createSwitchAgentTool(client)

    // when
    const output = await tool.execute({ agent: "   " }, { sessionID: "ses-1" } as never)

    // then
    expect(output).toContain("agent is required")
  })

  test("#given unknown agent #when executing #then returns invalid switch error", async () => {
    // given
    const client = {
      app: {
        agents: async () => ({ data: [{ name: "sisyphus" }, { name: "explore" }] }),
      },
    } as unknown as Parameters<typeof createSwitchAgentTool>[0]
    const tool = createSwitchAgentTool(client)

    // when
    const output = await tool.execute({ agent: "ghost" }, { sessionID: "ses-1" } as never)

    // then
    expect(output).toContain("unknown agent")
    expect(getPendingSessionAgentSwitch("ses-1")).toBeUndefined()
  })

  test("#given known but disabled agent #when executing #then returns disabled error", async () => {
    // given
    const client = {
      app: {
        agents: async () => ({ data: [{ name: "explore" }] }),
      },
    } as unknown as Parameters<typeof createSwitchAgentTool>[0]
    const tool = createSwitchAgentTool(client, ["explore"])

    // when
    const output = await tool.execute({ agent: "explore" }, { sessionID: "ses-1" } as never)

    // then
    expect(output).toContain("disabled")
    expect(getPendingSessionAgentSwitch("ses-1")).toBeUndefined()
  })

  test("#given known enabled agent #when executing #then queues pending switch", async () => {
    // given
    const client = {
      app: {
        agents: async () => ({ data: [{ name: "explore" }, { name: "Athena" }] }),
      },
    } as unknown as Parameters<typeof createSwitchAgentTool>[0]
    const tool = createSwitchAgentTool(client)

    // when
    const output = await tool.execute({ agent: "explore" }, { sessionID: "ses-1" } as never)

    // then
    expect(output).toContain("Agent switch queued")
    expect(getPendingSessionAgentSwitch("ses-1")?.agent).toBe("explore")
  })
})
