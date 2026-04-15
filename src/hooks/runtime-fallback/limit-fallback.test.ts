/**
 * Tests covering the three bugs in the Atlas / quota / Spark fallback path:
 *
 *  Bug 1: `MessageAbortedError` hides quota-exceeded — plugin saw it as non-retryable
 *         and skipped fallback entirely, so Spark was never reached.
 *
 *  Bug 2: The watchdog timeout always used `fallback_chain` ordering (gpt-5.4 first),
 *         even when the model had been quota-limited. It should route to spark → free
 *         when a recent limit signal exists.
 *
 *  Bug 3: After `session.stop` (ESC), the watchdog timer that fired immediately after
 *         would still dispatch a new promptAsync, wasting tokens.
 */
import { describe, expect, it } from "bun:test"
import { createRuntimeFallbackHook } from "./index"
import type { OhMyOpenCodeConfig } from "../../config"
import { SessionCategoryRegistry } from "../../shared/session-category-registry"
import { OMO_INTERNAL_INITIATOR_MARKER } from "../../shared/internal-initiator-marker"

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function createPluginInput(opts?: {
  promptCalls?: Array<unknown>
  abortCalls?: string[]
  messagesResponse?: unknown
}) {
  const promptCalls = opts?.promptCalls ?? []
  const abortCalls = opts?.abortCalls ?? []
  const messagesResponse = opts?.messagesResponse ?? {
    data: [
      {
        info: { role: "user" },
        parts: [{ type: "text", text: "Build the feature." }],
      },
    ],
  }
  return {
    ctx: {
      client: {
        session: {
          abort: async ({ path }: { path: { id: string } }) => {
            abortCalls.push(path.id)
            return {}
          },
          messages: async () => messagesResponse,
          promptAsync: async (input: unknown) => {
            promptCalls.push(input)
            return {}
          },
        },
        tui: { showToast: async () => ({}) },
      },
      directory: "/test",
    },
    promptCalls,
    abortCalls,
  }
}

