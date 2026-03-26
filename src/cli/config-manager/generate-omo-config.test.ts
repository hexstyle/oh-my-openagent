import { describe, expect, it } from "bun:test"
import type { InstallConfig } from "../types"
import {
  createAthenaCouncilMembersFromTemplates,
  generateAthenaConfig,
  type AthenaMemberTemplate,
} from "./generate-athena-config"
import { generateOmoConfig } from "./generate-omo-config"
import { transformModelForProvider } from "../../shared/provider-model-id-transform"

function createInstallConfig(overrides: Partial<InstallConfig> = {}): InstallConfig {
  return {
    hasClaude: false,
    isMax20: false,
    hasOpenAI: false,
    hasGemini: false,
    hasCopilot: false,
    hasOpencodeZen: false,
    hasZaiCodingPlan: false,
    hasKimiForCoding: false,
    hasOpencodeGo: false,
    ...overrides,
  }
}

describe("generateOmoConfig athena council", () => {
  it("creates athena council members from enabled providers", () => {
    // given
    const installConfig = createInstallConfig({ hasOpenAI: true, hasClaude: true, hasGemini: true })

    // when
    const generated = generateOmoConfig(installConfig)
    const athena = generated.athena as { model?: string; members?: Array<{ name: string; model: string }> }
    const googleModel = `google/${transformModelForProvider("google", "gemini-3.1-pro")}`

    // then
    expect(athena.model).toBe("openai/gpt-5.4")
    expect(athena.members).toHaveLength(3)
    expect(athena.members?.map((member) => member.model)).toEqual([
      "openai/gpt-5.4",
      "anthropic/claude-sonnet-4-6",
      googleModel,
    ])
  })

  it("does not create athena config when no providers are enabled", () => {
    // given
    const installConfig = createInstallConfig()

    // when
    const generated = generateOmoConfig(installConfig)

    // then
    expect(generated.athena).toBeUndefined()
  })
})

describe("generateAthenaConfig", () => {
  it("uses anthropic as coordinator when openai is unavailable", () => {
    // given
    const installConfig = createInstallConfig({ hasClaude: true, hasCopilot: true })

    // when
    const athena = generateAthenaConfig(installConfig)

    // then
    expect(athena?.model).toBe("anthropic/claude-sonnet-4-6")
    expect(athena?.members?.map((member) => member.model)).toEqual([
      "anthropic/claude-sonnet-4-6",
      "github-copilot/gpt-5.4",
    ])
  })
})

describe("createAthenaCouncilMembersFromTemplates", () => {
  it("adds numeric suffixes when template names collide case-insensitively", () => {
    // given
    const templates: AthenaMemberTemplate[] = [
      {
        provider: "openai",
        model: "gpt-5.4",
        name: "Strategist",
        isAvailable: () => true,
      },
      {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        name: "strategist",
        isAvailable: () => true,
      },
    ]

    // when
    const members = createAthenaCouncilMembersFromTemplates(templates)

    // then
    expect(members).toEqual([
      { name: "Strategist", model: "openai/gpt-5.4" },
      { name: "strategist 2", model: "anthropic/claude-sonnet-4-6" },
    ])
  })
})
