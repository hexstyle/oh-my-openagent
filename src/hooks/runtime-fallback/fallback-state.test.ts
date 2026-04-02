import { describe, expect, it } from "bun:test"

import {
  createFallbackState,
  markFallbackResponseSuccess,
  prepareFallback,
  recoverPreferredModel,
} from "./fallback-state"

describe("runtime fallback state recovery", () => {
  it("stores fallback chain when preparing fallback", () => {
    const state = createFallbackState("anthropic/claude-opus-4-6")

    prepareFallback(
      "session-store-chain",
      state,
      ["anthropic/claude-sonnet-4-6", "openai/gpt-5.3-codex"],
      {
        enabled: true,
        retry_on_errors: [429, 503, 529],
        max_fallback_attempts: 5,
        cooldown_seconds: 600,
        timeout_seconds: 30,
        notify_on_fallback: true,
      },
    )

    expect(state.fallbackModels).toEqual([
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5.3-codex",
    ])
  })

  it("resets pending state and attempt count after a successful fallback response", () => {
    const state = createFallbackState("anthropic/claude-opus-4-6", ["anthropic/claude-sonnet-4-6"])
    state.currentModel = "anthropic/claude-sonnet-4-6"
    state.pendingFallbackModel = "anthropic/claude-sonnet-4-6"
    state.attemptCount = 2

    markFallbackResponseSuccess(state)

    expect(state.pendingFallbackModel).toBeUndefined()
    expect(state.attemptCount).toBe(0)
    expect(state.currentModel).toBe("anthropic/claude-sonnet-4-6")
  })

  it("restores the original model after its cooldown expires", () => {
    const now = Date.now()
    const state = createFallbackState("anthropic/claude-opus-4-6", [
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5.3-codex",
    ])

    state.currentModel = "openai/gpt-5.3-codex"
    state.fallbackIndex = 1
    state.attemptCount = 3
    state.failedModels.set("anthropic/claude-opus-4-6", now - 610_000)
    state.failedModels.set("anthropic/claude-sonnet-4-6", now - 610_000)

    const recoveredModel = recoverPreferredModel(state, 600, now)

    expect(recoveredModel).toBe("anthropic/claude-opus-4-6")
    expect(state.currentModel).toBe("anthropic/claude-opus-4-6")
    expect(state.fallbackIndex).toBe(-1)
    expect(state.attemptCount).toBe(0)
  })

  it("recovers to the highest available fallback when the original model is still cooling down", () => {
    const now = Date.now()
    const state = createFallbackState("anthropic/claude-opus-4-6", [
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5.3-codex",
    ])

    state.currentModel = "openai/gpt-5.3-codex"
    state.fallbackIndex = 1
    state.attemptCount = 2
    state.failedModels.set("anthropic/claude-opus-4-6", now - 100_000)
    state.failedModels.set("anthropic/claude-sonnet-4-6", now - 610_000)

    const recoveredModel = recoverPreferredModel(state, 600, now)

    expect(recoveredModel).toBe("anthropic/claude-sonnet-4-6")
    expect(state.currentModel).toBe("anthropic/claude-sonnet-4-6")
    expect(state.fallbackIndex).toBe(0)
    expect(state.attemptCount).toBe(0)
  })
})
