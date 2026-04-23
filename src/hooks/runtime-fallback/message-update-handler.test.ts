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
    sessionScopedFallbackHints: new Map(),
    sessionRetryInFlight: new Set(),
    sessionAwaitingFallbackResult: new Set(),
    sessionFallbackTimeouts: new Map(),
    sessionTransientRetryTimeouts: new Map(),
    sessionStatusRetryKeys: new Map(),
  }
}

function createHelpers(
  scheduleCalls: Array<{ sessionID: string; timeoutMsOverride?: number }>,
  clearCallsOrOverrides?: string[] | Partial<AutoRetryHelpers>,
  clearTransientCallsOrOverrides?: string[] | Partial<AutoRetryHelpers>,
  overridesArg?: Partial<AutoRetryHelpers>,
): AutoRetryHelpers {
  const clearCalls = Array.isArray(clearCallsOrOverrides) ? clearCallsOrOverrides : undefined
  const clearTransientCalls = Array.isArray(clearTransientCallsOrOverrides) ? clearTransientCallsOrOverrides : undefined
  const overrides = (
    Array.isArray(clearCallsOrOverrides)
      ? overridesArg
      : clearCallsOrOverrides
  ) ?? {}

  return {
    abortSessionRequest: async () => {},
    clearSessionTransientRetryTimeout: (sessionID: string) => {
      clearTransientCalls?.push(sessionID)
    },
    clearSessionFallbackTimeout: (sessionID: string) => {
      clearCalls?.push(sessionID)
      clearTransientCalls?.push(sessionID)
    },
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
    retryCurrentModelInFreshSession: async () => false,
    resolveAgentForSessionFromContext: async () => undefined,
    cleanupStaleSessions: () => {},
    recoverPreferredModels: async () => {},
    ...overrides,
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

  it("#given a prior visible assistant reply and a new current assistant turn without persisted content #when visibility is checked for the current assistant message id #then the stale prior reply does not count", async () => {
    // given
    const checkVisibleResponse = hasVisibleAssistantResponse(() => undefined)
    const ctx = createContext({
      data: [
        { info: { id: "msg-user", role: "user" }, parts: [{ type: "text", text: "latest question" }] },
        { info: { id: "msg-assistant-visible", role: "assistant" }, parts: [{ type: "text", text: "previous visible planning text" }] },
        { info: { id: "msg-assistant-current", role: "assistant" } },
      ],
    })

    // when
    const result = await checkVisibleResponse(ctx, "session-current-assistant-only", {
      id: "msg-assistant-current",
      role: "assistant",
    })

    // then
    expect(result).toBe(false)
  })
})

