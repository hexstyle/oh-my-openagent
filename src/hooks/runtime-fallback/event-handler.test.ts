import { describe, expect, it } from "bun:test"
import type { HookDeps, RuntimeFallbackPluginInput } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { createFallbackState } from "./fallback-state"
import { createEventHandler } from "./event-handler"

type TestHelpers = AutoRetryHelpers & {
  __scheduleCallsForTest: Array<{ sessionID: string; source?: string; resolvedAgent?: string; timeoutMsOverride?: number }>
  __retryCurrentModelCallsForTest: Array<{
    sessionID: string
    resolvedAgent?: string
    source: string
    immediate?: boolean
    persistent?: boolean
  }>
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
  const scheduleCalls: Array<{ sessionID: string; source?: string; resolvedAgent?: string; timeoutMsOverride?: number }> = []
  const retryCurrentModelCalls: Array<{
    sessionID: string
    resolvedAgent?: string
    source: string
    immediate?: boolean
    persistent?: boolean
  }> = []

  return {
    abortSessionRequest: async (sessionID: string) => {
      abortCalls.push(sessionID)
    },
    clearSessionFallbackTimeout: (sessionID: string) => {
      clearCalls.push(sessionID)
      deps.sessionFallbackTimeouts.delete(sessionID)
    },
    scheduleSessionFallbackTimeout: (
      sessionID: string,
      options?: { source?: string; resolvedAgent?: string; timeoutMsOverride?: number },
    ) => {
      scheduleCalls.push({
        sessionID,
        source: options?.source,
        resolvedAgent: options?.resolvedAgent,
        ...(options?.timeoutMsOverride !== undefined ? { timeoutMsOverride: options.timeoutMsOverride } : {}),
      })
      deps.sessionFallbackTimeouts.set(sessionID, 1)
    },
    autoRetryWithFallback: async () => {},
    retryCurrentModel: async (sessionID, resolvedAgent, source, options) => {
      retryCurrentModelCalls.push({
        sessionID,
        resolvedAgent,
        source,
        immediate: options?.immediate,
        persistent: options?.persistent,
      })
      return false
    },
    resolveAgentForSessionFromContext: async () => undefined,
    cleanupStaleSessions: () => {},
    recoverPreferredModels: async () => {},
    __scheduleCallsForTest: scheduleCalls,
    __retryCurrentModelCallsForTest: retryCurrentModelCalls,
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

  it("#given a delayed transient retry is pending #when session.idle fires #then the retry state is preserved", async () => {
    // given
    const sessionID = "session-idle-transient-retry"
    const deps = createDeps()
    const abortCalls: string[] = []
    const clearCalls: string[] = []
    const state = createFallbackState("anthropic/claude-opus-4-6")
    state.pendingTransientRetry = true
    deps.sessionStates.set(sessionID, state)
    deps.sessionTransientRetryTimeouts.set(sessionID, 1)
    deps.sessionStatusRetryKeys.set(sessionID, "retry:1")
    const helpers = createHelpers(deps, abortCalls, clearCalls)
    const handler = createEventHandler(deps, helpers)

    // when
    await handler({ event: { type: "session.idle", properties: { sessionID } } })

    // then
    expect(clearCalls).toEqual([])
    expect(abortCalls).toEqual([])
    expect(state.pendingTransientRetry).toBe(true)
    expect(deps.sessionTransientRetryTimeouts.has(sessionID)).toBe(true)
    expect(deps.sessionStatusRetryKeys.get(sessionID)).toBe("retry:1")
  })

  describe("#given an armed active-session watchdog", () => {
    const progressCases: Array<{
      name: string
      properties: Record<string, unknown>
    }> = [
      {
        name: "tool parts",
        properties: {
          part: {
            sessionID: "session-progress-tool",
            type: "tool",
            tool: "data_catalog",
            state: { status: "running" },
          },
        },
      },
      {
        name: "pending task delegation parts",
        properties: {
          part: {
            sessionID: "session-progress-task-pending",
            type: "tool",
            tool: "task",
            state: { status: "pending" },
          },
        },
      },
      {
        name: "pending omo delegation parts",
        properties: {
          part: {
            sessionID: "session-progress-call-omo-pending",
            type: "tool",
            tool: "call_omo_agent",
            state: { status: "pending" },
          },
        },
      },
      {
        name: "todowrite terminal parts",
        properties: {
          part: {
            sessionID: "session-progress-todowrite-terminal",
            type: "tool",
            tool: "todowrite",
            state: { status: "error" },
          },
        },
      },
      {
        name: "tool_use parts",
        properties: {
          part: {
            sessionID: "session-progress-tool-use",
            type: "tool_use",
          },
        },
      },
      {
        name: "tool_result parts",
        properties: {
          part: {
            sessionID: "session-progress-tool-result",
            type: "tool_result",
          },
        },
      },
      {
        name: "text deltas",
        properties: {
          sessionID: "session-progress-text",
          field: "text",
          delta: "next token",
          part: {
            sessionID: "session-progress-text",
            type: "text",
          },
        },
      },
      {
        name: "reasoning text parts",
        properties: {
          part: {
            sessionID: "session-progress-reasoning",
            type: "reasoning",
            text: "thinking...",
          },
        },
      },
      {
        name: "compaction parts",
        properties: {
          part: {
            sessionID: "session-progress-compaction",
            type: "compaction",
          },
        },
      },
    ]

    for (const progressCase of progressCases) {
      it(`#when ${progressCase.name} arrive #then the watchdog is refreshed instead of cleared`, async () => {
        const sessionID = String(
          ((progressCase.properties.part as Record<string, unknown> | undefined)?.sessionID)
          ?? progressCase.properties.sessionID,
        )
        const deps = createDeps()
        const abortCalls: string[] = []
        const clearCalls: string[] = []
        deps.sessionStates.set(sessionID, createFallbackState("anthropic/claude-opus-4-6"))
        deps.sessionFallbackTimeouts.set(sessionID, 1)
        const helpers = createHelpers(deps, abortCalls, clearCalls)
        const handler = createEventHandler(deps, helpers)

        await handler({
          event: {
            type: "message.part.updated",
            properties: progressCase.properties,
          },
        })

        expect(clearCalls).toEqual([])
        expect(abortCalls).toEqual([])
        expect(helpers.__scheduleCallsForTest).toEqual([
          {
            sessionID,
            source: "message.part.updated.progress",
            resolvedAgent: undefined,
            ...((() => {
              const part = progressCase.properties.part as Record<string, unknown> | undefined
              const type = part?.type
              const status = (part?.state as { status?: string } | undefined)?.status
              const toolName = typeof part?.tool === "string" ? part.tool : undefined
              const isLongRunning =
                type === "compaction"
                || type === "tool_use"
                || type === "tool-call"
                || (
                  type === "tool" && (
                    status === "running"
                    || (
                      status === "pending"
                      && ["task", "call_omo_agent"].includes(toolName ?? "")
                    )
                    || (
                      (status === "completed" || status === "error")
                      && ["write", "apply_patch", "todowrite"].includes(toolName ?? "")
                    )
                  )
                )
              return isLongRunning
              ? { timeoutMsOverride: 120_000 }
              : {}
            })()),
          },
        ])
      })
    }

    it("#when a local tool abort progress part arrives #then the handler arms a persistent same-model retry", async () => {
      const sessionID = "session-progress-local-tool-abort"
      const deps = createDeps()
      const abortCalls: string[] = []
      const clearCalls: string[] = []
      deps.sessionStates.set(sessionID, createFallbackState("anthropic/claude-opus-4-6"))
      const helpers = createHelpers(deps, abortCalls, clearCalls)
      const handler = createEventHandler(deps, helpers)

      await handler({
        event: {
          type: "message.part.updated",
          properties: {
            info: { sessionID, role: "assistant", agent: "Prometheus (Plan Builder)" },
            part: {
              sessionID,
              type: "tool",
              tool: "question",
              state: {
                status: "error",
                error: "Tool execution aborted",
              },
            },
          },
        },
      })

      expect(abortCalls).toEqual([])
      expect(clearCalls).toEqual([])
      expect(helpers.__scheduleCallsForTest).toEqual([
        {
          sessionID,
          source: "message.part.updated.progress",
          resolvedAgent: undefined,
        },
      ])
      expect(helpers.__retryCurrentModelCallsForTest).toEqual([
        {
          sessionID,
          resolvedAgent: undefined,
          source: "message.part.updated.tool-error",
          immediate: false,
          persistent: true,
        },
      ])
    })
  })
})
