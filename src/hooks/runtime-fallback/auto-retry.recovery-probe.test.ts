import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

import { createAutoRetryHelpers, didRecoveryProbeSucceed } from "./auto-retry"
import { WATCHDOG_CONTINUATION_PROMPT } from "./constants"
import { createFallbackState } from "./fallback-state"
import type { HookDeps } from "./types"
import { OMO_INTERNAL_INITIATOR_MARKER } from "../../shared/internal-initiator-marker"
import { _resetForTesting, setSessionAgent } from "../../features/claude-code-session-state"

function createDeps(args: {
  promptCalls: Array<unknown>
  probeModelAvailability: (args: { sessionID: string; model: string; directory: string }) => Promise<boolean>
  maxFullChainCycles?: number
  timeoutSeconds?: number
  directory?: string
}): HookDeps {
  return {
    ctx: {
      directory: args.directory ?? "/tmp/runtime-fallback-recovery-probe",
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
  afterEach(() => {
    _resetForTesting()
  })

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

  it("nudges a flare-style stalled session with an internal continuation after 15 minutes of inactivity", async () => {
    const promptCalls: Array<unknown> = []
    const deps = createDeps({
      promptCalls,
      probeModelAvailability: async () => false,
      timeoutSeconds: 30,
    })
    const sessionID = "ses_flare_stalled"
    const state = createFallbackState("openai/gpt-5.4", [
      "opencode/big-pickle",
    ])

    state.resolvedAgent = "Prometheus (Plan Builder)"
    deps.sessionStates.set(sessionID, state)
    deps.sessionLastAccess.set(sessionID, Date.now() - (15 * 60_000) - 1_000)

    const helpers = createAutoRetryHelpers(deps)
    await helpers.recoverPreferredModels()

    expect(promptCalls).toHaveLength(1)
    expect(
      (promptCalls[0] as { body?: { model?: { providerID?: string; modelID?: string } } }).body?.model,
    ).toEqual({
      providerID: "openai",
      modelID: "gpt-5.4",
    })
    const retryText = (
      promptCalls[0] as { body?: { parts?: Array<{ type?: string; text?: string }> } }
    ).body?.parts?.[0]?.text
    expect(retryText).toContain(OMO_INTERNAL_INITIATOR_MARKER)
    expect(retryText).toContain(WATCHDOG_CONTINUATION_PROMPT)
  })

  it("prefers boulder execution agent over stale in-memory prometheus during stalled-session nudges", async () => {
    const promptCalls: Array<unknown> = []
    const directory = join("/tmp", `runtime-fallback-boulder-agent-${randomUUID()}`)
    const sessionID = "ses_runtime_fallback_boulder"

    mkdirSync(join(directory, ".sisyphus"), { recursive: true })
    writeFileSync(
      join(directory, ".sisyphus", "boulder.json"),
      JSON.stringify({
        active_plan: "/tmp/test-plan.md",
        started_at: new Date().toISOString(),
        session_ids: [sessionID],
        plan_name: "test-plan",
        agent: "atlas",
      }),
    )
    setSessionAgent(sessionID, "Prometheus (Plan Builder)")

    const deps = createDeps({
      promptCalls,
      probeModelAvailability: async () => false,
      timeoutSeconds: 30,
      directory,
    })
    const state = createFallbackState("openai/gpt-5.4", [
      "opencode/big-pickle",
    ])

    deps.sessionStates.set(sessionID, state)
    deps.sessionLastAccess.set(sessionID, Date.now() - (15 * 60_000) - 1_000)

    try {
      const helpers = createAutoRetryHelpers(deps)
      await helpers.recoverPreferredModels()

      expect(promptCalls).toHaveLength(1)
      expect(
        (promptCalls[0] as { body?: { agent?: string } }).body?.agent,
      ).toBe("Atlas (Plan Executor)")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("re-resolves a stale scheduled timeout agent from boulder before dispatching fallback continuation", async () => {
    const promptCalls: Array<unknown> = []
    const directory = join("/tmp", `runtime-fallback-timeout-agent-${randomUUID()}`)
    const sessionID = "ses_runtime_fallback_timeout_agent"

    mkdirSync(join(directory, ".sisyphus"), { recursive: true })
    writeFileSync(
      join(directory, ".sisyphus", "boulder.json"),
      JSON.stringify({
        active_plan: "/tmp/test-plan.md",
        started_at: new Date().toISOString(),
        session_ids: [sessionID],
        plan_name: "test-plan",
        agent: "atlas",
      }),
    )

    const deps = createDeps({
      promptCalls,
      probeModelAvailability: async () => false,
      timeoutSeconds: 30,
      directory,
    })
    deps.pluginConfig = {
      fallback_models: ["openai/gpt-5.4"],
    } as HookDeps["pluginConfig"]

    const state = createFallbackState("anthropic/claude-opus-4-6", [
      "openai/gpt-5.4",
    ])
    deps.sessionStates.set(sessionID, state)

    try {
      const helpers = createAutoRetryHelpers(deps)
      helpers.scheduleSessionFallbackTimeout(sessionID, {
        resolvedAgent: "Prometheus (Plan Builder)",
        source: "test.stale-timeout-agent",
        timeoutMsOverride: 1,
      })

      await new Promise((resolve) => setTimeout(resolve, 25))

      expect(promptCalls).toHaveLength(1)
      expect(
        (promptCalls[0] as { body?: { agent?: string } }).body?.agent,
      ).toBe("Atlas (Plan Executor)")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("does not nudge a data_catalog session that already settled with session.idle", async () => {
    const promptCalls: Array<unknown> = []
    const deps = createDeps({
      promptCalls,
      probeModelAvailability: async () => false,
      timeoutSeconds: 30,
    })
    const sessionID = "ses_data_catalog_idle"
    const state = createFallbackState("openai/gpt-5.4", [
      "opencode/big-pickle",
    ])
    const settledAt = Date.now() - 60_000

    state.lastMeaningfulProgressAt = settledAt - 1_000
    state.lastTerminalIdleAt = settledAt
    deps.sessionStates.set(sessionID, state)
    deps.sessionLastAccess.set(sessionID, Date.now() - (16 * 60_000))

    const helpers = createAutoRetryHelpers(deps)
    await helpers.recoverPreferredModels()

    expect(promptCalls).toHaveLength(0)
  })

  it("nudges a stalled session even when session.idle happened after an error tail", async () => {
    const promptCalls: Array<unknown> = []
    const deps = createDeps({
      promptCalls,
      probeModelAvailability: async () => false,
      timeoutSeconds: 30,
    })
    const sessionID = "ses_flare_idle_after_error"
    const state = createFallbackState("openai/gpt-5.3-codex-spark", [
      "opencode/big-pickle",
    ])
    const progressAt = Date.now() - (20 * 60_000)
    const errorAt = progressAt + 60_000

    state.lastMeaningfulProgressAt = progressAt
    ;(state as { lastErrorAt?: number }).lastErrorAt = errorAt
    state.lastTerminalIdleAt = errorAt + 1_000
    deps.sessionStates.set(sessionID, state)
    deps.sessionLastAccess.set(sessionID, Date.now() - (16 * 60_000))

    const helpers = createAutoRetryHelpers(deps)
    await helpers.recoverPreferredModels()

    expect(promptCalls).toHaveLength(1)
    expect(
      (promptCalls[0] as { body?: { model?: { providerID?: string; modelID?: string } } }).body?.model,
    ).toEqual({
      providerID: "openai",
      modelID: "gpt-5.3-codex-spark",
    })
  })

  it("nudges a stale fallback session even after passive preferred-model recovery changes the target model", async () => {
    const promptCalls: Array<unknown> = []
    const deps = createDeps({
      promptCalls,
      probeModelAvailability: async () => false,
      timeoutSeconds: 30,
    })
    const sessionID = "ses_stale_recovered_model"
    const state = createFallbackState("anthropic/claude-opus-4-6", [
      "openai/gpt-5.4",
    ])

    state.currentModel = "openai/gpt-5.4"
    state.fallbackIndex = 0
    state.resolvedAgent = "Prometheus (Plan Builder)"
    deps.sessionStates.set(sessionID, state)
    deps.sessionLastAccess.set(sessionID, Date.now() - (16 * 60_000))

    const helpers = createAutoRetryHelpers(deps)
    await helpers.recoverPreferredModels()

    expect(state.currentModel).toBe("anthropic/claude-opus-4-6")
    expect(promptCalls).toHaveLength(1)
    expect(
      (promptCalls[0] as { body?: { model?: { providerID?: string; modelID?: string } } }).body?.model,
    ).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-4-6",
    })
  })
})
