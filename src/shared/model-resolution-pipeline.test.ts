import { describe, expect, test } from "bun:test"
import { resolveModelPipeline } from "./model-resolution-pipeline"

describe("resolveModelPipeline", () => {
  test("does not return unused explicit user config metadata in override result", () => {
    // given
    const result = resolveModelPipeline({
      intent: {
        userModel: "openai/gpt-5.3-codex",
      },
      constraints: {
        availableModels: new Set<string>(),
      },
    })

    // when
    const hasExplicitUserConfigField = result
      ? Object.prototype.hasOwnProperty.call(result, "explicitUserConfig")
      : false

    // then
    expect(result).toEqual({ model: "openai/gpt-5.3-codex", provenance: "override" })
    expect(hasExplicitUserConfigField).toBe(false)
  })

  test("defaults GPT-5.4 UI selection to xhigh variant", () => {
    const result = resolveModelPipeline({
      intent: {
        uiSelectedModel: "openai/gpt-5.4",
      },
      constraints: {
        availableModels: new Set<string>(),
      },
    })

    expect(result).toEqual({
      model: "openai/gpt-5.4",
      provenance: "override",
      variant: "xhigh",
    })
  })

  test("defaults GPT-5.4 user override to xhigh variant", () => {
    const result = resolveModelPipeline({
      intent: {
        userModel: "github-copilot/gpt-5.4",
      },
      constraints: {
        availableModels: new Set<string>(),
      },
    })

    expect(result).toEqual({
      model: "github-copilot/gpt-5.4",
      provenance: "override",
      variant: "xhigh",
    })
  })

  test("defaults Claude Opus selection to max variant", () => {
    const result = resolveModelPipeline({
      intent: {
        uiSelectedModel: "anthropic/claude-opus-4-6",
      },
      constraints: {
        availableModels: new Set<string>(),
      },
    })

    expect(result).toEqual({
      model: "anthropic/claude-opus-4-6",
      provenance: "override",
      variant: "max",
    })
  })

  test("infers variant from fallback chain for non-mapped models", () => {
    const result = resolveModelPipeline({
      intent: {
        userModel: "anthropic/claude-sonnet-4-6",
      },
      constraints: {
        availableModels: new Set<string>(),
      },
      policy: {
        fallbackChain: [
          {
            providers: ["anthropic"],
            model: "claude-sonnet-4-6",
            variant: "high",
          },
        ],
      },
    })

    expect(result).toEqual({
      model: "anthropic/claude-sonnet-4-6",
      provenance: "override",
      variant: "high",
    })
  })
})
