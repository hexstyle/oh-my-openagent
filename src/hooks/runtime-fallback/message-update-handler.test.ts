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
  overrides?: Partial<AutoRetryHelpers>,
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

  it("#given a paid transient 403 exhausts same-model retries #when message.updated handles the assistant error #then runtime-fallback opens a fresh same-model handoff before paid fallback", async () => {
    const { createMessageUpdateHandler } = await import(`./message-update-handler?fresh-paid-retry-${Date.now()}-${Math.random()}`)
    const sessionID = "session-fresh-paid-retry"
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
})
