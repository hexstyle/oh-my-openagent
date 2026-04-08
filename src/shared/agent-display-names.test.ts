import { describe, it, expect } from "bun:test"
import {
  AGENT_DISPLAY_NAMES,
  getAgentDisplayName,
  getAgentConfigKey,
  isPrimaryRuntimeAgent,
  normalizeAgentForExecution,
  normalizeAgentForPrompt,
  normalizeAgentForSessionPrompt,
} from "./agent-display-names"

describe("getAgentDisplayName", () => {
  it("returns display name for lowercase config key (new format)", () => {
    // given config key "sisyphus"
    const configKey = "sisyphus"

    // when getAgentDisplayName called
    const result = getAgentDisplayName(configKey)

    // then returns "Sisyphus (Ultraworker)"
    expect(result).toBe("Sisyphus (Ultraworker)")
  })

  it("returns display name for uppercase config key (old format - case-insensitive)", () => {
    // given config key "Sisyphus" (old format)
    const configKey = "Sisyphus"

    // when getAgentDisplayName called
    const result = getAgentDisplayName(configKey)

    // then returns "Sisyphus (Ultraworker)" (case-insensitive lookup)
    expect(result).toBe("Sisyphus (Ultraworker)")
  })

  it("returns original key for unknown agents (fallback)", () => {
    // given config key "custom-agent"
    const configKey = "custom-agent"

    // when getAgentDisplayName called
    const result = getAgentDisplayName(configKey)

    // then returns "custom-agent" (original key unchanged)
    expect(result).toBe("custom-agent")
  })

  it("returns display name for atlas", () => {
    // given config key "atlas"
    const configKey = "atlas"

    // when getAgentDisplayName called
    const result = getAgentDisplayName(configKey)

     // then returns "Atlas (Plan Executor)"
    expect(result).toBe("Atlas (Plan Executor)")
  })

  it("returns display name for prometheus", () => {
    // given config key "prometheus"
    const configKey = "prometheus"

    // when getAgentDisplayName called
    const result = getAgentDisplayName(configKey)

    // then returns "Prometheus (Plan Builder)"
    expect(result).toBe("Prometheus (Plan Builder)")
  })

  it("returns display name for sisyphus-junior", () => {
    // given config key "sisyphus-junior"
    const configKey = "sisyphus-junior"

    // when getAgentDisplayName called
    const result = getAgentDisplayName(configKey)

    // then returns canonical display name
    expect(result).toBe("Sisyphus Junior (Focused Executor)")
  })

  it("returns display name for metis", () => {
    // given config key "metis"
    const configKey = "metis"

    // when getAgentDisplayName called
    const result = getAgentDisplayName(configKey)

    // then returns "Metis (Plan Consultant)"
    expect(result).toBe("Metis (Plan Consultant)")
  })

  it("returns display name for momus", () => {
    // given config key "momus"
    const configKey = "momus"

    // when getAgentDisplayName called
    const result = getAgentDisplayName(configKey)

     // then returns "Momus (Plan Critic)"
    expect(result).toBe("Momus (Plan Critic)")
  })

  it("returns display name for oracle", () => {
    // given config key "oracle"
    const configKey = "oracle"

    // when getAgentDisplayName called
    const result = getAgentDisplayName(configKey)

    // then returns canonical display name
    expect(result).toBe("Oracle (Strategic Advisor)")
  })

  it("returns display name for librarian", () => {
    // given config key "librarian"
    const configKey = "librarian"

    // when getAgentDisplayName called
    const result = getAgentDisplayName(configKey)

    // then returns canonical display name
    expect(result).toBe("Librarian (OSS Research)")
  })

  it("returns display name for explore", () => {
    // given config key "explore"
    const configKey = "explore"

    // when getAgentDisplayName called
    const result = getAgentDisplayName(configKey)

    // then returns canonical display name
    expect(result).toBe("Explore (Code Search)")
  })

  it("returns display name for multimodal-looker", () => {
    // given config key "multimodal-looker"
    const configKey = "multimodal-looker"

    // when getAgentDisplayName called
    const result = getAgentDisplayName(configKey)

    // then returns canonical display name
    expect(result).toBe("Multimodal Looker (Document Vision)")
  })
})

