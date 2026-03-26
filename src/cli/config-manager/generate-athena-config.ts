import { transformModelForProvider } from "../../shared/provider-model-id-transform"
import { toProviderAvailability } from "../provider-availability"
import type { InstallConfig } from "../types"

export interface AthenaMemberTemplate {
  provider: string
  model: string
  name: string
  isAvailable: (config: InstallConfig) => boolean
}

export interface AthenaCouncilMember {
  name: string
  model: string
}

export interface AthenaConfig {
  model?: string
  members: AthenaCouncilMember[]
}

const ATHENA_MEMBER_TEMPLATES: AthenaMemberTemplate[] = [
  {
    provider: "openai",
    model: "gpt-5.4",
    name: "OpenAI Strategist",
    isAvailable: (config) => config.hasOpenAI,
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    name: "Claude Strategist",
    isAvailable: (config) => config.hasClaude,
  },
  {
    provider: "google",
    model: "gemini-3.1-pro",
    name: "Gemini Strategist",
    isAvailable: (config) => config.hasGemini,
  },
  {
    provider: "github-copilot",
    model: "gpt-5.4",
    name: "Copilot Strategist",
    isAvailable: (config) => config.hasCopilot,
  },
  {
    provider: "opencode",
    model: "gpt-5.4",
    name: "OpenCode Strategist",
    isAvailable: (config) => config.hasOpencodeZen,
  },
  {
    provider: "zai-coding-plan",
    model: "glm-4.7",
    name: "Z.ai Strategist",
    isAvailable: (config) => config.hasZaiCodingPlan,
  },
  {
    provider: "kimi-for-coding",
    model: "k2p5",
    name: "Kimi Strategist",
    isAvailable: (config) => config.hasKimiForCoding,
  },
  {
    provider: "opencode-go",
    model: "glm-5",
    name: "OpenCode Go Strategist",
    isAvailable: (config) => config.hasOpencodeGo,
  },
]

function toProviderModel(provider: string, model: string): string {
  const transformedModel = transformModelForProvider(provider, model)
  return `${provider}/${transformedModel}`
}

function createUniqueMemberName(baseName: string, usedNames: Set<string>): string {
  if (!usedNames.has(baseName.toLowerCase())) {
    usedNames.add(baseName.toLowerCase())
    return baseName
  }

  let suffix = 2
  let candidate = `${baseName} ${suffix}`
  while (usedNames.has(candidate.toLowerCase())) {
    suffix += 1
    candidate = `${baseName} ${suffix}`
  }

  usedNames.add(candidate.toLowerCase())
  return candidate
}

export function createAthenaCouncilMembersFromTemplates(
  templates: AthenaMemberTemplate[]
): AthenaCouncilMember[] {
  const members: AthenaCouncilMember[] = []
  const usedNames = new Set<string>()

  for (const template of templates) {
    members.push({
      name: createUniqueMemberName(template.name, usedNames),
      model: toProviderModel(template.provider, template.model),
    })
  }

  return members
}

export function generateAthenaConfig(config: InstallConfig): AthenaConfig | undefined {
  const selectedTemplates = ATHENA_MEMBER_TEMPLATES.filter((template) => template.isAvailable(config))
  if (selectedTemplates.length === 0) {
    return undefined
  }

  const members = createAthenaCouncilMembersFromTemplates(selectedTemplates)
  const availability = toProviderAvailability(config)

  const preferredCoordinator =
    (availability.native.openai && members.find((member) => member.model.startsWith("openai/"))) ||
    (availability.native.claude && members.find((member) => member.model.startsWith("anthropic/"))) ||
    members[0]

  return {
    model: preferredCoordinator.model,
    members,
  }
}