describe("createMessageUpdateHandler internal initiator watchdog skip", () => {
  it("#given a real user message #when message.updated is handled #then the canonical retry brief is stored on session state", async () => {
    const { createMessageUpdateHandler } = await import(`./message-update-handler?canonical-retry-brief-${Date.now()}-${Math.random()}`)
    const sessionID = "session-canonical-retry-brief"
    const scheduleCalls: Array<{ sessionID: string; timeoutMsOverride?: number }> = []
    const deps = createDeps({ data: [] })
    const state = createFallbackState("openai/gpt-5.4")
    deps.sessionStates.set(sessionID, state)
    const handler = createMessageUpdateHandler(deps, createHelpers(scheduleCalls))

    await handler({
      info: {
        id: "msg-real-user",
        sessionID,
        role: "user",
      },
      parts: [{ type: "text", text: "Keep the original eurochemeopt CI request." }],
    })

    expect(state.canonicalRetryParts).toEqual([
      { type: "text", text: "Keep the original eurochemeopt CI request." },
    ])
    expect(scheduleCalls).toHaveLength(1)
  })

  it("#given a title-only scoped child with a hinted parent brief #when a silent assistant bootstrap happens #then the child inherits the canonical retry brief from the parent", async () => {
    const { createMessageUpdateHandler } = await import(`./message-update-handler?hinted-parent-brief-${Date.now()}-${Math.random()}`)
    const parentSessionID = "session-parent-canonical-brief"
    const childSessionID = "session-child-canonical-brief"
    const scheduleCalls: Array<{ sessionID: string; timeoutMsOverride?: number }> = []
    const deps = createDeps({ data: [] })
    const parentState = createFallbackState("anthropic/claude-opus-4-6")
    parentState.canonicalRetryParts = [{ type: "text", text: "\"/start-work ci-green-final\"" }]
    deps.sessionStates.set(parentSessionID, parentState)
    deps.sessionScopedFallbackHints?.set(childSessionID, {
      isScopedFallbackChild: true,
      parentSessionID,
    })
    const handler = createMessageUpdateHandler(deps, createHelpers(scheduleCalls))

    await handler({
      info: {
        id: "msg-silent-assistant-bootstrap",
        sessionID: childSessionID,
        role: "assistant",
        agent: "Prometheus (Plan Builder)",
        model: {
          providerID: "anthropic",
          modelID: "claude-opus-4-6",
        },
      },
    })

    expect(deps.sessionStates.get(childSessionID)?.canonicalRetryParts).toEqual([
      { type: "text", text: "\"/start-work ci-green-final\"" },
    ])
    expect(scheduleCalls).toHaveLength(1)
  })

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
    state.canonicalRetryParts = [{ type: "text", text: "keep the original user brief" }]
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
    expect(state.canonicalRetryParts).toEqual([{ type: "text", text: "keep the original user brief" }])
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

  it("#given a scoped fallback child visible assistant update while the parent awaits fallback #when message.updated is handled #then the parent watchdog is refreshed too", async () => {
    const { createMessageUpdateHandler } = await import(`./message-update-handler?visible-awaiting-parent-${Date.now()}-${Math.random()}`)
    const parentSessionID = "session-visible-parent-awaiting"
    const childSessionID = "session-visible-scoped-child"
    const scheduleCalls: Array<{ sessionID: string; timeoutMsOverride?: number }> = []
    const deps = createDeps({ data: [] })
    deps.sessionStates.set(parentSessionID, createFallbackState("anthropic/claude-opus-4-6"))
    const childState = createFallbackState("openai/gpt-5.4")
    childState.isScopedFallbackChild = true
    childState.scopedFallbackParentSessionID = parentSessionID
    deps.sessionStates.set(childSessionID, childState)
    deps.sessionAwaitingFallbackResult.add(parentSessionID)
    deps.sessionRecentActiveStatusUntil.set(childSessionID, Date.now() + 1_000)
    const handler = createMessageUpdateHandler(deps, createHelpers(scheduleCalls))

    await handler({
      info: {
        id: "msg-visible-awaiting-parent",
        sessionID: childSessionID,
        role: "assistant",
        message: "Visible assistant progress.",
      },
    })

    expect(scheduleCalls).toEqual([
      { sessionID: childSessionID, timeoutMsOverride: 120_000 },
      { sessionID: parentSessionID, timeoutMsOverride: 120_000 },
    ])
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

  it("#given a delayed transient retry and visible assistant progress #when the response is still non-terminal #then the retry timer is cleared but the extended watchdog window is preserved", async () => {
    const { createMessageUpdateHandler } = await import(`./message-update-handler?clear-transient-visible-progress-${Date.now()}-${Math.random()}`)
    const sessionID = "session-visible-progress-clears-transient"
    const scheduleCalls: Array<{ sessionID: string; timeoutMsOverride?: number }> = []
    const clearCalls: string[] = []
    const clearTransientCalls: string[] = []
    const deps = createDeps({ data: [] })
    const state = createFallbackState("anthropic/claude-opus-4-6")
    state.pendingTransientRetry = true
    deps.sessionStates.set(sessionID, state)
    deps.sessionRecentActiveStatusUntil?.set(sessionID, Date.now() + 5_000)
    const handler = createMessageUpdateHandler(
      deps,
      createHelpers(scheduleCalls, clearCalls, clearTransientCalls),
    )

    await handler({
      info: {
        id: "msg-visible-progress",
        sessionID,
        role: "assistant",
        finish: "tool-calls",
        agent: "Prometheus (Plan Builder)",
        model: {
          providerID: "anthropic",
          modelID: "claude-opus-4-6",
        },
      },
      parts: [{ type: "text", text: "Working through the result now." }],
    })

    expect(clearTransientCalls).toEqual([sessionID])
    expect(clearCalls).toEqual([])
    expect(scheduleCalls).toEqual([{ sessionID, timeoutMsOverride: 120_000 }])
    expect(state.pendingTransientRetry).toBe(false)
  })

  it("#given a delayed transient retry and a terminal assistant response #when message.updated sees finish=stop #then it clears the retry timer and the fallback timeout instead of preserving the active window", async () => {
    const { createMessageUpdateHandler } = await import(`./message-update-handler?terminal-finish-clears-retry-${Date.now()}-${Math.random()}`)
    const sessionID = "session-terminal-finish-clears-retry"
    const scheduleCalls: Array<{ sessionID: string; timeoutMsOverride?: number }> = []
    const clearCalls: string[] = []
    const clearTransientCalls: string[] = []
    const deps = createDeps({ data: [] })
    const state = createFallbackState("anthropic/claude-opus-4-6")
    state.pendingTransientRetry = true
    deps.sessionStates.set(sessionID, state)
    deps.sessionRecentActiveStatusUntil?.set(sessionID, Date.now() + 5_000)
    const handler = createMessageUpdateHandler(
      deps,
      createHelpers(scheduleCalls, clearCalls, clearTransientCalls),
    )

    await handler({
      info: {
        id: "msg-terminal-finish",
        sessionID,
        role: "assistant",
        finish: "stop",
        agent: "Prometheus (Plan Builder)",
        model: {
          providerID: "anthropic",
          modelID: "claude-opus-4-6",
        },
      },
      parts: [{ type: "text", text: "All research is complete." }],
    })

    expect(clearTransientCalls).toEqual([sessionID, sessionID])
    expect(clearCalls).toEqual([sessionID])
    expect(scheduleCalls).toEqual([])
    expect(state.pendingTransientRetry).toBe(false)
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

  it("#given prior meaningful progress #when an empty assistant update arrives #then watchdog is not re-armed again", async () => {
    const { createMessageUpdateHandler } = await import(`./message-update-handler?silent-after-progress-${Date.now()}-${Math.random()}`)
    const sessionID = "session-silent-after-progress"
    const scheduleCalls: Array<{ sessionID: string; timeoutMsOverride?: number }> = []
    const deps = createDeps({
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "continue" }] },
      ],
    })
    const state = createFallbackState("openai/gpt-5.4")
    state.lastMeaningfulProgressAt = Date.now()
    deps.sessionStates.set(sessionID, state)
    deps.sessionSilentAssistantUpdateCounts = new Map([[sessionID, 1]])
    const handler = createMessageUpdateHandler(deps, createHelpers(scheduleCalls))

    await handler({
      info: {
        id: "msg-empty-after-progress",
        sessionID,
        role: "assistant",
        agent: "Sisyphus Junior (Focused Executor)",
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
      },
    })

    expect(scheduleCalls).toEqual([])
    expect(deps.sessionSilentAssistantUpdateCounts?.has(sessionID)).toBe(false)
  })

  it("#given a previous visible assistant step and a new empty current assistant step #when message.updated is handled for the current message id #then the fallback timeout stays armed for the current turn", async () => {
    const { createMessageUpdateHandler } = await import(`./message-update-handler?current-turn-visibility-${Date.now()}-${Math.random()}`)
    const sessionID = "session-current-turn-visibility"
    const scheduleCalls: Array<{ sessionID: string; timeoutMsOverride?: number }> = []
    const clearCalls: string[] = []
    const deps = createDeps({
      data: [
        { info: { id: "msg-user", role: "user" }, parts: [{ type: "text", text: "create the plan" }] },
        { info: { id: "msg-previous-visible", role: "assistant" }, parts: [{ type: "text", text: "I have synthesized the prior artifacts." }] },
        { info: { id: "msg-current-empty", role: "assistant" } },
      ],
    })
    deps.sessionStates.set(sessionID, createFallbackState("anthropic/claude-opus-4-6"))
    deps.sessionRecentActiveStatusUntil?.set(sessionID, Date.now() + 5_000)
    const handler = createMessageUpdateHandler(
      deps,
      createHelpers(scheduleCalls, clearCalls),
    )

    await handler({
      info: {
        id: "msg-current-empty",
        sessionID,
        role: "assistant",
        agent: "Prometheus (Plan Builder)",
        model: {
          providerID: "anthropic",
          modelID: "claude-opus-4-6",
        },
      },
    })

    expect(clearCalls).toEqual([])
    expect(scheduleCalls).toEqual([{ sessionID, timeoutMsOverride: 120_000 }])
  })

  it("#given a pending fallback model that itself fails #when message.updated receives the new model error #then fallback advances instead of deadlocking on pending state", async () => {
    const { createMessageUpdateHandler } = await import(`./message-update-handler?pending-model-fails-${Date.now()}-${Math.random()}`)
    const sessionID = "session-pending-fallback-model-fails"
    const scheduleCalls: Array<{ sessionID: string; timeoutMsOverride?: number }> = []
    const autoRetryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const deps = createDeps({
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "Continue the task." }] },
      ],
    })
    deps.pluginConfig = {
      ...deps.pluginConfig,
      fallback_models: [
        "openai/gpt-5.4",
        "openai/gpt-5.3-codex-spark",
        "opencode/nemotron-3-super-free",
      ],
    }
    const state = createFallbackState("openai/gpt-5.4")
    state.currentModel = "openai/gpt-5.3-codex-spark"
    state.pendingFallbackModel = "openai/gpt-5.3-codex-spark"
    deps.sessionStates.set(sessionID, state)

    const handler = createMessageUpdateHandler(deps, createHelpers(scheduleCalls, {
      autoRetryWithFallback: async (retrySessionID, model, _resolvedAgent, source) => {
        autoRetryCalls.push({
          sessionID: retrySessionID,
          model,
          source,
        })
      },
    }))

    await handler({
      info: {
        id: "msg-pending-fallback-model-fails",
        sessionID,
        role: "assistant",
        agent: "compaction",
        model: "openai/gpt-5.3-codex-spark",
        error: {
          name: "AI_APICallError",
          data: {
            statusCode: 429,
            message: "usage_limit_reached",
          },
        },
      },
    })

    expect(autoRetryCalls).toEqual([
      {
        sessionID,
        model: "openai/gpt-5.4",
        source: "message.updated.limit_fallback",
      },
    ])
  })

  it("#given compaction loses live agent resolution #when spark limit fallback fires #then the stored execution agent paid chain is reopened from the top paid model", async () => {
    const { createMessageUpdateHandler } = await import(`./message-update-handler?compaction-preserve-agent-${Date.now()}-${Math.random()}`)
    const sessionID = "session-compaction-preserve-agent"
    const scheduleCalls: Array<{ sessionID: string; timeoutMsOverride?: number }> = []
    const autoRetryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const deps = createDeps({
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "Continue the task." }] },
      ],
    })
    deps.pluginConfig = {
      ...deps.pluginConfig,
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
    const state = createFallbackState("openai/gpt-5.4")
    state.resolvedAgent = "sisyphus-junior"
    state.currentModel = "openai/gpt-5.3-codex-spark"
    state.pendingFallbackModel = "openai/gpt-5.3-codex-spark"
    state.failedModels.set("openai/gpt-5.4", Date.now())
    deps.sessionStates.set(sessionID, state)

    const handler = createMessageUpdateHandler(deps, createHelpers(scheduleCalls, {
      resolveAgentForSessionFromContext: async () => undefined,
      autoRetryWithFallback: async (retrySessionID, model, _resolvedAgent, source) => {
        autoRetryCalls.push({
          sessionID: retrySessionID,
          model,
          source,
        })
      },
    }))

    await handler({
      info: {
        id: "msg-compaction-preserve-agent",
        sessionID,
        role: "assistant",
        agent: "compaction",
        model: "openai/gpt-5.3-codex-spark",
        error: {
          name: "AI_APICallError",
          data: {
            statusCode: 429,
            message: "usage_limit_reached",
          },
        },
      },
    })

    expect(autoRetryCalls).toEqual([
      {
        sessionID,
        model: "openai/gpt-5.4",
        source: "message.updated.limit_fallback",
      },
    ])
  })

  it("#given compaction spark hits a quota retry after transient paid failures #when message.updated handles it for sisyphus #then it reopens the paid chain instead of dropping to free", async () => {
    const { createMessageUpdateHandler } = await import(`./message-update-handler?compaction-paid-reopen-${Date.now()}-${Math.random()}`)
    const sessionID = "session-compaction-paid-reopen"
    const scheduleCalls: Array<{ sessionID: string; timeoutMsOverride?: number }> = []
    const autoRetryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const deps = createDeps({
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "Continue the task." }] },
      ],
    })
    deps.pluginConfig = {
      ...deps.pluginConfig,
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
    const state = createFallbackState("openai/gpt-5.4")
    state.resolvedAgent = "sisyphus-junior"
    state.currentModel = "openai/gpt-5.3-codex-spark"
    state.pendingFallbackModel = "openai/gpt-5.3-codex-spark"
    state.failedModels.set("openai/gpt-5.4", Date.now())
    state.failedModels.set("anthropic/claude-sonnet-4-6", Date.now())
    deps.sessionStates.set(sessionID, state)

    const handler = createMessageUpdateHandler(deps, createHelpers(scheduleCalls, {
      resolveAgentForSessionFromContext: async () => undefined,
      autoRetryWithFallback: async (retrySessionID, model, _resolvedAgent, source) => {
        autoRetryCalls.push({
          sessionID: retrySessionID,
          model,
          source,
        })
      },
    }))

    await handler({
      info: {
        id: "msg-compaction-paid-reopen",
        sessionID,
        role: "assistant",
        agent: "compaction",
        model: "openai/gpt-5.3-codex-spark",
        error: {
          name: "AI_APICallError",
          data: {
            statusCode: 429,
            message: "usage_limit_reached",
          },
        },
      },
    })

    expect(autoRetryCalls).toEqual([
      {
        sessionID,
        model: "openai/gpt-5.4",
        source: "message.updated.limit_fallback",
      },
    ])
  })

  it("#given a paid request-not-allowed 403 #when message.updated handles the assistant error #then runtime-fallback opens a fresh same-model handoff before any same-session retry", async () => {
    const { createMessageUpdateHandler } = await import(`./message-update-handler?fresh-paid-retry-${Date.now()}-${Math.random()}`)
    const sessionID = "session-fresh-paid-retry"
    const scheduleCalls: Array<{ sessionID: string; timeoutMsOverride?: number }> = []
    const autoRetryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const freshRetryCalls: Array<{ sessionID: string; resolvedAgent?: string; source: string }> = []
    const retryCurrentModelCalls: Array<{ sessionID: string; resolvedAgent?: string; source: string }> = []
    const deps = createDeps({
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "Continue the task." }] },
      ],
    })
    deps.pluginConfig = {
      ...deps.pluginConfig,
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
    const state = createFallbackState("openai/gpt-5.4")
    state.resolvedAgent = "sisyphus-junior"
    deps.sessionStates.set(sessionID, state)

    const handler = createMessageUpdateHandler(deps, createHelpers(scheduleCalls, {
      retryCurrentModel: async (retrySessionID, resolvedAgent, source) => {
        retryCurrentModelCalls.push({ sessionID: retrySessionID, resolvedAgent, source })
        return false
      },
      retryCurrentModelInFreshSession: async (retrySessionID, resolvedAgent, source) => {
        freshRetryCalls.push({ sessionID: retrySessionID, resolvedAgent, source })
        return true
      },
      autoRetryWithFallback: async (retrySessionID, model, _resolvedAgent, source) => {
        autoRetryCalls.push({
          sessionID: retrySessionID,
          model,
          source,
        })
      },
    }))

    await handler({
      info: {
        id: "msg-fresh-paid-retry",
        sessionID,
        role: "assistant",
        agent: "Sisyphus Junior (Focused Executor)",
        model: "openai/gpt-5.4",
        error: {
          statusCode: 403,
          message: "Request not allowed",
        },
      },
    })

    expect(freshRetryCalls).toEqual([
      {
        sessionID,
        resolvedAgent: "sisyphus-junior",
        source: "message.updated",
      },
    ])
    expect(retryCurrentModelCalls).toEqual([])
    expect(autoRetryCalls).toEqual([])
  })

  it("#given a paid request-not-allowed 403 with camelCase sessionId #when message.updated handles the assistant error #then runtime-fallback still opens a fresh same-model handoff", async () => {
    const { createMessageUpdateHandler } = await import(`./message-update-handler?fresh-paid-retry-session-id-${Date.now()}-${Math.random()}`)
    const sessionID = "session-fresh-paid-retry-session-id"
    const scheduleCalls: Array<{ sessionID: string; timeoutMsOverride?: number }> = []
    const autoRetryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const freshRetryCalls: Array<{ sessionID: string; resolvedAgent?: string; source: string }> = []
    const retryCurrentModelCalls: Array<{ sessionID: string; resolvedAgent?: string; source: string }> = []
    const deps = createDeps({
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "Continue the task." }] },
      ],
    })
    deps.pluginConfig = {
      ...deps.pluginConfig,
      agents: {
        prometheus: {
          fallback_models: [
            "anthropic/claude-opus-4-6",
            "openai/gpt-5.4",
            "anthropic/claude-sonnet-4-6",
            "openai/gpt-5.3-codex-spark",
          ],
        },
      },
    }
    const state = createFallbackState("anthropic/claude-opus-4-6")
    state.resolvedAgent = "prometheus"
    deps.sessionStates.set(sessionID, state)

    const handler = createMessageUpdateHandler(deps, createHelpers(scheduleCalls, {
      retryCurrentModel: async (retrySessionID, resolvedAgent, source) => {
        retryCurrentModelCalls.push({ sessionID: retrySessionID, resolvedAgent, source })
        return false
      },
      retryCurrentModelInFreshSession: async (retrySessionID, resolvedAgent, source) => {
        freshRetryCalls.push({ sessionID: retrySessionID, resolvedAgent, source })
        return true
      },
      autoRetryWithFallback: async (retrySessionID, model, _resolvedAgent, source) => {
        autoRetryCalls.push({
          sessionID: retrySessionID,
          model,
          source,
        })
      },
    }))

    await handler({
      info: {
        id: "msg-fresh-paid-retry-session-id",
        sessionId: sessionID,
        role: "assistant",
        agent: "Prometheus (Plan Builder)",
        providerID: "anthropic",
        modelID: "claude-opus-4-6",
        error: {
          name: "APIError",
          data: {
            statusCode: 403,
            message: "Forbidden: {\n  \"error\": {\n    \"type\": \"forbidden\",\n    \"message\": \"Request not allowed\"\n  }\n}",
          },
        },
      },
    })

    expect(freshRetryCalls).toEqual([
      {
        sessionID,
        resolvedAgent: "prometheus",
        source: "message.updated",
      },
    ])
    expect(retryCurrentModelCalls).toEqual([])
    expect(autoRetryCalls).toEqual([])
  })

  it("#given a paid local tool abort exhausts persistent same-model retries #when message.updated handles the assistant error #then runtime-fallback opens a fresh same-model handoff", async () => {
    const { createMessageUpdateHandler } = await import(`./message-update-handler?fresh-paid-tool-abort-${Date.now()}-${Math.random()}`)
    const sessionID = "session-fresh-paid-tool-abort"
    const scheduleCalls: Array<{ sessionID: string; timeoutMsOverride?: number }> = []
    const autoRetryCalls: Array<{ sessionID: string; model: string; source: string }> = []
    const freshRetryCalls: Array<{ sessionID: string; resolvedAgent?: string; source: string }> = []
    const deps = createDeps({
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "Continue the task." }] },
      ],
    })
    deps.pluginConfig = {
      ...deps.pluginConfig,
      agents: {
        prometheus: {
          fallback_models: [
            "anthropic/claude-opus-4-6",
            "openai/gpt-5.4",
            "anthropic/claude-sonnet-4-6",
            "opencode/nemotron-3-super-free",
          ],
        },
      },
    }
    const state = createFallbackState("anthropic/claude-opus-4-6")
    state.resolvedAgent = "prometheus"
    deps.sessionStates.set(sessionID, state)

    const handler = createMessageUpdateHandler(deps, createHelpers(scheduleCalls, {
      retryCurrentModel: async () => false,
      retryCurrentModelInFreshSession: async (retrySessionID, resolvedAgent, source) => {
        freshRetryCalls.push({ sessionID: retrySessionID, resolvedAgent, source })
        return true
      },
      autoRetryWithFallback: async (retrySessionID, model, _resolvedAgent, source) => {
        autoRetryCalls.push({
          sessionID: retrySessionID,
          model,
          source,
        })
      },
    }))

    await handler({
      info: {
        id: "msg-fresh-paid-tool-abort",
        sessionID,
        role: "assistant",
        agent: "Prometheus (Plan Builder)",
        model: "anthropic/claude-opus-4-6",
        error: {
          message: "Tool execution aborted",
        },
      },
    })

    expect(freshRetryCalls).toEqual([
      {
        sessionID,
        resolvedAgent: "prometheus",
        source: "message.updated",
      },
    ])
    expect(autoRetryCalls).toEqual([])
  })

  for (const currentModel of ["anthropic/claude-opus-4-6", "openai/gpt-5.4"]) {
    it(`#given ${currentModel} emits a MessageAbortedError wrapper around a local tool abort #when message.updated handles it #then runtime-fallback opens a fresh same-model handoff instead of burning the paid fallback chain`, async () => {
      const modelSlug = currentModel.replaceAll(/[^a-z0-9]+/gi, "-")
      const { createMessageUpdateHandler } = await import(`./message-update-handler?wrapped-tool-abort-${modelSlug}-${Date.now()}-${Math.random()}`)
      const sessionID = `session-wrapped-tool-abort-${modelSlug}`
      const autoRetryCalls: Array<{ sessionID: string; model: string; source: string }> = []
      const freshRetryCalls: Array<{ sessionID: string; resolvedAgent?: string; source: string }> = []
      const deps = createDeps({
        data: [
          { info: { role: "user" }, parts: [{ type: "text", text: "Continue the task." }] },
        ],
      })
      deps.pluginConfig = {
        ...deps.pluginConfig,
        agents: {
          prometheus: {
            fallback_models: [
              "anthropic/claude-opus-4-6",
              "openai/gpt-5.4",
              "anthropic/claude-sonnet-4-6",
              "openai/gpt-5.3-codex-spark",
              "opencode/nemotron-3-super-free",
            ],
          },
        },
      }
      const state = createFallbackState(currentModel)
      state.resolvedAgent = "prometheus"
      deps.sessionStates.set(sessionID, state)

      const handler = createMessageUpdateHandler(deps, createHelpers([], {
        retryCurrentModel: async () => false,
        retryCurrentModelInFreshSession: async (retrySessionID, resolvedAgent, source) => {
          freshRetryCalls.push({ sessionID: retrySessionID, resolvedAgent, source })
          return true
        },
        autoRetryWithFallback: async (retrySessionID, model, _resolvedAgent, source) => {
          autoRetryCalls.push({ sessionID: retrySessionID, model, source })
        },
      }))

      await handler({
        parts: [
          {
            type: "tool",
            state: {
              status: "error",
              error: "Tool execution aborted",
            },
          },
        ],
        info: {
          id: "msg-wrapped-tool-abort",
          sessionID,
          role: "assistant",
          agent: "Prometheus (Plan Builder)",
          model: currentModel,
          error: {
            name: "MessageAbortedError",
            message: "Aborted process",
          },
        },
      })

      expect(freshRetryCalls).toEqual([
        {
          sessionID,
          resolvedAgent: "prometheus",
          source: "message.updated",
        },
      ])
      expect(autoRetryCalls).toEqual([])
    })
  }
})
