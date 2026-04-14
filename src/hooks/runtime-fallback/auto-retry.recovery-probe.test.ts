import { describe, expect, it } from "bun:test"

import { createAutoRetryHelpers, didRecoveryProbeSucceed } from "./auto-retry"
import { createFallbackState } from "./fallback-state"
import type { HookDeps } from "./types"
import { OMO_INTERNAL_INITIATOR_MARKER } from "../../shared/internal-initiator-marker"

function createDeps(args: {
  promptCalls: Array<unknown>
  probeModelAvailability: (args: { sessionID: string; model: string; directory: string }) => Promise<boolean>
  maxFullChainCycles?: number
  timeoutSeconds?: number
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
      max_full_chain_cycles: args.maxFullChainCycles ?? 5,
      cooldown_seconds: 300,
      timeout_seconds: args.timeoutSeconds ?? 0,
      transient_retry_window_seconds: 900,
      transient_retry_initial_delay_seconds: 10,
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
  it("does not treat flare-style quota probe output as recovered when a later fallback prints OK", () => {
    const flareQuotaOutput = `
ERROR 2026-04-14T13:57:25 service=llm error={"error":{"name":"AI_APICallError","data":{"message":"You're out of extra usage. Add more at claude.ai/settings/usage and keep going."}}}
[session.error] You're out of extra usage. Add more at claude.ai/settings/usage and keep going.
OK
`

    expect(didRecoveryProbeSucceed(0, flareQuotaOutput)).toBe(false)
  })

  it("accepts a clean OK-only recovery probe result", () => {
    expect(didRecoveryProbeSucceed(0, "OK\n")).toBe(true)
  })

  it("restores spark from a free-model stall when the background probe succeeds", async () => {
    const promptCalls: Array<unknown> = []
    const deps = createDeps({
      promptCalls,
      probeModelAvailability: async ({ model }) => model === "openai/gpt-5.3-codex-spark",
      timeoutSeconds: 30,
    })
    const sessionID = "ses_recovery_probe"
    const state = createFallbackState("anthropic/claude-opus-4-6", [
      "openai/gpt-5.3-codex-spark",
      "opencode/big-pickle",
    ])

    state.currentModel = "opencode/big-pickle"
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
    const retryText = (
      promptCalls[0] as { body?: { parts?: Array<{ type?: string; text?: string }> } }
    ).body?.parts?.[0]?.text
    expect(retryText).toContain(OMO_INTERNAL_INITIATOR_MARKER)
    expect(retryText).not.toContain("Continue the task.")
  })

  it("does not bounce back to a recovered preferred model while the fallback run still has recent progress", async () => {
    const promptCalls: Array<unknown> = []
    const deps = createDeps({
      promptCalls,
      probeModelAvailability: async () => false,
      timeoutSeconds: 30,
    })
    const sessionID = "ses_recovery_recent_progress"
    const state = createFallbackState("anthropic/claude-opus-4-6", [
      "openai/gpt-5.4",
    ])

    state.currentModel = "openai/gpt-5.4"
    state.fallbackIndex = 0
    state.failedModels.set("anthropic/claude-opus-4-6", Date.now() - 600_000)
    deps.sessionStates.set(sessionID, state)
    deps.sessionAwaitingFallbackResult.add(sessionID)
    deps.sessionLastAccess.set(sessionID, Date.now() - 30_000)

    const helpers = createAutoRetryHelpers(deps)
    await helpers.recoverPreferredModels()

    expect(state.currentModel).toBe("openai/gpt-5.4")
    expect(promptCalls).toHaveLength(0)
  })

  it("caps recovery-driven full-chain loops so a stalled session cannot ping-pong forever", async () => {
    const promptCalls: Array<unknown> = []
    const deps = createDeps({
      promptCalls,
      probeModelAvailability: async () => false,
      maxFullChainCycles: 1,
      timeoutSeconds: 30,
    })
    const sessionID = "ses_recovery_cycle_cap"
    const state = createFallbackState("anthropic/claude-opus-4-6", [
      "openai/gpt-5.4",
    ])

    state.currentModel = "openai/gpt-5.4"
    state.fallbackIndex = 0
    state.failedModels.set("anthropic/claude-opus-4-6", Date.now() - 600_000)
    state.fullChainCyclesCompleted = 1
    deps.sessionStates.set(sessionID, state)
    deps.sessionAwaitingFallbackResult.add(sessionID)
    deps.sessionLastAccess.set(sessionID, Date.now() - 10 * 60_000)

    const helpers = createAutoRetryHelpers(deps)
    await helpers.recoverPreferredModels()

    expect(state.currentModel).toBe("openai/gpt-5.4")
    expect(promptCalls).toHaveLength(0)
  })
})
