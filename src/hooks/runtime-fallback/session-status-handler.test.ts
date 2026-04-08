import { describe, expect, it } from "bun:test"
import type { HookDeps, RuntimeFallbackPluginInput } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { createFallbackState } from "./fallback-state"
import { createSessionStatusHandler } from "./session-status-handler"
import { SessionCategoryRegistry } from "../../shared/session-category-registry"

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
      cooldown_seconds: 60,
      timeout_seconds: 30,
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
    sessionRetryInFlight: new Set(),
    sessionAwaitingFallbackResult: new Set(),
    sessionFallbackTimeouts: new Map(),
    sessionStatusRetryKeys: new Map(),
  }
}

function createHelpers(
  abortCalls: string[],
  retryCalls: Array<{ sessionID: string; model: string; source: string }>,
  scheduleCalls: Array<{ sessionID: string; resolvedAgent?: string; source?: string }>,
): AutoRetryHelpers {
  return {
    abortSessionRequest: async (sessionID: string) => {
      abortCalls.push(sessionID)
    },
    clearSessionFallbackTimeout: () => {},
    scheduleSessionFallbackTimeout: (sessionID: string, args?: { resolvedAgent?: string; source?: string }) => {
      scheduleCalls.push({ sessionID, ...args })
    },
    autoRetryWithFallback: async (sessionID: string, model: string, _resolvedAgent: string | undefined, source: string) => {
      retryCalls.push({ sessionID, model, source })
    },
    resolveAgentForSessionFromContext: async () => undefined,
    cleanupStaleSessions: () => {},
  }
}

describe("createSessionStatusHandler", () => {
  it("#given a pending fallback model #when a new provider cooldown retry arrives #then the handler overrides the pending fallback and advances the chain", async () => {
    // given
    SessionCategoryRegistry.clear()
    const sessionID = "session-status-pending-fallback"
    SessionCategoryRegistry.register(sessionID, "test")

    const deps = createDeps()
    const abortCalls: string[] = []
    const retryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const scheduleCalls: Array<{ sessionID: string; resolvedAgent?: string; source?: string }> = []
    const state = createFallbackState("anthropic/claude-opus-4-6")
    state.currentModel = "openai/gpt-5.4"
    state.fallbackIndex = 0
    state.attemptCount = 1
    state.pendingFallbackModel = "openai/gpt-5.4"
    state.failedModels.set("anthropic/claude-opus-4-6", Date.now())
    deps.sessionStates.set(sessionID, state)

    const handler = createSessionStatusHandler(
      deps,
      createHelpers(abortCalls, retryCalls, scheduleCalls),
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
    expect(retryCalls).toEqual([
      {
        sessionID,
        model: "google/gemini-2.5-pro",
        source: "session.status",
      },
    ])
    expect(state.currentModel).toBe("google/gemini-2.5-pro")
    expect(state.pendingFallbackModel).toBe("google/gemini-2.5-pro")
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
    const scheduleCalls: Array<{ sessionID: string; resolvedAgent?: string; source?: string }> = []
    const state = createFallbackState("anthropic/claude-opus-4-6")
    deps.sessionStates.set(sessionID, state)

    const handler = createSessionStatusHandler(
      deps,
      createHelpers(abortCalls, retryCalls, scheduleCalls),
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
    expect(retryCalls).toEqual([
      {
        sessionID,
        model: "openai/gpt-5.4",
        source: "session.status",
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
    const scheduleCalls: Array<{ sessionID: string; resolvedAgent?: string; source?: string }> = []
    const state = createFallbackState("openai/gpt-5.4")
    deps.sessionStates.set(sessionID, state)

    const handler = createSessionStatusHandler(
      deps,
      createHelpers(abortCalls, retryCalls, scheduleCalls),
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
    expect(retryCalls).toEqual([])
    expect(scheduleCalls).toEqual([
      {
        sessionID,
        source: "session.status.active",
      },
    ])
    expect(deps.sessionLastAccess.has(sessionID)).toBe(true)
  })
})
