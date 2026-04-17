import type { HookDeps } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import {
  HOOK_NAME,
  isLongRunningAssistantProgress,
  resolveLongRunningProgressTimeoutMs,
} from "./constants"
import { log } from "../../shared/logger"
import { extractStatusCode, extractErrorName, classifyErrorType, isRetryableError } from "./error-classifier"
import { createFallbackState, hasSameModelIdentity, markFallbackResponseSuccess, markMeaningfulProgress, resetTransientRetryState, markLimitError, markSessionStopped, isRecentLimitError, markSessionError } from "./fallback-state"
import { getFallbackModelsForSession } from "./fallback-models"
import { SessionCategoryRegistry } from "../../shared/session-category-registry"
import { resolveFallbackBootstrapModel } from "./fallback-bootstrap-model"
import { dispatchFallbackRetry } from "./fallback-retry-dispatcher"
import { createSessionStatusHandler } from "./session-status-handler"
import { extractEventModelString } from "./event-model"
import { clearRecentCompletionState, markSessionRecentlyCompleted } from "./recent-completion-guard"
import {
  getRuntimeFallbackAction,
  isPersistentSameModelRetryAction,
  isSameModelRetryAction,
  selectFallbackModelsForAction,
} from "./fallback-policy"
import { logTrackedProvider403 } from "./provider-403-diagnostics"

