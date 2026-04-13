import { describe, expect, it } from "bun:test"

import { createAutoRetryHelpers } from "./auto-retry"
import { createFallbackState } from "./fallback-state"
import type { HookDeps } from "./types"

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs = 300, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await sleep(intervalMs)
  }

  if (predicate()) {
    return
  }

  throw new Error(`Condition was not met within ${timeoutMs}ms`)
}

function createDeps(args: {
  promptCalls: Array<unknown>
  abortCalls: string[]
  retryWindowSeconds: number
}): HookDeps {
  return {
    ctx: {
      directory: "/tmp/runtime-fallback-transient-backoff",
      client: {
        session: {
          abort: async ({ path }) => {
            args.abortCalls.push(path.id)
            return undefined
          },
          messages: async () => ({
            data: [
              {
                info: { role: "user" },
                parts: [{ type: "text", text: "Continue the task." }],
              },
            ],
          }),
          promptAsync: async (input) => {
            args.promptCalls.push(input)
            return undefined
          },
        },
        tui: {
          showToast: async () => undefined,
        },
      },
    },
    config: {
      enabled: true,
      retry_on_errors: [408, 500, 502, 503, 504],
      max_fallback_attempts: 12,
      max_full_chain_cycles: 5,
      cooldown_seconds: 300,
      timeout_seconds: 1,
      transient_retry_window_seconds: args.retryWindowSeconds,
      transient_retry_initial_delay_seconds: 0.01,
      transient_retry_max_delay_seconds: 0.05,
      notify_on_fallback: true,
    },
    options: {
      session_timeout_ms: 10,
    },
    pluginConfig: {
      fallback_models: ["openai/gpt-5.3-codex-spark"],
    } as HookDeps["pluginConfig"],
    sessionStates: new Map(),
    sessionLastAccess: new Map(),
    sessionLastUserMessageIDs: new Map(),
    sessionRecentCompletionUntil: new Map(),
    sessionRetryInFlight: new Set(),
    sessionAwaitingFallbackResult: new Set(),
    sessionFallbackTimeouts: new Map(),
    sessionTransientRetryTimeouts: new Map(),
    sessionStatusRetryKeys: new Map(),
  }
}

describe("runtime fallback transient backoff", () => {
  it("keeps retrying the same model while the transient retry window is still open", async () => {
    const promptCalls: Array<unknown> = []
    const abortCalls: string[] = []
    const deps = createDeps({
      promptCalls,
      abortCalls,
      retryWindowSeconds: 0.2,
    })
    const sessionID = "ses_transient_same_model"
    deps.sessionStates.set(sessionID, createFallbackState("openai/gpt-5.4"))

    const helpers = createAutoRetryHelpers(deps)
    const retried = await helpers.retryCurrentModel(sessionID, undefined, "session.error")

    expect(retried).toBe(true)
    expect(promptCalls).toHaveLength(1)

    await waitFor(() => abortCalls.length >= 1 && promptCalls.length >= 2)

    expect(abortCalls.length).toBeGreaterThanOrEqual(1)
    expect(promptCalls).toHaveLength(2)
    for (const call of promptCalls) {
      expect(
        (call as { body?: { model?: { providerID?: string; modelID?: string } } }).body?.model,
      ).toEqual({
        providerID: "openai",
        modelID: "gpt-5.4",
      })
    }

    const state = deps.sessionStates.get(sessionID)
    expect(state?.currentModel).toBe("openai/gpt-5.4")
    expect(state?.pendingFallbackModel).toBeUndefined()
  })

  it("falls back after the transient retry window expires", async () => {
    const promptCalls: Array<unknown> = []
    const abortCalls: string[] = []
    const deps = createDeps({
      promptCalls,
      abortCalls,
      retryWindowSeconds: 0.025,
    })
    const sessionID = "ses_transient_then_fallback"
    deps.sessionStates.set(sessionID, createFallbackState("openai/gpt-5.4"))

    const helpers = createAutoRetryHelpers(deps)
    const retried = await helpers.retryCurrentModel(sessionID, undefined, "session.error")

    expect(retried).toBe(true)

    await waitFor(() => abortCalls.length >= 2 && promptCalls.length >= 3)

    expect(abortCalls.length).toBeGreaterThanOrEqual(2)
    expect(promptCalls).toHaveLength(3)
    expect(
      (promptCalls[2] as { body?: { model?: { providerID?: string; modelID?: string } } }).body?.model,
    ).toEqual({
      providerID: "openai",
      modelID: "gpt-5.3-codex-spark",
    })

    const state = deps.sessionStates.get(sessionID)
    expect(state?.currentModel).toBe("openai/gpt-5.3-codex-spark")
  })

  it("uses the explore runtime key for auto-retry prompt payloads", async () => {
    const promptCalls: Array<unknown> = []
    const abortCalls: string[] = []
    const deps = createDeps({
      promptCalls,
      abortCalls,
      retryWindowSeconds: 0.025,
    })
    const sessionID = "ses_transient_explore"
    deps.sessionStates.set(sessionID, createFallbackState("openai/gpt-5.3-codex-spark"))

    const helpers = createAutoRetryHelpers(deps)
    const retried = await helpers.retryCurrentModel(sessionID, "Explore (Code Search)", "session.error")

    expect(retried).toBe(true)

    const firstPrompt = promptCalls[0] as { body?: { agent?: string } } | undefined
    expect(firstPrompt?.body?.agent).toBe("explore")
  })

  it("can defer opaque transient retries instead of dispatching promptAsync immediately", async () => {
    const promptCalls: Array<unknown> = []
    const abortCalls: string[] = []
    const deps = createDeps({
      promptCalls,
      abortCalls,
      retryWindowSeconds: 0.2,
    })
    const sessionID = "ses_transient_delayed_unknown"
    deps.sessionStates.set(sessionID, createFallbackState("openai/gpt-5.4"))

    const helpers = createAutoRetryHelpers(deps)
    const retried = await helpers.retryCurrentModel(sessionID, undefined, "session.error", {
      immediate: false,
    })

    expect(retried).toBe(true)
    expect(promptCalls).toHaveLength(0)

    await sleep(20)

    expect(abortCalls).toHaveLength(0)
    expect(promptCalls).toHaveLength(1)
    expect(
      (promptCalls[0] as { body?: { model?: { providerID?: string; modelID?: string } } }).body?.model,
    ).toEqual({
      providerID: "openai",
      modelID: "gpt-5.4",
    })
  })
})
