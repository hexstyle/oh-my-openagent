import { describe, expect, test } from "bun:test"
import { applyAthenaCouncilAgentWiring } from "./athena-council-agent-wiring"

describe("applyAthenaCouncilAgentWiring", () => {
  test("#given athena config with roster #when wiring agents #then injects dynamic council member agents", () => {
    // given
    const agentConfig: Record<string, unknown> = {
      athena: {
        model: "openai/gpt-5.4",
        prompt: "placeholder",
      },
    }

    // when
    applyAthenaCouncilAgentWiring(agentConfig, {
      model: "anthropic/claude-opus-4-6",
      members: [
        { name: "Architect", model: "openai/gpt-5.4" },
        { name: "Skeptic", model: "anthropic/claude-sonnet-4-6" },
      ],
    })

    // then
    const athena = agentConfig.athena as Record<string, unknown>
    expect(athena.model).toBe("anthropic/claude-opus-4-6")
    expect(typeof athena.prompt).toBe("string")
    expect((athena.prompt as string).includes("council-member-architect")).toBe(true)

    const architect = agentConfig["council-member-architect"] as Record<string, unknown>
    const skeptic = agentConfig["council-member-skeptic"] as Record<string, unknown>
    expect(architect).toBeDefined()
    expect(skeptic).toBeDefined()
    expect(architect.model).toBe("openai/gpt-5.4")
    expect(skeptic.model).toBe("anthropic/claude-sonnet-4-6")
  })
})
