import type { HookDeps } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import {
  HOOK_NAME,
  isLongRunningAssistantProgress,
  isPreExecutionRegroupToolProgress,
  resolveLongRunningProgressTimeoutMs,
} from "./constants"
import { resolveRecentActiveStatusTimeoutOverride } from "./active-status-timeout"
import { log } from "../../shared/logger"
import { extractStatusCode, extractErrorName, classifyErrorType, isRetryableError, isAbortWrapperError } from "./error-classifier"
import { createFallbackState, hasMeaningfulProgressSinceLastError, hasSameModelIdentity, markFallbackResponseSuccess, markMeaningfulProgress, resetTransientRetryState, markLimitError, markLocalToolAbort, markSessionStopped, isRecentLimitError, isRecentLocalToolAbort, markSessionError } from "./fallback-state"
import { getFallbackModelsForSession } from "./fallback-models"
import { SessionCategoryRegistry } from "../../shared/session-category-registry"
import { resolveFallbackBootstrapModel } from "./fallback-bootstrap-model"
import { dispatchFallbackRetry } from "./fallback-retry-dispatcher"
import { createSessionStatusHandler } from "./session-status-handler"
import { extractEventModelString } from "./event-model"
import { clearRecentCompletionState, markSessionRecentlyCompleted } from "./recent-completion-guard"
import {
  getSameModelRetryAttemptLimit,
  getRuntimeFallbackAction,
  getRuntimeFallbackTier,
  isPersistentSameModelRetryAction,
  isSameModelRetryAction,
  selectFallbackModelsForAction,
} from "./fallback-policy"
import { logTrackedProvider403, shouldPreferFreshTrackedProvider403Handoff } from "./provider-403-diagnostics"
import { maybePauseForManualProviderClearance } from "./manual-provider-clearance"
import { normalizeAgentForDisplay } from "../../shared/agent-display-names"
import { getRuntimeFallbackSessionID } from "./session-id"
import {
  applyScopedFallbackSessionHint,
  clearScopedFallbackSessionHint,
  rememberScopedFallbackSessionHint,
} from "./scoped-fallback-hints"