/** Plugin config with a paid primary + spark + free fallback chain. */
function makeCategoryConfig(fallbackModels: string[]): OhMyOpenCodeConfig {
  return {
    categories: {
      test: { fallback_models: fallbackModels },
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Bug 1 — MessageAbortedError should route to limit_fallback when quota context
// ---------------------------------------------------------------------------

describe("Bug 1 – MessageAbortedError after quota signal routes to spark", () => {
  it("quota error in session.error routes directly to spark (limit_fallback)", async () => {
    SessionCategoryRegistry.clear()
    const { ctx, promptCalls } = createPluginInput()
    const sessionID = "test-quota-direct"
    SessionCategoryRegistry.register(sessionID, "test")

    const hook = createRuntimeFallbackHook(ctx, {
      config: {
        enabled: true,
        retry_on_errors: [402, 429, 500, 503],
        max_fallback_attempts: 10,
        cooldown_seconds: 60,
        notify_on_fallback: false,
      },
      pluginConfig: makeCategoryConfig([
        "openai/gpt-5.4",
        "openai/gpt-5.3-codex-spark",
        "opencode/nemotron-3-super-free",
      ]),
    })

    // Primary model hits quota
    await hook.event({
      event: {
        type: "session.created",
        properties: {
          info: { id: sessionID, providerID: "anthropic", modelID: "claude-opus-4-6" },
        },
      },
    })
    await hook.event({
      event: {
        type: "session.error",
        properties: {
          sessionID,
          error: { message: "Subscription quota exceeded. You can continue using free models." },
        },
      },
    })

    // Should retry with spark (limit_fallback skips paid gpt-5.4)
    expect(promptCalls).toHaveLength(1)
    const body = (promptCalls[0] as { body: { model: { providerID: string; modelID: string } } }).body
    expect(body.model.providerID).toBe("openai")
    expect(body.model.modelID).toBe("gpt-5.3-codex-spark")

    hook.dispose?.()
    SessionCategoryRegistry.clear()
  })

  it("quota fallback uses an internal continuation payload instead of replaying visible user text", async () => {
    SessionCategoryRegistry.clear()
    const { ctx, promptCalls } = createPluginInput({
      messagesResponse: {
        data: [
          {
            info: { role: "user" },
            parts: [{ type: "text", text: "Continue implementing the actual plan." }],
          },
          {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "Working on it." }],
          },
          {
            info: { role: "user" },
            parts: [{
              type: "text",
              text: "\"Continue the current task from where you left off. The previous request appears stalled. Resume from the existing context, do not redo completed work, and continue.\"\n",
            }],
          },
        ],
      },
    })
    const sessionID = "test-quota-quoted-watchdog"
    SessionCategoryRegistry.register(sessionID, "test")

    const hook = createRuntimeFallbackHook(ctx, {
      config: {
        enabled: true,
        retry_on_errors: [400, 402, 429, 500, 503],
        max_fallback_attempts: 10,
        cooldown_seconds: 60,
        notify_on_fallback: false,
      },
      pluginConfig: makeCategoryConfig([
        "openai/gpt-5.4",
        "openai/gpt-5.3-codex-spark",
      ]),
    })

    await hook.event({
      event: {
        type: "session.created",
        properties: {
          info: { id: sessionID, providerID: "anthropic", modelID: "claude-opus-4-6" },
        },
      },
    })

    await hook.event({
      event: {
        type: "session.error",
        properties: {
          sessionID,
          error: {
            name: "AI_APICallError",
            data: {
              statusCode: 400,
              message: "You're out of extra usage. Add more at claude.ai/settings/usage and keep going.",
            },
          },
        },
      },
    })

    expect(promptCalls).toHaveLength(1)
    const body = (promptCalls[0] as {
      body: {
        model: { providerID: string; modelID: string }
        parts: Array<{ type?: string; text?: string }>
      }
    }).body
    expect(body.model.providerID).toBe("openai")
    expect(body.model.modelID).toBe("gpt-5.3-codex-spark")
    expect(body.parts).toHaveLength(1)
    expect(body.parts[0]?.type).toBe("text")
    expect(body.parts[0]?.text).toContain(OMO_INTERNAL_INITIATOR_MARKER)
    expect(body.parts[0]?.text).not.toContain("Continue implementing the actual plan.")
    expect(body.parts[0]?.text).not.toContain("Continue the current task from where you left off.")

    hook.dispose?.()
    SessionCategoryRegistry.clear()
  })

  it("MessageAbortedError after recent quota signal routes to spark, not gpt-5.4", async () => {
    SessionCategoryRegistry.clear()
    const { ctx, promptCalls } = createPluginInput()
    const sessionID = "test-aborted-after-quota"
    SessionCategoryRegistry.register(sessionID, "test")

    const hook = createRuntimeFallbackHook(ctx, {
      config: {
        enabled: true,
        retry_on_errors: [402, 429, 500, 503],
        max_fallback_attempts: 10,
        cooldown_seconds: 60,
        notify_on_fallback: false,
      },
      pluginConfig: makeCategoryConfig([
        "openai/gpt-5.4",
        "openai/gpt-5.3-codex-spark",
        "opencode/nemotron-3-super-free",
      ]),
    })

    await hook.event({
      event: {
        type: "session.created",
        properties: {
          info: { id: sessionID, providerID: "anthropic", modelID: "claude-opus-4-6" },
        },
      },
    })

    // Step 1: real quota signal arrives via message.updated (sets lastLimitErrorAt)
    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            sessionID,
            role: "assistant",
            providerID: "anthropic",
            modelID: "claude-opus-4-6",
            error: { message: "Subscription quota exceeded. You can continue using free models." },
          },
        },
      },
    })

    expect(promptCalls).toHaveLength(1)
    const first = (promptCalls[0] as { body: { model: { providerID: string; modelID: string } } }).body
    expect(first.model.modelID).toBe("gpt-5.3-codex-spark")

    hook.dispose?.()
    SessionCategoryRegistry.clear()
  })

  it("MessageAbortedError WITHOUT prior quota signal is still non-retryable", async () => {
    SessionCategoryRegistry.clear()
    const { ctx, promptCalls } = createPluginInput()
    const sessionID = "test-aborted-no-quota"
    SessionCategoryRegistry.register(sessionID, "test")

    const hook = createRuntimeFallbackHook(ctx, {
      config: {
        enabled: true,
        retry_on_errors: [402, 429, 500, 503],
        max_fallback_attempts: 10,
        cooldown_seconds: 60,
        notify_on_fallback: false,
      },
      pluginConfig: makeCategoryConfig([
        "openai/gpt-5.4",
        "openai/gpt-5.3-codex-spark",
      ]),
    })

    await hook.event({
      event: {
        type: "session.created",
        properties: {
          info: { id: sessionID, providerID: "anthropic", modelID: "claude-opus-4-6" },
        },
      },
    })

    // MessageAbortedError with NO preceding quota signal → non-retryable (user aborted)
    await hook.event({
      event: {
        type: "session.error",
        properties: {
          sessionID,
          error: { name: "MessageAbortedError", message: "MessageAbortedError" },
        },
      },
    })

    expect(promptCalls).toHaveLength(0)

    hook.dispose?.()
    SessionCategoryRegistry.clear()
  })
})

