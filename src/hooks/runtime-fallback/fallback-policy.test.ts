import { describe, expect, it } from "bun:test"

import { createFallbackState } from "./fallback-state"
import {
  getRecoveryProbeCandidates,
  getRuntimeFallbackAction,
  getRuntimeFallbackTier,
  selectFallbackModelsForAction,
} from "./fallback-policy"

describe("runtime fallback policy", () => {
  it("retries the same model immediately for explicit network faults before falling back", () => {
    expect(
      getRuntimeFallbackAction(
        { message: "socket hang up while calling provider" },
        [402, 429, 500, 502, 503, 504],
      ),
    ).toBe("retry_same_model")
  })

  it("routes agent-not-found errors directly to fallback_chain without same-model retry", () => {
    // Standard form with UnknownError name
    expect(
      getRuntimeFallbackAction(
        { name: "UnknownError", message: 'Agent not found: "Explore (Code Search)"' },
        [402, 429, 500, 502, 503, 504],
      ),
    ).toBe("fallback_chain")

    // Lowercase variant
    expect(
      getRuntimeFallbackAction(
        { name: "UnknownError", message: "agent not found: explore" },
        [402, 429, 500, 502, 503, 504],
      ),
    ).toBe("fallback_chain")

    // Plain object without name field — must still route to fallback_chain, not loop on same model
    expect(
      getRuntimeFallbackAction(
        { message: 'Agent not found: "Explore (Code Search)". Available agents: Explore (Code Search), ...' },
        [402, 429, 500, 502, 503, 504],
      ),
    ).toBe("fallback_chain")

    // Raw string error (e.g. from opencode task layer)
    expect(
      getRuntimeFallbackAction(
        '[ERROR] - Agent not found: "Explore (Code Search)". Available agents: Explore (Code Search)',
        [402, 429, 500, 502, 503, 504],
      ),
    ).toBe("fallback_chain")
  })

  it("backs off delayed same-model retries for opaque UnknownError failures", () => {
    expect(
      getRuntimeFallbackAction(
        { name: "UnknownError", message: "provider returned an unexpected failure" },
        [402, 429, 500, 502, 503, 504],
      ),
    ).toBe("retry_same_model_delayed")

    expect(
      getRuntimeFallbackAction(
        { name: "UnknownError" },
        [402, 429, 500, 502, 503, 504],
      ),
    ).toBe("retry_same_model_delayed")
  })

  it("treats transient 403 forbidden/request-not-allowed errors as delayed same-model retries", () => {
    expect(
      getRuntimeFallbackAction(
        { statusCode: 403, message: "Request not allowed" },
        [402, 429, 500, 502, 503, 504],
      ),
    ).toBe("retry_same_model_delayed")

    expect(
      getRuntimeFallbackAction(
        { message: "403 Forbidden" },
        [402, 429, 500, 502, 503, 504],
      ),
    ).toBe("retry_same_model_delayed")
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
          "opencode/big-pickle",
        ],
        action: "limit_fallback",
      }),
    ).toEqual([
      "openai/gpt-5.3-codex-spark",
      "opencode/nemotron-3-super-free",
      "opencode/big-pickle",
    ])
  })

  it("keeps free-tier failures inside the free-tier chain until recovery probes restore a stronger model", () => {
    expect(
      selectFallbackModelsForAction({
        currentModel: "opencode/nemotron-3-super-free",
        fallbackModels: [
          "openai/gpt-5.3-codex-spark",
          "opencode/nemotron-3-super-free",
          "opencode/big-pickle",
        ],
        action: "limit_fallback",
      }),
    ).toEqual(["opencode/big-pickle"])
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
    expect(getRuntimeFallbackTier("opencode/big-pickle")).toBe("free")
    expect(getRuntimeFallbackTier("openai/gpt-5.4")).toBe("paid")
  })
})