export function createEventHandler(deps: HookDeps, helpers: AutoRetryHelpers) {
  const { ctx, config, options, pluginConfig, sessionStates, sessionLastAccess, sessionLastUserMessageIDs, sessionRecentCompletionUntil, sessionRecentActiveStatusUntil, sessionSilentAssistantUpdateCounts, sessionRetryInFlight, sessionAwaitingFallbackResult, sessionFallbackTimeouts, sessionTransientRetryTimeouts, sessionStatusRetryKeys } = deps
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

    const state = createFallbackState(model)
    applyScopedFallbackSessionHint(deps, args.sessionID, state)
    sessionStates.set(args.sessionID, state)
    log(`[${HOOK_NAME}] Bootstrapped fallback state for active-session watchdog`, {
      sessionID: args.sessionID,
      source: args.source,
      model,
      eventAgent: args.eventAgent,
      isScopedFallbackChild: state.isScopedFallbackChild,
    })
    return true
  }

  const handleAssistantProgressEvent = async (props: Record<string, unknown> | undefined, source: string) => {
    if (!timeoutEnabled) return

    const info = props?.info as Record<string, unknown> | undefined
    const part = props?.part as Record<string, unknown> | undefined
    const sessionID = getRuntimeFallbackSessionID(props)
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
    const toolState = typeof part?.state === "object" && part.state
      ? (part.state as Record<string, unknown>)
      : undefined
    const toolStatus = toolState
      ? (toolState as { status?: string }).status
      : undefined
    const toolError = toolState
      ? (toolState as { error?: string }).error
      : undefined
    const partText = typeof part?.text === "string" ? part.text.trim() : ""
    const delta = typeof props?.delta === "string" ? props.delta : ""
    const field = typeof props?.field === "string" ? props.field : undefined
    const state = sessionStates.get(sessionID)
    const now = Date.now()
    const baseTimeoutMs = options?.session_timeout_ms ?? config.timeout_seconds * 1000
    const isTextDeltaProgress =
      source === "message.part.delta"
      && field === "text"
      && delta.trim().length > 0
    if (isTextDeltaProgress && state) {
      const durableAnchor = state.lastDurableAssistantProgressAt
      if (
        durableAnchor !== undefined
        && now - durableAnchor >= baseTimeoutMs
      ) {
        log(`[${HOOK_NAME}] Ignored delta-only assistant churn after durable progress window expired`, {
          sessionID,
          source,
          resolvedAgent: state.resolvedAgent,
          durableAnchorAgeMs: now - durableAnchor,
        })
        return
      }
      if (durableAnchor === undefined) {
        state.lastDurableAssistantProgressAt = now
      }
    }
    const malformedPendingTool =
      partType === "tool"
      && toolStatus === "pending"
      && ["write", "apply_patch", "todowrite"].includes(toolName ?? "")
      && (() => {
        const raw = typeof toolState?.raw === "string" ? toolState.raw.trim() : ""
        const input = typeof toolState?.input === "object" && toolState.input !== null
          ? (toolState.input as Record<string, unknown>)
          : undefined
        return raw.length === 0 && (!input || Object.keys(input).length === 0)
      })()
    const reasoningHasFreshWatchdogBudget =
      partType === "reasoning"
      && (partText.length > 0 || delta.trim().length > 0)
      && state?.lastMeaningfulProgressAt === undefined
    const hasMeaningfulProgress =
      (field === "text" && delta.trim().length > 0) ||
      partType === "compaction" ||
      partType === "step-start" ||
      partType === "tool" ||
      partType === "tool_use" ||
      partType === "tool_result" ||
      partType === "tool-call" ||
      (partType === "text" && partText.length > 0) ||
      reasoningHasFreshWatchdogBudget

    if (!hasMeaningfulProgress) {
      if (partType === "reasoning" && (partText.length > 0 || delta.trim().length > 0)) {
        log(`[${HOOK_NAME}] Ignored repeated reasoning-only assistant progress for watchdog refresh`, {
          sessionID,
          source,
          resolvedAgent: state?.resolvedAgent,
        })
      }
      return
    }

    sessionLastAccess.set(sessionID, Date.now())

    const longRunningTimeoutMs = resolveLongRunningProgressTimeoutMs(baseTimeoutMs)
    const isLongRunningProgress = isLongRunningAssistantProgress({
      partType,
      toolStatus,
      toolName,
    })
    const isPreExecutionRegroupTool = isPreExecutionRegroupToolProgress({
      partType,
      toolStatus,
      toolName,
    })
    const inheritedLongRunningTimeoutMs =
      typeof state?.longRunningProgressUntil === "number" && state.longRunningProgressUntil > now
        ? Math.max(1, state.longRunningProgressUntil - now)
        : undefined
    const timeoutMsOverride = isLongRunningProgress
      ? longRunningTimeoutMs
      : (
        (
          (field === "text" && delta.trim().length > 0)
          || (partType === "text" && partText.length > 0)
        )
          ? resolveRecentActiveStatusTimeoutOverride(deps, sessionID)
          : undefined
      )

    const resolvedAgent = await helpers.resolveAgentForSessionFromContext(
      sessionID,
      eventAgent,
    ) ?? state?.resolvedAgent

    if (state) {
      if (resolvedAgent) {
        state.resolvedAgent = resolvedAgent
      }
      state.lastTerminalIdleAt = undefined
      markMeaningfulProgress(state, now)
      if (isPreExecutionRegroupTool) {
        state.longRunningProgressUntil = now + longRunningTimeoutMs
      } else if (typeof inheritedLongRunningTimeoutMs === "number") {
        state.longRunningProgressUntil = now + inheritedLongRunningTimeoutMs
      } else {
        state.longRunningProgressUntil = undefined
      }
      if (!isTextDeltaProgress) {
        state.lastDurableAssistantProgressAt = now
      }
    }

    helpers.scheduleSessionFallbackTimeout(sessionID, {
      resolvedAgent,
      source: `${source}.progress`,
      timeoutMsOverride: Math.max(
        timeoutMsOverride ?? 0,
        inheritedLongRunningTimeoutMs ?? 0,
      ) || undefined,
    })

    if (partType === "tool" && toolStatus === "error" && typeof toolError === "string" && toolError.trim().length > 0) {
      const retryAction = getRuntimeFallbackAction({ message: toolError }, config.retry_on_errors)
      if (isPersistentSameModelRetryAction(retryAction)) {
        if (state) {
          markLocalToolAbort(state)
        }
        const maxAttempts = getSameModelRetryAttemptLimit({ message: toolError }, retryAction)
        const preferFreshPaidRetry =
          !!state
          && getRuntimeFallbackTier(state.currentModel) === "paid"
          && !state.isScopedFallbackChild
        const retried = preferFreshPaidRetry
          ? false
          : await helpers.retryCurrentModel(
            sessionID,
            resolvedAgent,
            `${source}.tool-error`,
            {
              immediate: false,
              persistent: true,
              maxAttempts,
            },
          )
        let freshRetried = false
        if (
          !retried
          && state
          && getRuntimeFallbackTier(state.currentModel) === "paid"
          && !state.isScopedFallbackChild
        ) {
          freshRetried = await helpers.retryCurrentModelInFreshSession(
            sessionID,
            resolvedAgent,
            `${source}.tool-error`,
          )
        }
        log(`[${HOOK_NAME}] Observed local tool abort during assistant progress`, {
          sessionID,
          source,
          toolName,
          resolvedAgent,
          retried,
          freshRetried,
          retryAction,
        })
      }
    }

    if (malformedPendingTool) {
      if (state) {
        markLocalToolAbort(state)
      }
      const preferFreshPaidRetry =
        !!state
        && getRuntimeFallbackTier(state.currentModel) === "paid"
        && !state.isScopedFallbackChild
      const retried = preferFreshPaidRetry
        ? false
        : await helpers.retryCurrentModel(
          sessionID,
          resolvedAgent,
          `${source}.malformed-tool-pending`,
          {
            immediate: false,
            persistent: true,
            maxAttempts: 1,
          },
        )
      let freshRetried = false
      if (
        !retried
        && state
        && getRuntimeFallbackTier(state.currentModel) === "paid"
        && !state.isScopedFallbackChild
      ) {
        freshRetried = await helpers.retryCurrentModelInFreshSession(
          sessionID,
          resolvedAgent,
          `${source}.malformed-tool-pending`,
        )
      }
      log(`[${HOOK_NAME}] Observed malformed pending regroup tool payload during assistant progress`, {
        sessionID,
        source,
        toolName,
        resolvedAgent,
        retried,
        freshRetried,
      })
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

    const sessionID = getRuntimeFallbackSessionID(props)
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
    const title = typeof sessionInfo?.title === "string" ? sessionInfo.title : undefined
    const model = extractEventModelString({
      model: sessionInfo?.model,
      providerID: sessionInfo?.providerID,
      modelID: sessionInfo?.modelID,
      variant: sessionInfo?.variant,
    })

    if (sessionID) {
      rememberScopedFallbackSessionHint(deps, sessionID, title)
    }

    if (sessionID && model) {
      const state = createFallbackState(model)
      applyScopedFallbackSessionHint(deps, sessionID, state)
      log(`[${HOOK_NAME}] Session created with model`, { sessionID, model })
      sessionStates.set(sessionID, state)
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
      clearScopedFallbackSessionHint(deps, sessionID)
      sessionRetryInFlight.delete(sessionID)
      sessionAwaitingFallbackResult.delete(sessionID)
      helpers.clearSessionFallbackTimeout(sessionID)
      sessionStatusRetryKeys.delete(sessionID)
      SessionCategoryRegistry.remove(sessionID)
    }
  }

  const handleSessionStop = async (props: Record<string, unknown> | undefined) => {
    const sessionID = getRuntimeFallbackSessionID(props)
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
    const sessionID = getRuntimeFallbackSessionID(props)
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
      if (state && hasMeaningfulProgressSinceLastError(state)) {
        helpers.clearSessionTransientRetryTimeout(sessionID)
        state.pendingTransientRetry = false
        state.persistentTransientRetry = false
        log(`[${HOOK_NAME}] session.idle cleared stale transient retry after successful progress`, {
          sessionID,
        })
      } else if (!hasTransientRetryTimer && state?.pendingTransientRetry) {
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

        log(`[${HOOK_NAME}] session.idle while delayed transient retry is pending; preserving retry state`, {
          sessionID,
        })
        return
      } else {
        log(`[${HOOK_NAME}] session.idle while delayed transient retry is pending; preserving retry state`, {
          sessionID,
        })
        return
      }
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
    const sessionID = getRuntimeFallbackSessionID(props)
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

    const liveResolvedAgent = await helpers.resolveAgentForSessionFromContext(sessionID, agent)
    const existingState = sessionStates.get(sessionID)
    const resolvedAgent = liveResolvedAgent ?? existingState?.resolvedAgent

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
    // (remaining paid chain before free) instead of the standard fallback chain.
    const rawErrorName = extractErrorName(error)?.toLowerCase()
    const isAbortedError = rawErrorName === "messageabortederror"
    const effectiveError =
      isAbortedError && existingState && isRecentLimitError(existingState)
        ? { name: "QuotaExceededError", message: "quota exceeded (inferred from abort after limit error)" }
        : isAbortWrapperError(error) && existingState && isRecentLocalToolAbort(existingState)
          ? { name: "LocalToolAbortWrappedError", message: "Tool execution aborted" }
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

    const primeSessionTitleForRetry = async () => {
      const updateSession = ctx.client.session.update
      if (!updateSession) {
        return
      }

      const fallbackTitle = normalizeAgentForDisplay(resolvedAgent) ?? resolvedAgent ?? "Session"
      await updateSession({
        path: { id: sessionID },
        body: { title: fallbackTitle },
        query: { directory: ctx.directory },
      }).catch(() => {})
    }

    let state = sessionStates.get(sessionID)
    let bootstrappedFromAgentModelForPrelude403 = false

    if (!state) {
      const agentConfiguredModel = resolveFallbackBootstrapModel({
        sessionID,
        source: "session.error.agent-config",
        resolvedAgent,
        pluginConfig,
      })
      const shouldPreferAgentConfiguredModel =
        typeof eventModel === "string"
        && typeof agentConfiguredModel === "string"
        && !hasSameModelIdentity(eventModel, agentConfiguredModel)
        && getRuntimeFallbackTier(eventModel) === "paid"
        && shouldPreferFreshTrackedProvider403Handoff({
          model: eventModel,
          error: effectiveError,
          isScopedFallbackChild: false,
        })

      const initialModel = resolveFallbackBootstrapModel({
        sessionID,
        source: "session.error",
        eventModel: shouldPreferAgentConfiguredModel ? undefined : eventModel,
        resolvedAgent,
        pluginConfig,
      })
      if (!initialModel) {
        log(`[${HOOK_NAME}] No model info available, cannot fallback`, { sessionID })
        return
      }

      if (shouldPreferAgentConfiguredModel) {
        bootstrappedFromAgentModelForPrelude403 = true
        log(`[${HOOK_NAME}] Ignoring internal prelude model while bootstrapping tracked paid 403 recovery`, {
          sessionID,
          eventModel,
          resolvedAgent,
          bootstrappedModel: initialModel,
        })
      }

      state = createFallbackState(initialModel)
      applyScopedFallbackSessionHint(deps, sessionID, state)
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

    if (await maybePauseForManualProviderClearance(deps, helpers, {
      sessionID,
      resolvedAgent,
      model: state.currentModel,
      error: effectiveError,
      source: "session.error",
    })) {
      return
    }

    if (action === "limit_fallback") {
      markLimitError(state)
    }

    const preferFreshTrackedProvider403Handoff =
      getRuntimeFallbackTier(state.currentModel) === "paid"
      && shouldPreferFreshTrackedProvider403Handoff({
        model: state.currentModel,
        error: effectiveError,
        isScopedFallbackChild: state.isScopedFallbackChild,
      })
    const shouldPreferInPlacePreludeRetry =
      bootstrappedFromAgentModelForPrelude403
      && state.lastMeaningfulProgressAt === undefined
      && !state.isScopedFallbackChild
    const shouldPreferInlinePreludeRetryOnFreshHandoffFailure =
      preferFreshTrackedProvider403Handoff
      && !state.isScopedFallbackChild

    if (isSameModelRetryAction(action)) {
      if (shouldPreferInPlacePreludeRetry) {
        await primeSessionTitleForRetry()
        const retried = await helpers.retryCurrentModel(sessionID, resolvedAgent, "session.error.prelude", {
          immediate: true,
          persistent: false,
          maxAttempts: 1,
        })
        if (retried) {
          return
        }
      }

      if (preferFreshTrackedProvider403Handoff) {
        const freshRetried = await helpers.retryCurrentModelInFreshSession(
          sessionID,
          resolvedAgent,
          "session.error",
        )
        if (freshRetried) {
          return
        }

        if (shouldPreferInlinePreludeRetryOnFreshHandoffFailure) {
          await primeSessionTitleForRetry()
          const retried = await helpers.retryCurrentModel(sessionID, resolvedAgent, "session.error.inline-preamble", {
            immediate: true,
            persistent: false,
            maxAttempts: 1,
          })
          if (retried) {
            return
          }
        }
      }

      const maxAttempts = getSameModelRetryAttemptLimit(effectiveError, action)
      const retried = await helpers.retryCurrentModel(sessionID, resolvedAgent, "session.error", {
        immediate: action === "retry_same_model",
        persistent: isPersistentSameModelRetryAction(action),
        maxAttempts,
      })
      if (retried) {
        return
      }

      if (!preferFreshTrackedProvider403Handoff && getRuntimeFallbackTier(state.currentModel) === "paid") {
        const freshRetried = await helpers.retryCurrentModelInFreshSession(
          sessionID,
          resolvedAgent,
          "session.error",
        )
        if (freshRetried) {
          return
        }
      }
    }

    const effectiveAction =
      isSameModelRetryAction(action)
        ? "fallback_chain"
        : action
    const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, pluginConfig)
    if (fallbackModels.length === 0) {
      log(`[${HOOK_NAME}] No fallback models configured`, {
        sessionID,
        agent,
        resolvedAgent,
        action,
        effectiveAction,
      })
      return
    }
    const errorAwareFallbackModels = selectFallbackModelsForAction({
      currentModel: state.currentModel,
      fallbackModels,
      action: effectiveAction,
    })
    const shouldIgnoreCandidateCooldown =
      effectiveAction === "limit_fallback"
      && getRuntimeFallbackTier(state.currentModel) !== "paid"

    await dispatchFallbackRetry(deps, helpers, {
      sessionID,
      state,
      fallbackModels: errorAwareFallbackModels,
      resolvedAgent,
      source: `session.error.${effectiveAction}`,
      prepareFallbackOptions:
        (
          isSameModelRetryAction(action) && getRuntimeFallbackTier(state.currentModel) === "paid"
        ) || shouldIgnoreCandidateCooldown
          ? {
            ...(isSameModelRetryAction(action) && getRuntimeFallbackTier(state.currentModel) === "paid"
              ? { skipFailedModelCooldown: true }
              : {}),
            ...(shouldIgnoreCandidateCooldown
              ? { ignoreCandidateCooldown: true }
              : {}),
          }
          : undefined,
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
