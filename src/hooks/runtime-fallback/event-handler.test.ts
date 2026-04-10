import { describe, expect, it } from "bun:test"
import type { HookDeps, RuntimeFallbackPluginInput } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { createFallbackState } from "./fallback-state"
import { createEventHandler } from "./event-handler"

type TestHelpers = AutoRetryHelpers & {
  __scheduleCallsForTest: Array<{ sessionID: string; source?: string; resolvedAgent?: string }>
}

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
      max_fallback_attempts: 3,
      max_full_chain_cycles: 5,
      cooldown_seconds: 60,
      timeout_seconds: 30,
      transient_retry_window_seconds: 900,
      transient_retry_initial_delay_seconds: 10,
      transient_retry_max_delay_seconds: 300,
      notify_on_fallback: false,
    },
    options: undefined,
    pluginConfig: {},
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

function createHelpers(deps: HookDeps, abortCalls: string[], clearCalls: string[]): TestHelpers {
  const scheduleCalls: Array<{ sessionID: string; source?: string; resolvedAgent?: string }> = []

  return {
    abortSessionRequest: async (sessionID: string) => {
      abortCalls.push(sessionID)
    },
    clearSessionFallbackTimeout: (sessionID: string) => {
      clearCalls.push(sessionID)
      deps.sessionFallbackTimeouts.delete(sessionID)
    },
    scheduleSessionFallbackTimeout: (sessionID: string, options?: { source?: string; resolvedAgent?: string }) => {
      scheduleCalls.push({ sessionID, source: options?.source, resolvedAgent: options?.resolvedAgent })
      deps.sessionFallbackTimeouts.set(sessionID, 1)
    },
    autoRetryWithFallback: async () => {},
    retryCurrentModel: async () => false,
    resolveAgentForSessionFromContext: async () => undefined,
    cleanupStaleSessions: () => {},
    recoverPreferredModels: async () => {},
    __scheduleCallsForTest: scheduleCalls,
  }
}

describe("createEventHandler", () => {
  it("#given a session retry dedupe key #when session.stop fires #then the retry dedupe key is cleared", async () => {
    // given
    const sessionID = "session-stop"
    const deps = createDeps()
    const abortCalls: string[] = []
    const clearCalls: string[] = []
    const state = createFallbackState("google/gemini-2.5-pro")
    state.pendingFallbackModel = "openai/gpt-5.4"
    deps.sessionStates.set(sessionID, state)
    deps.sessionRetryInFlight.add(sessionID)
    deps.sessionStatusRetryKeys.set(sessionID, "retry:1")
    const handler = createEventHandler(deps, createHelpers(deps, abortCalls, clearCalls))

    // when
    await handler({ event: { type: "session.stop", properties: { sessionID } } })

    // then
    expect(deps.sessionStatusRetryKeys.has(sessionID)).toBe(false)
    expect(clearCalls).toEqual([sessionID])
    expect(abortCalls).toEqual([sessionID])
  })

  it("#given a session retry dedupe key without a pending fallback result #when session.idle fires #then the retry dedupe key is cleared", async () => {
    // given
    const sessionID = "session-idle"
    const deps = createDeps()
    const abortCalls: string[] = []
    const clearCalls: string[] = []
    const state = createFallbackState("google/gemini-2.5-pro")
    state.pendingFallbackModel = "openai/gpt-5.4"
    deps.sessionStates.set(sessionID, state)
    deps.sessionRetryInFlight.add(sessionID)
    deps.sessionFallbackTimeouts.set(sessionID, 1)
    deps.sessionStatusRetryKeys.set(sessionID, "retry:1")
    const helpers = createHelpers(deps, abortCalls, clearCalls)
    const handler = createEventHandler(deps, helpers)

    // when
    await handler({ event: { type: "session.idle", properties: { sessionID } } })

    // then
    expect(deps.sessionStatusRetryKeys.has(sessionID)).toBe(false)
    expect(clearCalls).toEqual([sessionID])
    expect(abortCalls).toEqual([])
    expect(state.pendingFallbackModel).toBe(undefined)
    expect(helpers.__scheduleCallsForTest).toEqual([])
  })

  it("#given awaiting fallback without an armed timeout #when session.idle fires #then the timeout is re-armed instead of clearing the wait state", async () => {
    // given
    const sessionID = "session-idle-awaiting"
    const deps = createDeps()
    const abortCalls: string[] = []
    const clearCalls: string[] = []
    deps.sessionStates.set(sessionID, createFallbackState("google/gemini-2.5-pro"))
    deps.sessionAwaitingFallbackResult.add(sessionID)
    const helpers = createHelpers(deps, abortCalls, clearCalls)
    const handler = createEventHandler(deps, helpers)

    // when
    await handler({ event: { type: "session.idle", properties: { sessionID } } })

    // then
    expect(clearCalls).toEqual([])
    expect(abortCalls).toEqual([])
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(true)
    expect(helpers.__scheduleCallsForTest).toEqual([
      {
        sessionID,
        source: "session.idle.awaiting-fallback-rearm",
        resolvedAgent: undefined,
      },
    ])
  })
})
