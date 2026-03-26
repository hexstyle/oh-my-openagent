import { tool, type PluginInput, type ToolDefinition } from "@opencode-ai/plugin"
import { setPendingSessionAgentSwitch } from "../../features/claude-code-session-state"
import { normalizeSDKResponse } from "../../shared"
import type { SwitchAgentArgs } from "./types"
import { SWITCH_AGENT_DESCRIPTION } from "./constants"

type SwitchableAgent = {
  name: string
  mode?: "subagent" | "primary" | "all"
}

export function createSwitchAgentTool(client: PluginInput["client"], disabledAgents: string[] = []): ToolDefinition {
  return tool({
    description: SWITCH_AGENT_DESCRIPTION,
    args: {
      agent: tool.schema.string().describe("Agent name to switch to"),
      session_id: tool.schema.string().optional().describe("Session ID to switch. Defaults to current session"),
    },
    async execute(args: SwitchAgentArgs, toolContext) {
      const targetSessionID = args.session_id ?? toolContext.sessionID
      const requestedAgent = args.agent?.trim()

      if (!requestedAgent) {
        return "Error: agent is required."
      }

      try {
        const agentsResponse = await client.app.agents()
        const agents = normalizeSDKResponse(agentsResponse, [] as SwitchableAgent[], {
          preferResponseOnMissingData: true,
        })
        const matchedAgent = agents.find((agent) => agent.name.toLowerCase() === requestedAgent.toLowerCase())

        if (!matchedAgent) {
          const availableAgents = agents.map((agent) => agent.name).sort()
          return `Error: unknown agent \"${requestedAgent}\". Available agents: ${availableAgents.join(", ")}`
        }

        if (disabledAgents.some((disabledAgent) => disabledAgent.toLowerCase() === matchedAgent.name.toLowerCase())) {
          return `Error: agent \"${matchedAgent.name}\" is disabled via disabled_agents configuration.`
        }

        const pendingSwitch = setPendingSessionAgentSwitch(targetSessionID, matchedAgent.name)

        return [
          "Agent switch queued.",
          `Session ID: ${targetSessionID}`,
          `Next agent: ${pendingSwitch.agent}`,
          `Requested at: ${pendingSwitch.requestedAt.toISOString()}`,
          "The switch will be applied by hook flow on the next chat.message turn.",
        ].join("\n")
      } catch (error) {
        return `Error: failed to queue agent switch: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
}