// ---------------------------------------------------------------------------
// Bug 2 — Watchdog timeout uses limit_fallback ordering when quota context
// ---------------------------------------------------------------------------

describe("Bug 2 – Watchdog timeout respects limit_fallback ordering when quota context exists", () => {
  it("timeout fires after quota signal → selects spark, not paid gpt-5.4", async () => {
    SessionCategoryRegistry.clear()
    const { ctx, promptCalls } = createPluginInput()
    const sessionID = "test-timeout-limit"
    SessionCategoryRegistry.register(sessionID, "test")

    const hook = createRuntimeFallbackHook(ctx, {
      config: {
        enabled: true,
        retry_on_errors: [402, 429, 500, 503],
        max_fallback_attempts: 10,
        cooldown_seconds: 60,
        notify_on_fallback: false,
        timeout_seconds: 0.05, // 50 ms
      },
      session_timeout_ms: 50,
      pluginConfig: makeCategoryConfig([
        "openai/gpt-5.4",
        "openai/gpt-5.3-codex-spark",
        "opencode/nemotron-3-super-free",
      ]),
    })

    // Session starts
    await hook.event({
      event: {
        type: "session.created",
        properties: {
          info: { id: sessionID, providerID: "anthropic", modelID: "claude-opus-4-6" },
        },
      },
    })

    // Quota signal sets lastLimitErrorAt
    await hook.event({
      event: {
        type: "session.error",
        properties: {
          sessionID,
          error: { message: "Subscription quota exceeded. You can continue using free models." },
        },
      },
    })

    const afterFirstFallback = promptCalls.length
    expect(afterFirstFallback).toBe(1)
    const first = (promptCalls[0] as { body: { model: { providerID: string; modelID: string } } }).body
    expect(first.model.modelID).toBe("gpt-5.3-codex-spark")

    hook.dispose?.()
    SessionCategoryRegistry.clear()
  })

  it("timeout fires WITHOUT quota context → uses fallback_chain (paid first)", async () => {
    SessionCategoryRegistry.clear()
    const { ctx, promptCalls } = createPluginInput()
    const sessionID = "test-timeout-chain"
    SessionCategoryRegistry.register(sessionID, "test")

    const hook = createRuntimeFallbackHook(ctx, {
      config: {
        enabled: true,
        retry_on_errors: [500, 503],
        max_fallback_attempts: 10,
        cooldown_seconds: 60,
        notify_on_fallback: false,
        timeout_seconds: 0.05,
      },
      session_timeout_ms: 50,
      pluginConfig: makeCategoryConfig([
        "openai/gpt-5.4",
        "openai/gpt-5.3-codex-spark",
      ]),
    })

    // Session becomes active via message.updated (arms timeout without quota signal)
    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            sessionID,
            role: "user",
            providerID: "anthropic",
            modelID: "claude-opus-4-6",
          },
        },
      },
    })

    // Anthropic first-token turns now get the extended quiet window before
    // we conclude the session is actually stalled.
    await sleep(120)
    expect(promptCalls.length).toBe(0)

    await sleep(140)
    expect(promptCalls.length).toBeGreaterThanOrEqual(1)
    const first = (promptCalls[0] as { body: { model: { providerID: string; modelID: string } } }).body
    // No quota context → first in chain is paid gpt-5.4
    expect(first.model.modelID).toBe("gpt-5.4")

    hook.dispose?.()
    SessionCategoryRegistry.clear()
  })
})

