import { describe, expect, it } from "bun:test"
import type { AutoRetryHelpers } from "./auto-retry"
import { createFallbackState } from "./fallback-state"
import { createLoopDetector } from "./internal-continuation-loop-detector"
import type { HookDeps, RuntimeFallbackPluginInput } from "./types"
import { OMO_INTERNAL_INITIATOR_MARKER } from "../../shared/internal-initiator-marker"
import { hasVisibleAssistantResponse } from "./visible-assistant-response"
import { extractAutoRetrySignal } from "./error-classifier"

const WATCHDOG_CONTINUATION_PROMPT = "Continue the current task from where you left off. The previous request appears stalled. Resume from the existing context, do not redo completed work, and continue."

function createLoopDetectorSpy() {
  return {
    internalContinuationCalls: [] as string[],
    visibleResponseCalls: [] as string[],
    resetCalls: [] as string[],
    recordInternalContinuation(sessionID: string) {
      this.internalContinuationCalls.push(sessionID)
      return { count: this.internalContinuationCalls.length, isTerminal: false }
    },
    recordVisibleResponse(sessionID: string) {
      this.visibleResponseCalls.push(sessionID)
    },
    reset(sessionID: string) {
      this.resetCalls.push(sessionID)
    },
  }
}

function createContext(messagesResponse: unknown): RuntimeFallbackPluginInput {
  return {
    client: {
      session: {
        abort: async () => ({}),
        messages: async () => messagesResponse,
        promptAsync: async () => ({}),
      },
      tui: {
        showToast: async () => ({}),
      },
    },
    directory: "/test/dir",
  }
}

function createDeps(messagesResponse: unknown): HookDeps {
  return {
    ctx: createContext(messagesResponse),
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
    pluginConfig: {
      git_master: {
        commit_footer: false,
        include_co_authored_by: false,
        git_env_prefix: "",
      },
    },
    loopDetector: createLoopDetector(),
    sessionStates: new Map(),
    sessionLastAccess: new Map(),
    sessionLastUserMessageIDs: new Map(),
    sessionRecentCompletionUntil: new Map(),
    sessionRecentActiveStatusUntil: new Map(),
    sessionRetryInFlight: new Set(),
    sessionAwaitingFallbackResult: new Set(),
    sessionFallbackTimeouts: new Map(),
    sessionTransientRetryTimeouts: new Map(),
    sessionStatusRetryKeys: new Map(),
  }
}

function createHelpers(
  scheduleCalls: Array<{ sessionID: string; timeoutMsOverride?: number }>,
): AutoRetryHelpers {
  return {
    abortSessionRequest: async () => {},
    clearSessionFallbackTimeout: () => {},
    scheduleSessionFallbackTimeout: (
      sessionID: string,
      args?: { timeoutMsOverride?: number },
    ) => {
      scheduleCalls.push({
        sessionID,
        ...(args?.timeoutMsOverride !== undefined ? { timeoutMsOverride: args.timeoutMsOverride } : {}),
      })
    },
    autoRetryWithFallback: async () => {},
    retryCurrentModel: async () => false,
    resolveAgentForSessionFromContext: async () => undefined,
    cleanupStaleSessions: () => {},
    recoverPreferredModels: async () => {},
  }
}

