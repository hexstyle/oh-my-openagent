import { describe, expect, it } from "bun:test"

import { createFallbackState } from "./fallback-state"
import {
  getRecoveryProbeCandidates,
  getRuntimeFallbackAction,
  getRuntimeFallbackTier,
  selectFallbackModelsForAction,
} from "./fallback-policy"

describe("runtime fallback policy", () => {
  it("retries the same model for network and unknown errors before falling back", () => {
    expect(
      getRuntimeFallbackAction(
        { message: "socket hang up while calling provider" },
        [402, 429, 500, 502, 503, 504],
      ),
    ).toBe("retry_same_model")

    expect(
      getRuntimeFallbackAction(
        { name: "UnknownError", message: "provider returned an unexpected failure" },
        [402, 429, 500, 502, 503, 504],
      ),
    ).toBe("retry_same_model")
  })

  it("routes quota and cooldown failures to spark then free models", () => {
    expect(
      getRuntimeFallbackAction(
        { message: "Subscription quota exceeded. You can continue using free models." },
        [402, 429, 500, 502, 503, 504],
      ),
    ).toBe("limit_fallback")

    expect(
      selectFallbackModelsForAction({
        currentModel: "anthropic/claude-opus-4-6",
        fallbackModels: [
          "openai/gpt-5.4",
          "openai/gpt-5.3-codex-spark",
          "opencode/nemotron-3-super-free",
          "opencode/mimo-v2-pro-free",
        ],
        action: "limit_fallback",
      }),
    ).toEqual([
      "openai/gpt-5.3-codex-spark",
      "opencode/nemotron-3-super-free",
      "opencode/mimo-v2-pro-free",
    ])
  })

  it("keeps free-tier failures inside the free-tier chain until recovery probes restore a stronger model", () => {
    expect(
      selectFallbackModelsForAction({
        currentModel: "opencode/nemotron-3-super-free",
        fallbackModels: [
          "openai/gpt-5.3-codex-spark",
          "opencode/nemotron-3-super-free",
          "opencode/mimo-v2-pro-free",
        ],
        action: "limit_fallback",
      }),
    ).toEqual(["opencode/mimo-v2-pro-free"])
  })

  it("probes only higher-priority non-free models when the session is running on spark or free", () => {
    const state = createFallbackState("anthropic/claude-opus-4-6", [
      "openai/gpt-5.3-codex-spark",
      "opencode/nemotron-3-super-free",
    ])

    state.currentModel = "opencode/nemotron-3-super-free"
    state.fallbackIndex = 1

    expect(getRecoveryProbeCandidates(state)).toEqual([
      "anthropic/claude-opus-4-6",
      "openai/gpt-5.3-codex-spark",
    ])
    expect(getRuntimeFallbackTier("openai/gpt-5.3-codex-spark")).toBe("spark")
    expect(getRuntimeFallbackTier("opencode/mimo-v2-pro-free")).toBe("free")
    expect(getRuntimeFallbackTier("openai/gpt-5.4")).toBe("paid")
  })
})
