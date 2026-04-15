import { describe, expect, it } from "bun:test"

import {
  canKeepRetryingTransiently,
  createFallbackState,
  getNextTransientRetryDelayMs,
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
        max_full_chain_cycles: 5,
        cooldown_seconds: 600,
        timeout_seconds: 30,
        transient_retry_window_seconds: 900,
        transient_retry_initial_delay_seconds: 10,
        transient_retry_max_delay_seconds: 300,
        notify_on_fallback: true,
      },
    )

    expect(state.fallbackModels).toEqual([
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5.3-codex",
    ])
  })

  it("skips variant-only aliases of the current model when preparing fallback", () => {
    const state = createFallbackState("anthropic/claude-opus-4-6(max)")

    const result = prepareFallback(
      "session-skip-variant-alias",
      state,
      [
        "anthropic/claude-opus-4-6",
        "openai/gpt-5.4(xhigh)",
        "anthropic/claude-sonnet-4-6",
      ],
      {
        enabled: true,
        retry_on_errors: [429, 503, 529],
        max_fallback_attempts: 5,
        max_full_chain_cycles: 5,
        cooldown_seconds: 600,
        timeout_seconds: 30,
        transient_retry_window_seconds: 900,
        transient_retry_initial_delay_seconds: 10,
        transient_retry_max_delay_seconds: 300,
        notify_on_fallback: true,
      },
    )

    expect(result).toEqual({
      success: true,
      newModel: "openai/gpt-5.4(xhigh)",
    })
    expect(state.currentModel).toBe("openai/gpt-5.4(xhigh)")
  })

  it("resets pending state and attempt count after a successful fallback response", () => {
    const state = createFallbackState("anthropic/claude-opus-4-6", ["anthropic/claude-sonnet-4-6"])
    state.currentModel = "anthropic/claude-sonnet-4-6"
    state.pendingFallbackModel = "anthropic/claude-sonnet-4-6"
    state.attemptCount = 2
    state.transientRetryCount = 1
    state.transientRetryStartedAt = Date.now() - 1000
    state.transientRetryDelayMs = 10_000
    state.pendingTransientRetry = true

    markFallbackResponseSuccess(state)

    expect(state.pendingFallbackModel).toBeUndefined()
    expect(state.attemptCount).toBe(0)
    expect(state.transientRetryCount).toBe(0)
    expect(state.transientRetryStartedAt).toBeUndefined()
    expect(state.transientRetryDelayMs).toBeUndefined()
    expect(state.pendingTransientRetry).toBe(false)
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

  it("does not recover to a variant-only alias while the original identity is still cooling down", () => {
    const now = Date.now()
    const state = createFallbackState("anthropic/claude-opus-4-6(max)", [
      "anthropic/claude-opus-4-6",
      "openai/gpt-5.4(xhigh)",
    ])

    state.currentModel = "openai/gpt-5.4(xhigh)"
    state.fallbackIndex = 1
    state.attemptCount = 1
    state.failedModels.set("anthropic/claude-opus-4-6(max)", now - 100_000)

    const recoveredModel = recoverPreferredModel(state, 600, now)

    expect(recoveredModel).toBeUndefined()
    expect(state.currentModel).toBe("openai/gpt-5.4(xhigh)")
    expect(state.fallbackIndex).toBe(1)
    expect(state.attemptCount).toBe(1)
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

  it("keeps transient retries alive for up to fifteen minutes and caps delay at five minutes", () => {
    const now = Date.now()
    const state = createFallbackState("openai/gpt-5.4")
    const config = {
      enabled: true,
      retry_on_errors: [429, 503],
      max_fallback_attempts: 12,
      max_full_chain_cycles: 5,
      cooldown_seconds: 300,
      timeout_seconds: 45,
      transient_retry_window_seconds: 900,
      transient_retry_initial_delay_seconds: 10,
      transient_retry_max_delay_seconds: 300,
      notify_on_fallback: true,
    } as const

    expect(canKeepRetryingTransiently(state, config, now)).toBe(true)
    expect(getNextTransientRetryDelayMs(state, config)).toBe(10_000)

    state.transientRetryStartedAt = now - 60_000
    state.transientRetryDelayMs = 240_000

    expect(canKeepRetryingTransiently(state, config, now)).toBe(true)
    expect(getNextTransientRetryDelayMs(state, config)).toBe(300_000)

    state.transientRetryStartedAt = now - 901_000
    expect(canKeepRetryingTransiently(state, config, now)).toBe(false)
  })
})