describe("hasVisibleAssistantResponse", () => {
  it("#given only an old assistant reply before the latest user turn #when visibility is checked #then the stale reply is ignored", async () => {
    // given
    const checkVisibleResponse = hasVisibleAssistantResponse(() => undefined)
    const ctx = createContext({
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "older question" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "older answer" }] },
        { info: { role: "user" }, parts: [{ type: "text", text: "latest question" }] },
      ],
    })

    // when
    const result = await checkVisibleResponse(ctx, "session-old-assistant", undefined)

    // then
    expect(result).toBe(false)
  })

  it("#given an assistant reply after the latest user turn #when visibility is checked #then the current reply is treated as visible", async () => {
    // given
    const checkVisibleResponse = hasVisibleAssistantResponse(() => undefined)
    const ctx = createContext({
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "latest question" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "visible answer" }] },
      ],
    })

    // when
    const result = await checkVisibleResponse(ctx, "session-visible-assistant", undefined)

    // then
    expect(result).toBe(true)
  })

  it("#given a too-many-requests assistant reply #when visibility is checked #then it is treated as an auto-retry signal", async () => {
    // given
    const checkVisibleResponse = hasVisibleAssistantResponse(extractAutoRetrySignal)
    const ctx = createContext({
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "latest question" }] },
        {
          info: { role: "assistant" },
          parts: [
            {
              type: "text",
              text: "Too Many Requests: Sorry, you've exhausted this model's rate limit. Please try a different model.",
            },
          ],
        },
      ],
    })

    // when
    const result = await checkVisibleResponse(ctx, "session-rate-limit", undefined)

    // then
    expect(result).toBe(false)
  })

  it("#given an assistant tool call after the latest user turn #when visibility is checked #then the current reply is treated as visible", async () => {
    // given
    const checkVisibleResponse = hasVisibleAssistantResponse(() => undefined)
    const ctx = createContext({
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "latest question" }] },
        { info: { role: "assistant" }, parts: [{ type: "tool_use" }] },
      ],
    })

    // when
    const result = await checkVisibleResponse(ctx, "session-visible-tool-call", undefined)

    // then
    expect(result).toBe(true)
  })
})