export function createEventHandler(deps: HookDeps, helpers: AutoRetryHelpers) {
  const { config, options, pluginConfig, sessionStates, sessionLastAccess, sessionLastUserMessageIDs, sessionRecentCompletionUntil, sessionRecentActiveStatusUntil, sessionSilentAssistantUpdateCounts, sessionRetryInFlight, sessionAwaitingFallbackResult, sessionFallbackTimeouts, sessionTransientRetryTimeouts, sessionStatusRetryKeys } = deps
  const sessionStatusHandler = createSessionStatusHandler(deps, helpers, sessionStatusRetryKeys)
  const timeoutEnabled = config.timeout_seconds > 0

  const ensureStateForActiveWatch = (args: {
    sessionID: string
    source: string
    eventAgent?: string
    eventModel?: string
  }): boolean => {
    if (sessionStates.has(args.sessionID)) {
      return true
    }

    const model = args.eventModel ?? resolveFallbackBootstrapModel({
      sessionID: args.sessionID,
      source: args.source,
      eventModel: undefined,
      resolvedAgent: args.eventAgent,
      pluginConfig,
    })

    if (!model) {
      log(`[${HOOK_NAME}] Active-session watchdog could not bootstrap fallback state`, {
        sessionID: args.sessionID,
        source: args.source,
        eventAgent: args.eventAgent,
      })
      return false
    }

    sessionStates.set(args.sessionID, createFallbackState(model))
    log(`[${HOOK_NAME}] Bootstrapped fallback state for active-session watchdog`, {
      sessionID: args.sessionID,
      source: args.source,
      model,
      eventAgent: args.eventAgent,
    })
    return true
  }

  const handleAssistantProgressEvent = async (props: Record<string, unknown> | undefined, source: string) => {
    if (!timeoutEnabled) return

    const info = props?.info as Record<string, unknown> | undefined
    const part = props?.part as Record<string, unknown> | undefined
    const sessionID =
      (info?.sessionID as string | undefined) ??
      (part?.sessionID as string | undefined) ??
      (props?.sessionID as string | undefined) ??
      (props?.sessionId as string | undefined)
    const role = (info?.role as string | undefined) ?? "assistant"
    if (!sessionID || role !== "assistant") return

    const eventAgent = info?.agent as string | undefined
    const eventModel = extractEventModelString({
      model: info?.model,
      providerID: info?.providerID,
      modelID: info?.modelID,
      variant: info?.variant,
    })

    if (!ensureStateForActiveWatch({
      sessionID,
      source,
      eventAgent,
      eventModel,
    })) {
      return
    }

    const partType = typeof part?.type === "string" ? part.type : undefined
    const toolName = typeof part?.tool === "string" ? part.tool : undefined
    const toolStatus = typeof part?.state === "object" && part.state
      ? (part.state as { status?: string }).status
      : undefined
    const toolError = typeof part?.state === "object" && part.state
      ? (part.state as { error?: string }).error
      : undefined
    const partText = typeof part?.text === "string" ? part.text.trim() : ""
    const delta = typeof props?.delta === "string" ? props.delta : ""
    const field = typeof props?.field === "string" ? props.field : undefined
    const hasMeaningfulProgress =
      (field === "text" && delta.trim().length > 0) ||
      partType === "compaction" ||
      partType === "step-start" ||
      partType === "tool" ||
      partType === "tool_use" ||
      partType === "tool_result" ||
      partType === "tool-call" ||
      (partType === "text" && partText.length > 0) ||
      (partType === "reasoning" && (partText.length > 0 || delta.trim().length > 0))

    sessionLastAccess.set(sessionID, Date.now())

    if (!hasMeaningfulProgress) {
      return
    }

    const baseTimeoutMs = options?.session_timeout_ms ?? config.timeout_seconds * 1000
    const timeoutMsOverride = isLongRunningAssistantProgress({
      partType,
      toolStatus,
      toolName,
    })
      ? resolveLongRunningProgressTimeoutMs(baseTimeoutMs)
      : undefined

    const state = sessionStates.get(sessionID)
    const resolvedAgent = await helpers.resolveAgentForSessionFromContext(
      sessionID,
      eventAgent,
    ) ?? state?.resolvedAgent

    if (state) {
      if (resolvedAgent) {
        state.resolvedAgent = resolvedAgent
      }
      state.lastTerminalIdleAt = undefined
      markMeaningfulProgress(state)
    }

    helpers.scheduleSessionFallbackTimeout(sessionID, {
      resolvedAgent,
      source: `${source}.progress`,
      timeoutMsOverride,
    })

    if (partType === "tool" && toolStatus === "error" && typeof toolError === "string" && toolError.trim().length > 0) {
      const retryAction = getRuntimeFallbackAction({ message: toolError }, config.retry_on_errors)
      if (isPersistentSameModelRetryAction(retryAction)) {
        const retried = await helpers.retryCurrentModel(
          sessionID,
          resolvedAgent,
          `${source}.tool-error`,
          {
            immediate: false,
            persistent: true,
          },
        )
        log(`[${HOOK_NAME}] Observed local tool abort during assistant progress`, {
          sessionID,
          source,
          toolName,
          resolvedAgent,
          retried,
          retryAction,
        })
      }
    }

    if (sessionAwaitingFallbackResult.has(sessionID)) {
      sessionAwaitingFallbackResult.delete(sessionID)
      sessionStatusRetryKeys.delete(sessionID)
      const state = sessionStates.get(sessionID)
      if (state) {
        markFallbackResponseSuccess(state)
      }
    }

    log(`[${HOOK_NAME}] Refreshed fallback timeout after assistant progress`, {
      sessionID,
      source,
      partType,
      toolName,
      toolStatus,
      field,
      resolvedAgent,
      timeoutMsOverride,
    })
  }

  const handleToolExecutionProgressEvent = async (
    props: Record<string, unknown> | undefined,
    source: "tool.execute.before" | "tool.execute.after",
  ) => {
    if (!timeoutEnabled) return

    const sessionID = props?.sessionID as string | undefined
    const toolName = props?.tool as string | undefined
    if (!sessionID || !toolName) return

    const eventAgent = props?.agent as string | undefined
    const eventModel = extractEventModelString({
      model: props?.model,
      providerID: props?.providerID,
      modelID: props?.modelID,
      variant: props?.variant,
    })

    if (!ensureStateForActiveWatch({
      sessionID,
      source,
      eventAgent,
      eventModel,
    })) {
      return
    }

    const baseTimeoutMs = options?.session_timeout_ms ?? config.timeout_seconds * 1000
    const timeoutMsOverride = resolveLongRunningProgressTimeoutMs(baseTimeoutMs)
    const state = sessionStates.get(sessionID)
    const resolvedAgent = await helpers.resolveAgentForSessionFromContext(
      sessionID,
      eventAgent,
    ) ?? state?.resolvedAgent

    if (state) {
      if (resolvedAgent) {
        state.resolvedAgent = resolvedAgent
      }
      state.lastTerminalIdleAt = undefined
      markMeaningfulProgress(state)
    }

    sessionLastAccess.set(sessionID, Date.now())
    helpers.scheduleSessionFallbackTimeout(sessionID, {
      resolvedAgent,
      source: `${source}.${toolName}`,
      timeoutMsOverride,
    })

    if (sessionAwaitingFallbackResult.has(sessionID)) {
      sessionAwaitingFallbackResult.delete(sessionID)
      sessionStatusRetryKeys.delete(sessionID)
      const state = sessionStates.get(sessionID)
      if (state) {
        markFallbackResponseSuccess(state)
      }
    }

    log(`[${HOOK_NAME}] Refreshed fallback timeout after tool execution progress`, {
      sessionID,
      source,
      toolName,
      resolvedAgent,
      timeoutMsOverride,
    })
  }

  const handleSessionCreated = (props: Record<string, unknown> | undefined) => {
    const sessionInfo = props?.info as Record<string, unknown> | undefined
    const sessionID = typeof sessionInfo?.id === "string" ? sessionInfo.id : undefined
    const model = extractEventModelString({
      model: sessionInfo?.model,
      providerID: sessionInfo?.providerID,
      modelID: sessionInfo?.modelID,
      variant: sessionInfo?.variant,
    })

    if (sessionID && model) {
      log(`[${HOOK_NAME}] Session created with model`, { sessionID, model })
      sessionStates.set(sessionID, createFallbackState(model))
      sessionLastAccess.set(sessionID, Date.now())
    }
  }

  const handleSessionDeleted = (props: Record<string, unknown> | undefined) => {
    const sessionInfo = props?.info as { id?: string } | undefined
    const sessionID = sessionInfo?.id

    if (sessionID) {
      log(`[${HOOK_NAME}] Cleaning up session state`, { sessionID })
      sessionStates.delete(sessionID)
      sessionLastAccess.delete(sessionID)
      sessionLastUserMessageIDs.delete(sessionID)
      sessionRecentCompletionUntil.delete(sessionID)
      sessionRecentActiveStatusUntil?.delete(sessionID)
      sessionSilentAssistantUpdateCounts?.delete(sessionID)
      sessionRetryInFlight.delete(sessionID)
      sessionAwaitingFallbackResult.delete(sessionID)
      helpers.clearSessionFallbackTimeout(sessionID)
      sessionStatusRetryKeys.delete(sessionID)
      SessionCategoryRegistry.remove(sessionID)
    }
  }

  const handleSessionStop = async (props: Record<string, unknown> | undefined) => {
    const sessionID = props?.sessionID as string | undefined
    if (!sessionID) return

    clearRecentCompletionState(sessionID, sessionRecentCompletionUntil)
    sessionRecentActiveStatusUntil?.delete(sessionID)
    sessionSilentAssistantUpdateCounts?.delete(sessionID)
    helpers.clearSessionFallbackTimeout(sessionID)

    if (sessionRetryInFlight.has(sessionID) || sessionAwaitingFallbackResult.has(sessionID)) {
      await helpers.abortSessionRequest(sessionID, "session.stop")
    }

    sessionRetryInFlight.delete(sessionID)
    sessionAwaitingFallbackResult.delete(sessionID)
    sessionStatusRetryKeys.delete(sessionID)

    const state = sessionStates.get(sessionID)
    if (state) {
      state.lastTerminalIdleAt = Date.now()
      markSessionStopped(state)
      state.pendingFallbackModel = undefined
      resetTransientRetryState(state)
    }

    log(`[${HOOK_NAME}] Cleared fallback retry state on session.stop`, { sessionID })
  }

  const handleSessionIdle = async (props: Record<string, unknown> | undefined) => {
    const sessionID = props?.sessionID as string | undefined
    if (!sessionID) return

    if (sessionAwaitingFallbackResult.has(sessionID)) {
      if (!sessionFallbackTimeouts.has(sessionID)) {
        const resolvedAgent = await helpers.resolveAgentForSessionFromContext(
          sessionID,
          props?.agent as string | undefined,
        )
        helpers.scheduleSessionFallbackTimeout(sessionID, {
          resolvedAgent,
          source: "session.idle.awaiting-fallback-rearm",
        })
        log(`[${HOOK_NAME}] session.idle while awaiting fallback result; re-armed missing timeout`, {
          sessionID,
          resolvedAgent,
        })
        return
      }

      log(`[${HOOK_NAME}] session.idle while awaiting fallback result; keeping timeout armed`, { sessionID })
      return
    }

    const state = sessionStates.get(sessionID)
    const hasTransientRetryTimer = sessionTransientRetryTimeouts.has(sessionID)
    if (state?.pendingTransientRetry || hasTransientRetryTimer) {
      if (!hasTransientRetryTimer && state?.pendingTransientRetry) {
        const resolvedAgent = await helpers.resolveAgentForSessionFromContext(
          sessionID,
          props?.agent as string | undefined,
        )
        const retried = await helpers.retryCurrentModel(
          sessionID,
          resolvedAgent,
          "session.idle.transient-rearm",
          { immediate: false },
        )
        if (retried) {
          log(`[${HOOK_NAME}] session.idle while delayed transient retry was pending; re-armed retry`, {
            sessionID,
            resolvedAgent,
          })
          return
        }
      }

      log(`[${HOOK_NAME}] session.idle while delayed transient retry is pending; preserving retry state`, {
        sessionID,
      })
      return
    }

    const hadTimeout = sessionFallbackTimeouts.has(sessionID)
    sessionRecentActiveStatusUntil?.delete(sessionID)
    sessionSilentAssistantUpdateCounts?.delete(sessionID)
    helpers.clearSessionFallbackTimeout(sessionID)
    sessionRetryInFlight.delete(sessionID)
    sessionStatusRetryKeys.delete(sessionID)

    if (state) {
      state.lastTerminalIdleAt = Date.now()
      state.pendingFallbackModel = undefined
      resetTransientRetryState(state)
    }

    if (hadTimeout) {
      log(`[${HOOK_NAME}] Cleared fallback timeout after session completion`, { sessionID })
    }

    markSessionRecentlyCompleted(sessionID, sessionRecentCompletionUntil)
  }

  const handleSessionError = async (props: Record<string, unknown> | undefined) => {
    const sessionID = props?.sessionID as string | undefined
    const error = props?.error
    const agent = props?.agent as string | undefined
    const eventModel = extractEventModelString({
      model: props?.model,
      providerID: props?.providerID,
      modelID: props?.modelID,
      variant: props?.variant,
    })

    if (!sessionID) {
      log(`[${HOOK_NAME}] session.error without sessionID, skipping`)
      return
    }

    const resolvedAgent = await helpers.resolveAgentForSessionFromContext(sessionID, agent)
    const existingState = sessionStates.get(sessionID)

    if (sessionRetryInFlight.has(sessionID)) {
      log(`[${HOOK_NAME}] session.error skipped — retry in flight`, {
        sessionID,
        retryInFlight: true,
      })
      return
    }

    if (existingState?.pendingFallbackModel) {
      const isCurrentPendingModelError =
        typeof eventModel === "string" && hasSameModelIdentity(eventModel, existingState.currentModel)

      if (!isCurrentPendingModelError) {
        log(`[${HOOK_NAME}] session.error skipped (pending fallback in progress)`, {
          sessionID,
          eventModel,
          currentModel: existingState.currentModel,
          pendingFallbackModel: existingState.pendingFallbackModel,
        })
        return
      }
    }

    sessionAwaitingFallbackResult.delete(sessionID)
    clearRecentCompletionState(sessionID, sessionRecentCompletionUntil)
    helpers.clearSessionFallbackTimeout(sessionID)

    // If OpenCode wraps a quota-exceeded failure as MessageAbortedError, the
    // real cause is invisible. Treat it as quota_exceeded when there was a
    // recent limit signal for this session, so we route to limit_fallback
    // (spark → free) instead of the standard fallback chain.
    const rawErrorName = extractErrorName(error)?.toLowerCase()
    const isAbortedError = rawErrorName === "messageabortederror"
    const effectiveError =
      isAbortedError && existingState && isRecentLimitError(existingState)
        ? { name: "QuotaExceededError", message: "quota exceeded (inferred from abort after limit error)" }
        : error

    if (isAbortedError && effectiveError !== error) {
      log(`[${HOOK_NAME}] Treating MessageAbortedError as quota error due to recent limit signal`, { sessionID })
    }

    log(`[${HOOK_NAME}] session.error received`, {
      sessionID,
      agent,
      resolvedAgent,
      statusCode: extractStatusCode(effectiveError, config.retry_on_errors),
      errorName: extractErrorName(effectiveError),
      errorType: classifyErrorType(effectiveError),
    })

    if (!isRetryableError(effectiveError, config.retry_on_errors)) {
      log(`[${HOOK_NAME}] Error not retryable, skipping fallback`, {
        sessionID,
        retryable: false,
        statusCode: extractStatusCode(effectiveError, config.retry_on_errors),
        errorName: extractErrorName(effectiveError),
        errorType: classifyErrorType(effectiveError),
      })
      return
    }

    let state = sessionStates.get(sessionID)
    const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, pluginConfig)

    if (fallbackModels.length === 0) {
      log(`[${HOOK_NAME}] No fallback models configured`, { sessionID, agent })
      return
    }

    if (!state) {
      const initialModel = resolveFallbackBootstrapModel({
        sessionID,
        source: "session.error",
        eventModel,
        resolvedAgent,
        pluginConfig,
      })
      if (!initialModel) {
        log(`[${HOOK_NAME}] No model info available, cannot fallback`, { sessionID })
        return
      }

      state = createFallbackState(initialModel)
      sessionStates.set(sessionID, state)
      sessionLastAccess.set(sessionID, Date.now())
    } else {
      sessionLastAccess.set(sessionID, Date.now())
    }

    if (state.pendingFallbackModel && eventModel && !hasSameModelIdentity(eventModel, state.currentModel)) {
      log(`[${HOOK_NAME}] session.error skipped (pending fallback in progress)`, {
        sessionID,
        eventModel,
        currentModel: state.currentModel,
        pendingFallbackModel: state.pendingFallbackModel,
      })
      return
    }

    if (resolvedAgent) {
      state.resolvedAgent = resolvedAgent
    }

    markSessionError(state)

    const action = getRuntimeFallbackAction(effectiveError, config.retry_on_errors)
    logTrackedProvider403({
      source: "session.error",
      sessionID,
      model: state.currentModel,
      resolvedAgent,
      error: effectiveError,
      action,
    })

    if (action === "limit_fallback") {
      markLimitError(state)
    }

    if (isSameModelRetryAction(action)) {
      const retried = await helpers.retryCurrentModel(sessionID, resolvedAgent, "session.error", {
        immediate: action === "retry_same_model",
        persistent: isPersistentSameModelRetryAction(action),
      })
      if (retried || isPersistentSameModelRetryAction(action)) {
        return
      }
    }

    const effectiveAction =
      isSameModelRetryAction(action)
        ? "fallback_chain"
        : action
    const errorAwareFallbackModels = selectFallbackModelsForAction({
      currentModel: state.currentModel,
      fallbackModels,
      action: effectiveAction,
    })

    await dispatchFallbackRetry(deps, helpers, {
      sessionID,
      state,
      fallbackModels: errorAwareFallbackModels,
      resolvedAgent,
      source: `session.error.${effectiveAction}`,
    })
  }

  return async ({ event }: { event: { type: string; properties?: unknown } }) => {
    if (!config.enabled) return

    const props = event.properties as Record<string, unknown> | undefined

    if (event.type === "session.created") { handleSessionCreated(props); return }
    if (event.type === "session.deleted") { handleSessionDeleted(props); return }
    if (event.type === "session.stop") { await handleSessionStop(props); return }
    if (event.type === "session.idle") { await handleSessionIdle(props); return }
    if (event.type === "message.part.updated") { await handleAssistantProgressEvent(props, "message.part.updated"); return }
    if (event.type === "message.part.delta") { await handleAssistantProgressEvent(props, "message.part.delta"); return }
    if (event.type === "tool.execute.before") { await handleToolExecutionProgressEvent(props, "tool.execute.before"); return }
    if (event.type === "tool.execute.after") { await handleToolExecutionProgressEvent(props, "tool.execute.after"); return }
    if (event.type === "session.status") { await sessionStatusHandler(props); return }
    if (event.type === "session.error") { await handleSessionError(props); return }
  }
}
