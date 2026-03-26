import type { AthenaConfig } from "../config"
import { createCouncilMemberAgent } from "../agents/council-member"
import { buildAthenaPrompt } from "../agents/athena/prompt"
import { toCouncilMemberAgentName } from "../agents/athena/council-members"

export function applyAthenaCouncilAgentWiring(
  agentConfig: Record<string, unknown>,
  athenaConfig?: AthenaConfig,
): void {
  const members = athenaConfig?.members ?? []
  const athena = agentConfig.athena as Record<string, unknown> | undefined

  if (athenaConfig?.model) {
    if (athena) {
      athena.model = athenaConfig.model
    }
  }

  if (!athena) {
    return
  }

  if (members.length > 0) {
    athena.prompt = buildAthenaPrompt({
      members: members.map((member) => ({ name: member.name, model: member.model })),
    })
  }

  for (const member of members) {
    const dynamicAgentName = toCouncilMemberAgentName(member.name)
    if (agentConfig[dynamicAgentName]) {
      continue
    }

    const memberAgent = createCouncilMemberAgent(member.model)
    agentConfig[dynamicAgentName] = {
      ...memberAgent,
      description: `Athena council member (${member.name}) using ${member.model}.`,
      hidden: true,
    }
  }
}