describe("createMessageUpdateHandler internal initiator watchdog skip", () => {
  it("#given a user internal initiator message #when message.updated is handled #then watchdog state is not re-armed or reset", async () => {
    const { createMessageUpdateHandler } = await import(`./message-update-handler?internal-initiator-${Date.now()}-${Math.random()}`)
    const sessionID = "session-internal-initiator"
    const scheduleCalls: Array<{ sessionID: string; timeoutMsOverride?: number }> = []
    const deps = createDeps({ data: [] })
    const state = createFallbackState("openai/gpt-5.4")
    deps.sessionLastAccess.set(sessionID, 4242)
    deps.sessionRecentCompletionUntil.set(sessionID, 999999)
    state.stoppedAt = 123456789
    deps.sessionStates.set(sessionID, state)
    deps.sessionAwaitingFallbackResult.add(sessionID)
    deps.sessionStatusRetryKeys.set(sessionID, "retry:internal")
    deps.sessionLastUserMessageIDs.set(sessionID, "existing-user-message")
    const handler = createMessageUpdateHandler(deps, createHelpers(scheduleCalls))

    await handler({
      info: {
        id: "msg-internal-initiator",
        sessionID,
        role: "user",
      },
      parts: [{ type: "text", text: `Continue from where you left off.\n${OMO_INTERNAL_INITIATOR_MARKER}` }],
    })

    expect(state.stoppedAt).toBe(123456789)
    expect(scheduleCalls).toEqual([])
    expect(deps.sessionLastAccess.get(sessionID)).toBe(4242)
    expect(deps.sessionRecentCompletionUntil.get(sessionID)).toBe(999999)
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(true)
    expect(deps.sessionStatusRetryKeys.get(sessionID)).toBe("retry:internal")
    expect(deps.sessionLastUserMessageIDs.get(sessionID)).toBe("existing-user-message")
  })

  it("#given a raw watchdog continuation user message #when message.updated is handled #then watchdog state is not re-armed or reset", async () => {
    const { createMessageUpdateHandler } = await import(`./message-update-handler?watchdog-initiator-${Date.now()}-${Math.random()}`)
    const sessionID = "session-watchdog-initiator"
    const scheduleCalls: Array<{ sessionID: string; timeoutMsOverride?: number }> = []
    const deps = createDeps({ data: [] })
    const state = createFallbackState("openai/gpt-5.4")
    deps.sessionLastAccess.set(sessionID, 4242)
    deps.sessionRecentCompletionUntil.set(sessionID, 999999)
    state.stoppedAt = 123456789
    deps.sessionStates.set(sessionID, state)
    deps.sessionAwaitingFallbackResult.add(sessionID)
    deps.sessionStatusRetryKeys.set(sessionID, "retry:watchdog")
    deps.sessionLastUserMessageIDs.set(sessionID, "existing-user-message")
    const handler = createMessageUpdateHandler(deps, createHelpers(scheduleCalls))

    await handler({
      info: {
        id: "msg-watchdog-initiator",
        sessionID,
        role: "user",
      },
      parts: [{ type: "text", text: WATCHDOG_CONTINUATION_PROMPT }],
    })

    expect(state.stoppedAt).toBe(123456789)
    expect(scheduleCalls).toEqual([])
    expect(deps.sessionLastAccess.get(sessionID)).toBe(4242)
    expect(deps.sessionRecentCompletionUntil.get(sessionID)).toBe(999999)
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(true)
    expect(deps.sessionStatusRetryKeys.get(sessionID)).toBe("retry:watchdog")
    expect(deps.sessionLastUserMessageIDs.get(sessionID)).toBe("existing-user-message")
  })

  it("#given a fallback-generated user update without parts #when message.updated is handled #then awaiting fallback state is preserved", async () => {
    const { createMessageUpdateHandler } = await import(`./message-update-handler?fallback-user-no-parts-${Date.now()}-${Math.random()}`)
    const sessionID = "session-fallback-user-no-parts"
    const scheduleCalls: Array<{ sessionID: string; timeoutMsOverride?: number }> = []
    const deps = createDeps({ data: [] })
    const loopDetector = createLoopDetectorSpy()
    deps.loopDetector = loopDetector
    const state = createFallbackState("openai/gpt-5.4")
    state.currentModel = "anthropic/claude-sonnet-4-6"
    state.pendingFallbackModel = "anthropic/claude-sonnet-4-6"
    state.stoppedAt = 123456789
    deps.sessionStates.set(sessionID, state)
    deps.sessionLastAccess.set(sessionID, 4242)
    deps.sessionRecentCompletionUntil.set(sessionID, 999999)
    deps.sessionAwaitingFallbackResult.add(sessionID)
    deps.sessionStatusRetryKeys.set(sessionID, "retry:fallback-user")
    deps.sessionLastUserMessageIDs.set(sessionID, "existing-user-message")
    const handler = createMessageUpdateHandler(deps, createHelpers(scheduleCalls))

    await handler({
      info: {
        id: "msg-fallback-user-no-parts",
        sessionID,
        role: "user",
        providerID: "anthropic",
        modelID: "claude-sonnet-4-6",
      },
    })

    expect(state.stoppedAt).toBe(123456789)
    expect(scheduleCalls).toEqual([])
    expect(deps.sessionLastAccess.get(sessionID)).toBe(4242)
    expect(deps.sessionRecentCompletionUntil.get(sessionID)).toBe(999999)
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(true)
    expect(deps.sessionStatusRetryKeys.get(sessionID)).toBe("retry:fallback-user")
    expect(deps.sessionLastUserMessageIDs.get(sessionID)).toBe("existing-user-message")
    expect(loopDetector.internalContinuationCalls).toEqual([sessionID])
    expect(loopDetector.resetCalls).toEqual([])
  })

  it("#given a visible assistant update #when message.updated is handled #then only visible assistant reset is recorded", async () => {
    const { createMessageUpdateHandler } = await import(`./message-update-handler?visible-reset-${Date.now()}-${Math.random()}`)
    const sessionID = "session-visible-assistant-reset"
    const scheduleCalls: Array<{ sessionID: string; timeoutMsOverride?: number }> = []
    const deps = createDeps({ data: [] })
    const loopDetector = createLoopDetectorSpy()
    deps.loopDetector = loopDetector
    deps.sessionStates.set(sessionID, createFallbackState("openai/gpt-5.4"))
    deps.sessionAwaitingFallbackResult.add(sessionID)
    const handler = createMessageUpdateHandler(deps, createHelpers(scheduleCalls))

    await handler({
      info: {
        id: "msg-visible-assistant",
        sessionID,
        role: "assistant",
        message: "Visible assistant progress.",
      },
    })

    expect(loopDetector.visibleResponseCalls).toEqual([sessionID])
    expect(loopDetector.resetCalls).toEqual([])
    expect(loopDetector.internalContinuationCalls).toEqual([])
  })

  it("#given a fresh real user turn #when message.updated is handled #then only real user reset is recorded", async () => {
    const { createMessageUpdateHandler } = await import(`./message-update-handler?real-user-reset-${Date.now()}-${Math.random()}`)
    const sessionID = "session-real-user-reset"
    const scheduleCalls: Array<{ sessionID: string; timeoutMsOverride?: number }> = []
    const deps = createDeps({ data: [] })
    const loopDetector = createLoopDetectorSpy()
    deps.loopDetector = loopDetector
    deps.sessionStates.set(sessionID, createFallbackState("openai/gpt-5.4"))
    const handler = createMessageUpdateHandler(deps, createHelpers(scheduleCalls))

    await handler({
      info: {
        id: "msg-real-user",
        sessionID,
        role: "user",
        providerID: "openai",
        modelID: "gpt-5.4",
      },
    })

    expect(loopDetector.resetCalls).toEqual([sessionID])
    expect(loopDetector.visibleResponseCalls).toEqual([])
    expect(loopDetector.internalContinuationCalls).toEqual([])
  })

  it("#given a recent active session.status marker #when an empty assistant update arrives #then watchdog keeps the extended quiet window", async () => {
    const { createMessageUpdateHandler } = await import(`./message-update-handler?recent-active-status-${Date.now()}-${Math.random()}`)
    const sessionID = "session-recent-active-status"
    const scheduleCalls: Array<{ sessionID: string; timeoutMsOverride?: number }> = []
    const deps = createDeps({
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "Reply with OK only." }] },
      ],
    })
    deps.sessionStates.set(sessionID, createFallbackState("anthropic/claude-opus-4-6"))
    deps.sessionRecentActiveStatusUntil?.set(sessionID, Date.now() + 5_000)
    const handler = createMessageUpdateHandler(deps, createHelpers(scheduleCalls))

    await handler({
      info: {
        id: "msg-empty-assistant",
        sessionID,
        role: "assistant",
        agent: "Prometheus (Plan Builder)",
        model: {
          providerID: "anthropic",
          modelID: "claude-opus-4-6",
        },
      },
    })

    expect(scheduleCalls).toEqual([{ sessionID, timeoutMsOverride: 120_000 }])
  })

  it("#given a second empty assistant update #when no first token has arrived yet #then watchdog upgrades to the extended quiet window", async () => {
    const { createMessageUpdateHandler } = await import(`./message-update-handler?second-empty-assistant-${Date.now()}-${Math.random()}`)
    const sessionID = "session-second-empty-assistant"
    const scheduleCalls: Array<{ sessionID: string; timeoutMsOverride?: number }> = []
    const deps = createDeps({
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "Reply with OK only." }] },
      ],
    })
    deps.sessionStates.set(sessionID, createFallbackState("anthropic/claude-opus-4-6"))
    deps.sessionSilentAssistantUpdateCounts = new Map()
    const handler = createMessageUpdateHandler(deps, createHelpers(scheduleCalls))

    await handler({
      info: {
        id: "msg-empty-assistant-1",
        sessionID,
        role: "assistant",
        agent: "Prometheus (Plan Builder)",
        model: {
          providerID: "anthropic",
          modelID: "claude-opus-4-6",
        },
      },
    })

    await handler({
      info: {
        id: "msg-empty-assistant-2",
        sessionID,
        role: "assistant",
        agent: "Prometheus (Plan Builder)",
        model: {
          providerID: "anthropic",
          modelID: "claude-opus-4-6",
        },
      },
    })

    expect(scheduleCalls).toEqual([
      { sessionID },
      { sessionID, timeoutMsOverride: 120_000 },
    ])
  })
})
