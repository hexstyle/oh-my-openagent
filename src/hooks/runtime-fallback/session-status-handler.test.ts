import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import type { HookDeps, RuntimeFallbackPluginInput } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { createFallbackState } from "./fallback-state"
import { createSessionStatusHandler } from "./session-status-handler"
import { SessionCategoryRegistry } from "../../shared/session-category-registry"
import * as sharedModule from "../../shared/logger"

function createContext(): RuntimeFallbackPluginInput {
  return {
    client: {
      session: {
        abort: async () => ({}),
        messages: async () => ({ data: [] }),
        promptAsync: async () => ({}),
      },
      tui: {
        showToast: async () => ({}),
      },
    },
    directory: "/test/dir",
  }
}

function createDeps(): HookDeps {
  return {
    ctx: createContext(),
    config: {
      enabled: true,
      retry_on_errors: [429, 503, 529],
      max_fallback_attempts: 4,
      max_full_chain_cycles: 5,
      cooldown_seconds: 60,
      timeout_seconds: 30,
      transient_retry_window_seconds: 900,
      transient_retry_initial_delay_seconds: 10,
      transient_retry_max_delay_seconds: 300,
      notify_on_fallback: false,
    },
    options: undefined,
    pluginConfig: {
      categories: {
        test: {
          fallback_models: ["openai/gpt-5.4", "google/gemini-2.5-pro"],
        },
      },
    },
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

function createHelpers(
  abortCalls: string[],
  retryCalls: Array<{ sessionID: string; model: string; source: string }>,
  sameModelRetryCalls: Array<{ sessionID: string; source: string; immediate: boolean; persistent?: boolean; resolvedAgent?: string; maxAttempts?: number }>,
  freshRetryCalls: Array<{ sessionID: string; source: string; resolvedAgent?: string }>,
  scheduleCalls: Array<{ sessionID: string; resolvedAgent?: string; source?: string; mode?: "fallback" | "transient_retry"; timeoutMsOverride?: number }>,
  retryCurrentModelResult = false,
): AutoRetryHelpers {
  return {
    abortSessionRequest: async (sessionID: string) => {
      abortCalls.push(sessionID)
    },
    clearSessionFallbackTimeout: () => {},
    scheduleSessionFallbackTimeout: (
      sessionID: string,
      args?: {
        resolvedAgent?: string
        source?: string
        mode?: "fallback" | "transient_retry"
        timeoutMsOverride?: number
      },
    ) => {
      scheduleCalls.push({ sessionID, ...args })
    },
    autoRetryWithFallback: async (sessionID: string, model: string, _resolvedAgent: string | undefined, source: string) => {
      retryCalls.push({ sessionID, model, source })
    },
    retryCurrentModel: async (
      sessionID: string,
      resolvedAgent: string | undefined,
      source: string,
      options?: { immediate?: boolean; persistent?: boolean; maxAttempts?: number },
    ) => {
      sameModelRetryCalls.push({
        sessionID,
        resolvedAgent,
        source,
        immediate: options?.immediate ?? false,
        persistent: options?.persistent ?? false,
        maxAttempts: options?.maxAttempts,
      })
      return retryCurrentModelResult
    },
    retryCurrentModelInFreshSession: async (
      sessionID: string,
      resolvedAgent: string | undefined,
      source: string,
    ) => {
      freshRetryCalls.push({
        sessionID,
        resolvedAgent,
        source,
      })
      return true
    },
    resolveAgentForSessionFromContext: async () => undefined,
    cleanupStaleSessions: () => {},
    recoverPreferredModels: async () => {},
  }
}

describe("createSessionStatusHandler", () => {
  let logCalls: Array<{ msg: string; data?: unknown }>
  let logSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    logCalls = []
    logSpy = spyOn(sharedModule, "log").mockImplementation((msg: string, data?: unknown) => {
      logCalls.push({ msg, data })
    })
  })

  afterEach(() => {
    logSpy?.mockRestore()
    SessionCategoryRegistry.clear()
  })

  it("#given a pending fallback model #when a new provider cooldown retry arrives #then the handler overrides the pending fallback and advances the chain", async () => {
    // given
    SessionCategoryRegistry.clear()
    const sessionID = "session-status-pending-fallback"
    SessionCategoryRegistry.register(sessionID, "test")

    const deps = createDeps()
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const sameModelRetryCalls: Array<{ sessionID: string; source: string; immediate: boolean; persistent?: boolean; resolvedAgent?: string; maxAttempts?: number }> = []
    const freshRetryCalls: Array<{ sessionID: string; source: string; resolvedAgent?: string }> = []
    const scheduleCalls: Array<{ sessionID: string; resolvedAgent?: string; source?: string; mode?: "fallback" | "transient_retry" }> = []
    const state = createFallbackState("anthropic/claude-opus-4-6")
    state.currentModel = "openai/gpt-5.4"
    state.fallbackIndex = 0
    state.attemptCount = 1
    state.pendingFallbackModel = "openai/gpt-5.4"
    state.failedModels.set("anthropic/claude-opus-4-6", Date.now())
    deps.sessionStates.set(sessionID, state)

    const handler = createSessionStatusHandler(
      deps,
      createHelpers(abortCalls, retryCalls, sameModelRetryCalls, freshRetryCalls, scheduleCalls),
      deps.sessionStatusRetryKeys,
    )

    // when
    await handler({
      sessionID,
      model: "openai/gpt-5.4",
      status: {
        type: "retry",
        attempt: 2,
        message: "All credentials for model gpt-5.4 are cooling down [retrying in 7m 56s attempt #2]",
      },
    })

    // then
    expect(abortCalls).toEqual([sessionID])
    expect(sameModelRetryCalls).toEqual([])
    expect(retryCalls).toEqual([
      {
        sessionID,
        model: "google/gemini-2.5-pro",
        source: "session.status.limit_fallback",
      },
    ])
    expect(state.currentModel).toBe("google/gemini-2.5-pro")
    expect(state.pendingFallbackModel).toBe("google/gemini-2.5-pro")
    SessionCategoryRegistry.clear()
  })

  it("#given a pending fallback model #when a stale retry signal arrives from the previous model #then the handler keeps the pending fallback instead of advancing again", async () => {
    SessionCategoryRegistry.clear()
    const sessionID = "session-status-stale-previous-model-retry"
    SessionCategoryRegistry.register(sessionID, "test")

    const deps = createDeps()
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const sameModelRetryCalls: Array<{ sessionID: string; source: string; immediate: boolean; persistent?: boolean; resolvedAgent?: string }> = []
    const freshRetryCalls: Array<{ sessionID: string; source: string; resolvedAgent?: string }> = []
    const scheduleCalls: Array<{ sessionID: string; resolvedAgent?: string; source?: string; mode?: "fallback" | "transient_retry" }> = []
    const state = createFallbackState("anthropic/claude-opus-4-6")
    state.currentModel = "openai/gpt-5.4"
    state.fallbackIndex = 0
    state.attemptCount = 1
    state.pendingFallbackModel = "openai/gpt-5.4"
    state.failedModels.set("anthropic/claude-opus-4-6", Date.now())
    deps.sessionStates.set(sessionID, state)

    const handler = createSessionStatusHandler(
      deps,
      createHelpers(abortCalls, retryCalls, sameModelRetryCalls, freshRetryCalls, scheduleCalls),
      deps.sessionStatusRetryKeys,
    )

    await handler({
      sessionID,
      model: "anthropic/claude-opus-4-6",
      status: {
        type: "retry",
        attempt: 2,
        message: "All credentials for model claude-opus-4-6 are cooling down [retrying in 7m 56s attempt #2]",
      },
    })

    expect(abortCalls).toEqual([])
    expect(sameModelRetryCalls).toEqual([])
    expect(retryCalls).toEqual([])
    expect(scheduleCalls).toEqual([])
    expect(state.currentModel).toBe("openai/gpt-5.4")
    expect(state.pendingFallbackModel).toBe("openai/gpt-5.4")
    SessionCategoryRegistry.clear()
  })

  it("#given an Anthropic extra-usage retry status #when the handler sees it #then it falls back immediately instead of waiting for provider retry", async () => {
    // given
    SessionCategoryRegistry.clear()
    const sessionID = "session-status-extra-usage"
    SessionCategoryRegistry.register(sessionID, "test")

    const deps = createDeps()
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const sameModelRetryCalls: Array<{ sessionID: string; source: string; immediate: boolean; persistent?: boolean; resolvedAgent?: string }> = []
    const freshRetryCalls: Array<{ sessionID: string; source: string; resolvedAgent?: string }> = []
    const scheduleCalls: Array<{ sessionID: string; resolvedAgent?: string; source?: string }> = []
    const state = createFallbackState("anthropic/claude-opus-4-6")
    deps.sessionStates.set(sessionID, state)

    const handler = createSessionStatusHandler(
      deps,
      createHelpers(abortCalls, retryCalls, sameModelRetryCalls, freshRetryCalls, scheduleCalls),
      deps.sessionStatusRetryKeys,
    )

    // when
    await handler({
      sessionID,
      model: "anthropic/claude-opus-4-6",
      status: {
        type: "retry",
        attempt: 1,
        message: "Extra usage is required for long context requests.",
      },
    })

    // then
    expect(abortCalls).toEqual([sessionID])
    expect(sameModelRetryCalls).toEqual([])
    expect(retryCalls).toEqual([
      {
        sessionID,
        model: "openai/gpt-5.4",
        source: "session.status.fallback_chain",
      },
    ])
    expect(state.currentModel).toBe("openai/gpt-5.4")
    SessionCategoryRegistry.clear()
  })

  it("#given a running session #when a non-retry active session.status arrives #then the timeout is refreshed instead of triggering fallback", async () => {
    // given
    const sessionID = "session-status-active"
    const deps = createDeps()
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const sameModelRetryCalls: Array<{ sessionID: string; source: string; immediate: boolean; persistent?: boolean; resolvedAgent?: string }> = []
    const freshRetryCalls: Array<{ sessionID: string; source: string; resolvedAgent?: string }> = []
    const scheduleCalls: Array<{ sessionID: string; resolvedAgent?: string; source?: string; timeoutMsOverride?: number }> = []
    const state = createFallbackState("openai/gpt-5.4")
    deps.sessionStates.set(sessionID, state)

    const handler = createSessionStatusHandler(
      deps,
      createHelpers(abortCalls, retryCalls, sameModelRetryCalls, freshRetryCalls, scheduleCalls),
      deps.sessionStatusRetryKeys,
    )

    // when
    await handler({
      sessionID,
      model: "openai/gpt-5.4",
      status: {
        type: "running",
        message: "Still working",
      },
    })

    // then
    expect(abortCalls).toEqual([])
    expect(sameModelRetryCalls).toEqual([])
    expect(retryCalls).toEqual([])
    expect(scheduleCalls).toEqual([
      {
        sessionID,
        source: "session.status.active",
        timeoutMsOverride: 120_000,
      },
    ])
    expect(deps.sessionLastAccess.has(sessionID)).toBe(true)
  })

  it("#given repeated active session.status pulses without new progress #when the second pulse arrives #then the watchdog is not extended again", async () => {
    const sessionID = "session-status-active-repeated-without-progress"
    const deps = createDeps()
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const sameModelRetryCalls: Array<{ sessionID: string; source: string; immediate: boolean; persistent?: boolean; resolvedAgent?: string }> = []
    const freshRetryCalls: Array<{ sessionID: string; source: string; resolvedAgent?: string }> = []
    const scheduleCalls: Array<{ sessionID: string; resolvedAgent?: string; source?: string; timeoutMsOverride?: number }> = []
    const state = createFallbackState("openai/gpt-5.4")
    deps.sessionStates.set(sessionID, state)

    const handler = createSessionStatusHandler(
      deps,
      createHelpers(abortCalls, retryCalls, sameModelRetryCalls, freshRetryCalls, scheduleCalls),
      deps.sessionStatusRetryKeys,
    )

    await handler({
      sessionID,
      model: "openai/gpt-5.4",
      status: {
        type: "running",
        message: "Still working",
      },
    })

    await handler({
      sessionID,
      model: "openai/gpt-5.4",
      status: {
        type: "running",
        message: "Still working",
      },
    })

    expect(abortCalls).toEqual([])
    expect(sameModelRetryCalls).toEqual([])
    expect(retryCalls).toEqual([])
    expect(scheduleCalls).toEqual([
      {
        sessionID,
        source: "session.status.active",
        timeoutMsOverride: 120_000,
      },
    ])
  })

  it("#given a request-not-allowed 403 retry status on a paid model #when the handler sees it #then it opens a fresh same-model handoff and emits a provider diagnostic log", async () => {
    const sessionID = "session-status-transient-forbidden"
    SessionCategoryRegistry.clear()
    SessionCategoryRegistry.register(sessionID, "test")
    const deps = createDeps()
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const sameModelRetryCalls: Array<{ sessionID: string; source: string; immediate: boolean; persistent?: boolean; resolvedAgent?: string }> = []
    const freshRetryCalls: Array<{ sessionID: string; source: string; resolvedAgent?: string }> = []
    const scheduleCalls: Array<{ sessionID: string; resolvedAgent?: string; source?: string; mode?: "fallback" | "transient_retry" }> = []
    const state = createFallbackState("anthropic/claude-opus-4-6")
    deps.sessionStates.set(sessionID, state)

    const handler = createSessionStatusHandler(
      deps,
      createHelpers(abortCalls, retryCalls, sameModelRetryCalls, freshRetryCalls, scheduleCalls, true),
      deps.sessionStatusRetryKeys,
    )

    await handler({
      sessionID,
      model: "anthropic/claude-opus-4-6",
      status: {
        type: "retry",
        attempt: 1,
        message: "403 Request not allowed [retrying in 10s attempt #1]",
      },
    })

    expect(abortCalls).toEqual([sessionID])
    expect(sameModelRetryCalls).toEqual([])
    expect(retryCalls).toEqual([])
    expect(freshRetryCalls).toEqual([
      {
        sessionID,
        resolvedAgent: undefined,
        source: "session.status",
      },
    ])
    expect(scheduleCalls).toEqual([])
    expect(state.currentModel).toBe("anthropic/claude-opus-4-6")

    const provider403Log = logCalls.find((call) => call.msg.includes("Observed tracked provider 403"))
    expect(provider403Log?.data).toMatchObject({
      sessionID,
      providerFamily: "claude",
      model: "anthropic/claude-opus-4-6",
      action: "retry_same_model_delayed",
      statusCode: 403,
    })
  })

  it("#given a paid 403 retry status after same-model retries are exhausted #when the handler sees it #then it opens a fresh paid handoff before the paid fallback chain", async () => {
    const sessionID = "session-status-transient-forbidden-fresh-handoff"
    const deps = createDeps()
    deps.pluginConfig = {
      agents: {
        "sisyphus-junior": {
          fallback_models: [
            "openai/gpt-5.4",
            "anthropic/claude-sonnet-4-6",
            "openai/gpt-5.3-codex-spark",
            "opencode/nemotron-3-super-free",
          ],
        },
      },
    }
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const sameModelRetryCalls: Array<{ sessionID: string; source: string; immediate: boolean; persistent?: boolean; resolvedAgent?: string; maxAttempts?: number }> = []
    const freshRetryCalls: Array<{ sessionID: string; source: string; resolvedAgent?: string }> = []
    const scheduleCalls: Array<{ sessionID: string; resolvedAgent?: string; source?: string; mode?: "fallback" | "transient_retry" }> = []
    const state = createFallbackState("openai/gpt-5.4")
    state.resolvedAgent = "sisyphus-junior"
    deps.sessionStates.set(sessionID, state)

    const handler = createSessionStatusHandler(
      deps,
      createHelpers(abortCalls, retryCalls, sameModelRetryCalls, freshRetryCalls, scheduleCalls, false),
      deps.sessionStatusRetryKeys,
    )

    await handler({
      sessionID,
      model: "openai/gpt-5.4",
      status: {
        type: "retry",
        attempt: 4,
        message: "403 Request not allowed [retrying in 10s attempt #4]",
      },
    })

    expect(abortCalls).toEqual([sessionID])
    expect(sameModelRetryCalls).toEqual([])
    expect(freshRetryCalls).toEqual([
      {
        sessionID,
        resolvedAgent: "sisyphus-junior",
        source: "session.status",
      },
    ])
    expect(retryCalls).toEqual([])
    expect(scheduleCalls).toEqual([])
  })

  it("#given a compaction spark quota retry after transient paid failures #when session.status handles it for sisyphus #then it preserves the paid chain instead of dropping to free", async () => {
    const sessionID = "session-status-compaction-spark-paid-preserve"
    const deps = createDeps()
    deps.pluginConfig = {
      agents: {
        "sisyphus-junior": {
          fallback_models: [
            "openai/gpt-5.4",
            "anthropic/claude-sonnet-4-6",
            "openai/gpt-5.3-codex-spark",
            "opencode/nemotron-3-super-free",
          ],
        },
      },
    }
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const sameModelRetryCalls: Array<{ sessionID: string; source: string; immediate: boolean; persistent?: boolean; resolvedAgent?: string; maxAttempts?: number }> = []
    const freshRetryCalls: Array<{ sessionID: string; source: string; resolvedAgent?: string }> = []
    const scheduleCalls: Array<{ sessionID: string; resolvedAgent?: string; source?: string; mode?: "fallback" | "transient_retry" }> = []
    const state = createFallbackState("openai/gpt-5.4")
    state.resolvedAgent = "sisyphus-junior"
    state.currentModel = "openai/gpt-5.3-codex-spark"
    state.failedModels.set("openai/gpt-5.4", Date.now())
    state.failedModels.set("anthropic/claude-sonnet-4-6", Date.now())
    deps.sessionStates.set(sessionID, state)

    const handler = createSessionStatusHandler(
      deps,
      createHelpers(abortCalls, retryCalls, sameModelRetryCalls, freshRetryCalls, scheduleCalls, false),
      deps.sessionStatusRetryKeys,
    )

    await handler({
      sessionID,
      agent: "compaction",
      model: "openai/gpt-5.3-codex-spark",
      status: {
        type: "retry",
        attempt: 1,
        message: "The usage limit has been reached [retrying in 10s attempt #1]",
      },
    })

    expect(abortCalls).toEqual([sessionID])
    expect(sameModelRetryCalls).toEqual([])
    expect(freshRetryCalls).toEqual([])
    expect(retryCalls).toEqual([
      {
        sessionID,
        model: "openai/gpt-5.4",
        source: "session.status.limit_fallback",
      },
    ])
    expect(scheduleCalls).toEqual([])
  })
})
