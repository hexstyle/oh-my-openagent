import { describe, expect, it } from "bun:test"

import { createAutoRetryHelpers } from "./auto-retry"
import { createFallbackState } from "./fallback-state"
import type { HookDeps } from "./types"

function createDeps(args: {
  promptCalls: Array<unknown>
  probeModelAvailability: (args: { sessionID: string; model: string; directory: string }) => Promise<boolean>
}): HookDeps {
  return {
    ctx: {
      directory: "/tmp/runtime-fallback-recovery-probe",
      client: {
        session: {
          abort: async () => undefined,
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
      retry_on_errors: [402, 429, 500, 502, 503, 504],
      max_fallback_attempts: 12,
      max_full_chain_cycles: 5,
      cooldown_seconds: 300,
      timeout_seconds: 0,
      transient_retry_window_seconds: 14_400,
      transient_retry_initial_delay_seconds: 30,
      transient_retry_max_delay_seconds: 300,
      notify_on_fallback: true,
    },
    options: {
      probeModelAvailability: args.probeModelAvailability,
    },
    pluginConfig: {} as HookDeps["pluginConfig"],
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

describe("runtime fallback recovery probe", () => {
  it("restores spark from a free-model stall when the background probe succeeds", async () => {
    const promptCalls: Array<unknown> = []
    const deps = createDeps({
      promptCalls,
      probeModelAvailability: async ({ model }) => model === "openai/gpt-5.3-codex-spark",
    })
    const sessionID = "ses_recovery_probe"
    const state = createFallbackState("anthropic/claude-opus-4-6", [
      "openai/gpt-5.3-codex-spark",
      "opencode/mimo-v2-pro-free",
    ])

    state.currentModel = "opencode/mimo-v2-pro-free"
    state.fallbackIndex = 1
    state.failedModels.set("anthropic/claude-opus-4-6", Date.now())
    state.failedModels.set("openai/gpt-5.3-codex-spark", Date.now())
    deps.sessionStates.set(sessionID, state)
    deps.sessionAwaitingFallbackResult.add(sessionID)

    const helpers = createAutoRetryHelpers(deps)
    await helpers.recoverPreferredModels()

    expect(state.currentModel).toBe("openai/gpt-5.3-codex-spark")
    expect(promptCalls).toHaveLength(1)
    expect(
      (promptCalls[0] as { body?: { model?: { providerID?: string; modelID?: string } } }).body?.model,
    ).toEqual({
      providerID: "openai",
      modelID: "gpt-5.3-codex-spark",
    })
  })
})
