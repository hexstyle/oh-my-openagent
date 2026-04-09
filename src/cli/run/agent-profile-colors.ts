import type { OpencodeClient } from "@opencode-ai/sdk"
import { normalizeSDKResponse } from "../../shared"
import { getAgentConfigKey, getAgentDisplayName } from "../../shared/agent-display-names"

interface AgentProfile {
  name?: string
  color?: string
}

export async function loadAgentProfileColors(
  client: OpencodeClient,
): Promise<Record<string, string>> {
  try {
    const agentsRes = await client.app.agents()
    const agents = normalizeSDKResponse(agentsRes, [] as AgentProfile[], {
      preferResponseOnMissingData: true,
    })

    const colors: Record<string, string> = {}
    for (const agent of agents) {
      if (!agent.name || !agent.color) continue
      const displayName = getAgentDisplayName(getAgentConfigKey(agent.name))
      colors[displayName] = agent.color
    }

    return colors
  } catch {
    return {}
  }
}
