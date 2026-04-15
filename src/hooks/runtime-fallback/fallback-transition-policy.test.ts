import { describe, expect, it } from "bun:test"

import { getRuntimeFallbackTransitionMode } from "./fallback-transition-policy"

describe("runtime fallback transition policy", () => {
  it("uses scoped handoff when a paid planner session falls back to spark", () => {
    expect(getRuntimeFallbackTransitionMode({
      resolvedAgent: "Prometheus (Plan Builder)",
      currentModel: "anthropic/claude-opus-4-6",
      newModel: "openai/gpt-5.3-codex-spark",
    })).toBe("scoped_handoff")
  })

  it("uses scoped handoff when a paid execution session falls back to a free model", () => {
    expect(getRuntimeFallbackTransitionMode({
      resolvedAgent: "Hephaestus (Deep Worker)",
      currentModel: "openai/gpt-5.4",
      newModel: "opencode/big-pickle",
    })).toBe("scoped_handoff")
  })

  it("keeps paid-to-paid fallback in the same session", () => {
    expect(getRuntimeFallbackTransitionMode({
      resolvedAgent: "Prometheus (Plan Builder)",
      currentModel: "anthropic/claude-opus-4-6",
      newModel: "openai/gpt-5.4",
    })).toBe("same_session")
  })

  it("keeps explore on the narrow same-session lane", () => {
    expect(getRuntimeFallbackTransitionMode({
      resolvedAgent: "Explore (Code Search)",
      currentModel: "openai/gpt-5.3-codex-spark",
      newModel: "opencode/nemotron-3-super-free",
    })).toBe("same_session")
  })
})