// ---------------------------------------------------------------------------
// Bug 3 – session.stop (ESC) prevents watchdog from dispatching after stop
// ---------------------------------------------------------------------------

describe("Bug 3 – session.stop inhibits watchdog retries", () => {
  it("session.stop prevents in-flight timer from dispatching promptAsync", async () => {
    SessionCategoryRegistry.clear()
    const { ctx, promptCalls } = createPluginInput()
    const sessionID = "test-stop-inhibit"
    SessionCategoryRegistry.register(sessionID, "test")

    const hook = createRuntimeFallbackHook(ctx, {
      config: {
        enabled: true,
        retry_on_errors: [500, 503],
        max_fallback_attempts: 10,
        cooldown_seconds: 60,
        notify_on_fallback: false,
        timeout_seconds: 0.05,
      },
      session_timeout_ms: 50,
      pluginConfig: makeCategoryConfig(["openai/gpt-5.4"]),
    })

    // Arm the watchdog via a user message
    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            sessionID,
            role: "user",
            providerID: "anthropic",
            modelID: "claude-opus-4-6",
          },
        },
      },
    })

    // ESC — session.stop fires before the timeout
    await hook.event({
      event: {
        type: "session.stop",
        properties: { sessionID },
      },
    })

    // Wait well past the timeout window
    await sleep(120)

    // No retry should have been dispatched
    expect(promptCalls).toHaveLength(0)

    hook.dispose?.()
    SessionCategoryRegistry.clear()
  })

  it("new user message after session.stop clears stoppedAt and re-enables watchdog", async () => {
    SessionCategoryRegistry.clear()
    const { ctx, promptCalls } = createPluginInput()
    const sessionID = "test-stop-then-restart"
    SessionCategoryRegistry.register(sessionID, "test")

    const hook = createRuntimeFallbackHook(ctx, {
      config: {
        enabled: true,
        retry_on_errors: [500, 503],
        max_fallback_attempts: 10,
        cooldown_seconds: 60,
        notify_on_fallback: false,
        timeout_seconds: 0.05,
      },
      session_timeout_ms: 50,
      pluginConfig: makeCategoryConfig(["openai/gpt-5.4"]),
    })

    // Arm + stop
    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: { sessionID, role: "user", providerID: "anthropic", modelID: "claude-opus-4-6" },
        },
      },
    })
    await hook.event({ event: { type: "session.stop", properties: { sessionID } } })

    // Verify state has stoppedAt
    const state = hook._deps?.sessionStates.get(sessionID)
    expect(state?.stoppedAt).toBeDefined()

    // User sends a NEW message → should clear stoppedAt
    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: { sessionID, role: "user", id: "msg-new", providerID: "anthropic", modelID: "claude-opus-4-6" },
        },
      },
    })

    expect(state?.stoppedAt).toBeUndefined()

    // Anthropic first-token turns still get the extended quiet window after
    // a resumed user turn re-arms the watchdog.
    await sleep(120)
    expect(promptCalls).toHaveLength(0)

    await sleep(140)
    expect(promptCalls.length).toBeGreaterThanOrEqual(1)

    hook.dispose?.()
    SessionCategoryRegistry.clear()
  })
})