describe("getAgentConfigKey", () => {
  it("resolves display name to config key", () => {
    // given display name "Sisyphus (Ultraworker)"
    // when getAgentConfigKey called
    // then returns "sisyphus"
    expect(getAgentConfigKey("Sisyphus (Ultraworker)")).toBe("sisyphus")
  })

  it("resolves display name case-insensitively", () => {
    // given display name in different case
    // when getAgentConfigKey called
    // then returns "atlas"
    expect(getAgentConfigKey("atlas (plan executor)")).toBe("atlas")
  })

  it("passes through lowercase config keys unchanged", () => {
    // given lowercase config key "prometheus"
    // when getAgentConfigKey called
    // then returns "prometheus"
    expect(getAgentConfigKey("prometheus")).toBe("prometheus")
  })

  it("returns lowercased unknown agents", () => {
    // given unknown agent name
    // when getAgentConfigKey called
    // then returns lowercased
    expect(getAgentConfigKey("Custom-Agent")).toBe("custom-agent")
  })

  it("resolves all core agent display names", () => {
    // given all core display names
    // when/then each resolves to its config key
    expect(getAgentConfigKey("Hephaestus (Deep Agent)")).toBe("hephaestus")
    expect(getAgentConfigKey("Prometheus (Plan Builder)")).toBe("prometheus")
    expect(getAgentConfigKey("Atlas (Plan Executor)")).toBe("atlas")
    expect(getAgentConfigKey("Metis (Plan Consultant)")).toBe("metis")
    expect(getAgentConfigKey("Momus (Plan Critic)")).toBe("momus")
    expect(getAgentConfigKey("Sisyphus Junior (Focused Executor)")).toBe("sisyphus-junior")
    expect(getAgentConfigKey("Oracle (Strategic Advisor)")).toBe("oracle")
    expect(getAgentConfigKey("Librarian (OSS Research)")).toBe("librarian")
    expect(getAgentConfigKey("Explore (Code Search)")).toBe("explore")
    expect(getAgentConfigKey("Multimodal Looker (Document Vision)")).toBe("multimodal-looker")
  })

  it("resolves legacy plain-name aliases through the migration table", () => {
    expect(getAgentConfigKey("Sisyphus")).toBe("sisyphus")
    expect(getAgentConfigKey("Prometheus")).toBe("prometheus")
    expect(getAgentConfigKey("Sisyphus Junior")).toBe("sisyphus-junior")
    expect(getAgentConfigKey("Oracle")).toBe("oracle")
  })
})

describe("AGENT_DISPLAY_NAMES", () => {
  it("contains all expected agent mappings", () => {
    // given expected mappings
    const expectedMappings = {
      sisyphus: "Sisyphus (Ultraworker)",
      hephaestus: "Hephaestus (Deep Agent)",
      prometheus: "Prometheus (Plan Builder)",
      atlas: "Atlas (Plan Executor)",
      "sisyphus-junior": "Sisyphus Junior (Focused Executor)",
      metis: "Metis (Plan Consultant)",
      momus: "Momus (Plan Critic)",
      athena: "Athena (Council)",
      "athena-junior": "Athena Junior (Council)",
      oracle: "Oracle (Strategic Advisor)",
      librarian: "Librarian (OSS Research)",
      explore: "Explore (Code Search)",
      "multimodal-looker": "Multimodal Looker (Document Vision)",
      "council-member": "Council Member (Advisor)",
    }

    // when checking the constant
    // then contains all expected mappings
    expect(AGENT_DISPLAY_NAMES).toEqual(expectedMappings)
  })
})

describe("normalizeAgentForPrompt", () => {
  it("keeps builtin agents on their canonical display names", () => {
    expect(normalizeAgentForPrompt("oracle")).toBe("Oracle (Strategic Advisor)")
  })
})

describe("normalizeAgentForExecution", () => {
  it("preserves the explore runtime key when given the canonical display name", () => {
    expect(normalizeAgentForExecution("Explore (Code Search)")).toBe("explore")
  })

  it("leaves non-reserved agent names unchanged", () => {
    expect(normalizeAgentForExecution("oracle")).toBe("oracle")
  })
})

describe("normalizeAgentForSessionPrompt", () => {
  it("normalizes non-reserved agents to canonical display names", () => {
    expect(normalizeAgentForSessionPrompt("atlas")).toBe("Atlas (Plan Executor)")
  })

  it("preserves the explore runtime key for session prompt payloads", () => {
    expect(normalizeAgentForSessionPrompt("Explore (Code Search)")).toBe("explore")
  })
})

describe("isPrimaryRuntimeAgent", () => {
  it("returns true for primary runtime agents", () => {
    expect(isPrimaryRuntimeAgent("Prometheus (Plan Builder)")).toBe(true)
    expect(isPrimaryRuntimeAgent("atlas")).toBe(true)
  })

  it("returns false for subagents and unknown names", () => {
    expect(isPrimaryRuntimeAgent("Explore (Code Search)")).toBe(false)
    expect(isPrimaryRuntimeAgent("librarian")).toBe(false)
    expect(isPrimaryRuntimeAgent("custom-agent")).toBe(false)
  })
})
