import { describe, expect, it } from "bun:test"

import { createFallbackState } from "./fallback-state"
import {
  getSameModelRetryAttemptLimit,
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

  it("treats request-not-allowed 403 errors as bounded delayed same-model retries", () => {
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

    expect(
      getRuntimeFallbackAction(
        {
          message: "Tool execution aborted",
          cause: {
            statusCode: 403,
            message: "Request not allowed",
          },
        },
        [402, 429, 500, 502, 503, 504],
      ),
    ).toBe("retry_same_model_delayed")

    expect(
      getRuntimeFallbackAction(
        {
          statusCode: 403,
          message: "Forbidden",
          responseBody: JSON.stringify({
            error: {
              type: "forbidden",
              message: "Request not allowed",
            },
          }),
        },
        [402, 429, 500, 502, 503, 504],
      ),
    ).toBe("retry_same_model_delayed")

    expect(
      getRuntimeFallbackAction(
        {
          message: "Error running remote compact task: unexpected status 403 Forbidden",
        },
        [402, 429, 500, 502, 503, 504],
      ),
    ).toBe("retry_same_model_delayed")

    expect(
      getSameModelRetryAttemptLimit(
        { statusCode: 403, message: "Request not allowed" },
        "retry_same_model_delayed",
      ),
    ).toBe(3)
  })

  it("treats gateway/proxy-blocked 403 forbidden errors as bounded delayed same-model retries", () => {
    expect(
      getRuntimeFallbackAction(
        {
          name: "AI_APICallError",
          statusCode: 403,
          message: "Forbidden: request was blocked by a gateway or proxy. You may not have permission to access this resource.",
        },
        [402, 429, 500, 502, 503, 504],
      ),
    ).toBe("retry_same_model_delayed")

    expect(
      getRuntimeFallbackAction(
        {
          name: "APIError",
          data: {
            statusCode: 403,
            message:
              "Forbidden: request was blocked by a gateway or proxy. You may not have permission to access this resource.",
            responseBody:
              "<html><body><p>Unable to load site</p><span>Please try again later.</span></body></html>",
          },
        },
        [402, 429, 500, 502, 503, 504],
      ),
    ).toBe("retry_same_model_delayed")
  })

  it("keeps Cloudflare-style OpenAI 403 challenge pages on the same model", () => {
    expect(
      getRuntimeFallbackAction(
        {
          name: "AI_APICallError",
          statusCode: 403,
          url: "https://api.openai.com/v1/responses",
          message: "Forbidden",
          responseHeaders: {
            server: "cloudflare",
            "cf-ray": "abc123",
          },
          responseBody:
            "<html><body><p>Unable to load site</p><span>Please try again later.</span><span>[IP:109.252.37.138 | Ray ID:9ed686783eb4f131]</span></body></html>",
        },
        [402, 429, 500, 502, 503, 504],
      ),
    ).toBe("retry_same_model_delayed")
  })

  it("treats embedded forbidden request-not-allowed wrapper messages as bounded delayed same-model retries", () => {
    expect(
      getRuntimeFallbackAction(
        {
          message: 'Forbidden: {"error":{"type":"forbidden","message":"Request not allowed"}}',
        },
        [402, 429, 500, 502, 503, 504],
      ),
    ).toBe("retry_same_model_delayed")
  })

  it("treats plain local tool execution aborts as persistent delayed same-model retries", () => {
    expect(
      getRuntimeFallbackAction(
        {
          message: "Tool execution aborted",
        },
        [402, 429, 500, 502, 503, 504],
      ),
    ).toBe("retry_same_model_delayed_persistent")
  })

  it("treats wrapped and remote compact 500 internal-server errors as immediate same-model retries", () => {
    expect(
      getRuntimeFallbackAction(
        {
          message: "Tool execution aborted",
          cause: {
            statusCode: 500,
            message: "Internal server error",
          },
        },
        [402, 429, 500, 502, 503, 504],
      ),
    ).toBe("retry_same_model")

    expect(
      getRuntimeFallbackAction(
        {
          message: "Error running remote compact task: unexpected status 500 Internal Server Error",
        },
        [402, 429, 500, 502, 503, 504],
      ),
    ).toBe("retry_same_model")

    expect(
      getRuntimeFallbackAction(
        {
          message: 'Internal Server Error: {"error":{"type":"api_error","message":"Internal server error"}}',
        },
        [402, 429, 500, 502, 503, 504],
      ),
    ).toBe("retry_same_model")
  })

  it("routes quota and cooldown failures through every remaining paid model before free", () => {
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
          "anthropic/claude-sonnet-4-6",
          "openai/gpt-5.3-codex-spark",
          "opencode/nemotron-3-super-free",
          "opencode/big-pickle",
        ],
        action: "limit_fallback",
      }),
    ).toEqual([
      "openai/gpt-5.4",
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5.3-codex-spark",
      "opencode/nemotron-3-super-free",
      "opencode/big-pickle",
    ])
  })

  it("keeps spark-primary chains on remaining paid models before descending to free", () => {
    expect(
      selectFallbackModelsForAction({
        currentModel: "openai/gpt-5.3-codex-spark",
        fallbackModels: [
          "openai/gpt-5.3-codex-spark",
          "openai/gpt-5.4",
          "anthropic/claude-sonnet-4-6",
          "opencode/nemotron-3-super-free",
          "opencode/big-pickle",
        ],
        action: "limit_fallback",
      }),
    ).toEqual([
      "openai/gpt-5.4",
      "anthropic/claude-sonnet-4-6",
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
