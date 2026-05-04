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
import { extractStatusCode, extractErrorName, classifyErrorType, getErrorMessage, isRetryableError, isAbortWrapperError } from "./error-classifier"
import { createFallbackState, hasMeaningfulProgressSinceLastError, hasSameModelIdentity, markFallbackResponseSuccess, markMeaningfulProgress, resetTransientRetryState, markLimitError, markLocalToolAbort, markSessionStopped, isRecentLimitError, isRecentLocalToolAbort, markSessionError, inheritCanonicalRetryParts, inheritFreshSameModelRetryWindow } from "./fallback-state"
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
  isNetworkError,
  isPersistentSameModelRetryAction,
  isSameModelRetryAction,
  selectFallbackModelsForAction,
} from "./fallback-policy"
import { logTrackedProvider403, shouldPreferFreshTrackedProvider403Handoff } from "./provider-403-diagnostics"
import { maybePauseForManualProviderClearance } from "./manual-provider-clearance"
import { normalizeAgentForDisplay } from "../../shared/agent-display-names"
import { getRuntimeFallbackSessionID } from "./session-id"
import { hasSessionFlag } from "../../shared/session-tools-store"
import {
  applyScopedFallbackSessionHint,
  clearScopedFallbackSessionHint,
  getScopedFallbackParentSessionHint,
  rememberScopedFallbackSessionHint,
} from "./scoped-fallback-hints"
import { getAwaitingScopedFallbackParentSessionID } from "./scoped-fallback-parent-watch"

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

  const clearStaleTransientRetryAfterProgress = (sessionID: string, state: ReturnType<typeof sessionStates.get>): void => {
    if (!state && !sessionTransientRetryTimeouts.has(sessionID)) {
      return
    }

    if (
      !sessionTransientRetryTimeouts.has(sessionID)
      && !state?.pendingTransientRetry
      && !state?.persistentTransientRetry
    ) {
      return
    }

    helpers.clearSessionTransientRetryTimeout(sessionID)
    if (state) {
      resetTransientRetryState(state)
    }

    log(`[${HOOK_NAME}] Cleared stale transient retry after meaningful progress`, {
      sessionID,
    })
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
    const hasVisibleTextDelta =
      (field === undefined || field === "text")
      && delta.trim().length > 0
    const isStreamingTextDeltaProgress =
      source === "message.part.delta"
      && hasVisibleTextDelta
    const hasReasoningStreamProgress =
      partType === "reasoning"
      && (partText.length > 0 || delta.trim().length > 0)
    const isCiPreForwardProgressReasoningChurn =
      hasSessionFlag(sessionID, "ci-fast-path")
      && hasSessionFlag(sessionID, "ci-dirty-batch-inspected")
      && !hasSessionFlag(sessionID, "ci-forward-progress")
      && (
        isStreamingTextDeltaProgress
        || hasReasoningStreamProgress
      )
    const hasMeaningfulProgress =
      hasVisibleTextDelta ||
      partType === "compaction" ||
      partType === "step-start" ||
      partType === "tool" ||
      partType === "tool_use" ||
      partType === "tool_result" ||
      partType === "tool-call" ||
      (partType === "text" && partText.length > 0) ||
      hasReasoningStreamProgress

    if (!hasMeaningfulProgress) {
      return
    }

    if (isCiPreForwardProgressReasoningChurn) {
      log(`[${HOOK_NAME}] Ignoring CI reasoning-only churn after dirty-batch inspection`, {
        sessionID,
        source,
        partType,
      })
      return
    }

    // Coordinator: track visible assistant progress for cross-module decisions
    deps.coordinator?.observe(sessionID, {
      kind: "assistant_progress",
      hasVisibleContent: hasVisibleTextDelta || (partType === "text" && partText.length > 0),
      partType,
      toolName,
      toolStatus,
      isStreaming: isStreamingTextDeltaProgress || hasReasoningStreamProgress,
    })

    sessionLastAccess.set(sessionID, Date.now())

    const longRunningTimeoutMs = resolveLongRunningProgressTimeoutMs(baseTimeoutMs)
    const isLongRunningProgress = isLongRunningAssistantProgress({
      partType,
      toolStatus,
      toolName,
    })
    const shouldExtendLiveStreamQuietWindow =
      isStreamingTextDeltaProgress
      || hasReasoningStreamProgress
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
      : shouldExtendLiveStreamQuietWindow
        ? longRunningTimeoutMs
        : (
          (
            hasVisibleTextDelta
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
      clearStaleTransientRetryAfterProgress(sessionID, state)
      if (isPreExecutionRegroupTool) {
        state.longRunningProgressUntil = now + longRunningTimeoutMs
      } else if (shouldExtendLiveStreamQuietWindow) {
        state.longRunningProgressUntil = now + longRunningTimeoutMs
      } else if (typeof inheritedLongRunningTimeoutMs === "number") {
        state.longRunningProgressUntil = now + inheritedLongRunningTimeoutMs
      } else {
        state.longRunningProgressUntil = undefined
      }
      state.lastDurableAssistantProgressAt = now
    }

    helpers.scheduleSessionFallbackTimeout(sessionID, {
      resolvedAgent,
      source: `${source}.progress`,
      timeoutMsOverride: Math.max(
        timeoutMsOverride ?? 0,
        inheritedLongRunningTimeoutMs ?? 0,
      ) || undefined,
    })

    const awaitingScopedFallbackParentSessionID = getAwaitingScopedFallbackParentSessionID(
      deps,
      sessionID,
      state,
    )
    if (awaitingScopedFallbackParentSessionID) {
      sessionLastAccess.set(awaitingScopedFallbackParentSessionID, now)
      helpers.scheduleSessionFallbackTimeout(awaitingScopedFallbackParentSessionID, {
        resolvedAgent:
          sessionStates.get(awaitingScopedFallbackParentSessionID)?.resolvedAgent
          ?? resolvedAgent,
        source: `${source}.progress.awaiting-fallback-parent`,
        timeoutMsOverride: Math.max(
          timeoutMsOverride ?? 0,
          inheritedLongRunningTimeoutMs ?? 0,
        ) || undefined,
      })
    }

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

    if (sessionAwaitingFallbackResult.has(sessionID)) {
      sessionAwaitingFallbackResult.delete(sessionID)
      sessionStatusRetryKeys.delete(sessionID)
      const state = sessionStates.get(sessionID)
      if (state) {
        markFallbackResponseSuccess(state)
      }
    }

    if (!(source === "message.part.delta" && field === "text" && partType !== "tool")) {
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
      clearStaleTransientRetryAfterProgress(sessionID, state)
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
    const parentSessionID = typeof sessionInfo?.parentID === "string"
      ? sessionInfo.parentID
      : (typeof sessionInfo?.parentId === "string" ? sessionInfo.parentId : undefined)
    const title = typeof sessionInfo?.title === "string" ? sessionInfo.title : undefined
    const model = extractEventModelString({
      model: sessionInfo?.model,
      providerID: sessionInfo?.providerID,
      modelID: sessionInfo?.modelID,
      variant: sessionInfo?.variant,
    })

    if (sessionID) {
      rememberScopedFallbackSessionHint(deps, sessionID, title, parentSessionID)
    }

    if (sessionID && model) {
      const previousState = sessionStates.get(sessionID)
      const state = createFallbackState(model)
      if (previousState) {
        inheritCanonicalRetryParts(state, previousState)
        inheritFreshSameModelRetryWindow(state, previousState)
      }
      if (parentSessionID) {
        inheritCanonicalRetryParts(state, sessionStates.get(parentSessionID))
        inheritFreshSameModelRetryWindow(state, sessionStates.get(parentSessionID))
      }
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

    deps.coordinator?.observe(sessionID, { kind: "session_stopped" })

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

    deps.coordinator?.observe(sessionID, { kind: "session_status_idle" })

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

    const isLocalToolAbortError = extractErrorName(effectiveError)?.toLowerCase() === "localtoolabortwrappederror"
    const errorRetryable = isRetryableError(effectiveError, config.retry_on_errors)
    const isQuotaError = classifyErrorType(effectiveError) === "quota_exceeded"
      || extractStatusCode(effectiveError, config.retry_on_errors) === 429
    deps.coordinator?.observe(sessionID, {
      kind: "session_error",
      isRetryable: errorRetryable,
      isQuota: isQuotaError,
      isLocalToolAbort: isLocalToolAbortError,
    })

    if (!errorRetryable) {
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

    const isScopedBootstrapUnknownError =
      state.isScopedFallbackChild
      && state.scopedFallbackBootstrapPending === true
      && state.lastMeaningfulProgressAt === undefined
      && rawErrorName === "unknownerror"
    if (isScopedBootstrapUnknownError) {
      state.scopedFallbackBootstrapPending = false
      const retryParentSessionID = (
        typeof state.scopedFallbackParentSessionID === "string"
          ? state.scopedFallbackParentSessionID
          : getScopedFallbackParentSessionHint(deps, sessionID)
      )?.trim()

      if (typeof retryParentSessionID === "string" && retryParentSessionID.length > 0 && retryParentSessionID !== sessionID) {
        sessionAwaitingFallbackResult.delete(retryParentSessionID)
        helpers.clearSessionFallbackTimeout(retryParentSessionID)

        const parentState = sessionStates.get(retryParentSessionID)
        if (parentState) {
          parentState.pendingFallbackModel = undefined
          resetTransientRetryState(parentState)
          if (resolvedAgent) {
            parentState.resolvedAgent = resolvedAgent
          }
        }

        const retried = await helpers.retryCurrentModel(
          retryParentSessionID,
          resolvedAgent,
          "session.error.scoped-bootstrap",
          {
            immediate: true,
            persistent: false,
            maxAttempts: 1,
          },
        )
        if (retried) {
          return
        }
      }
    }

    const tier403 = getRuntimeFallbackTier(state.currentModel)
    const shouldPrefer403 = shouldPreferFreshTrackedProvider403Handoff({
      model: state.currentModel,
      error: effectiveError,
      isScopedFallbackChild: state.isScopedFallbackChild,
    })
    const preferFreshTrackedProvider403Handoff = tier403 === "paid" && shouldPrefer403
    if (isSameModelRetryAction(action)) {
      log(`[${HOOK_NAME}] 403 handoff evaluation`, {
        sessionID,
        currentModel: state.currentModel,
        tier: tier403,
        shouldPrefer403,
        preferFreshHandoff: preferFreshTrackedProvider403Handoff,
        isScopedChild: state.isScopedFallbackChild,
        action,
      })
    }
    const shouldPreferInPlacePreludeRetry =
      bootstrappedFromAgentModelForPrelude403
      && state.lastMeaningfulProgressAt === undefined
      && !state.isScopedFallbackChild
    const shouldPreferInlinePreludeRetryOnFreshHandoffFailure =
      preferFreshTrackedProvider403Handoff

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
        // 403 "request not allowed" needs a connection reset, not an in-process
        // child session.  Dispatch via external process with a delay — mirrors
        // the manual /exit → resume pattern that clears the provider block.
        const externalRestarted = helpers.dispatchExternal403Restart({
          sessionID,
          resolvedAgent,
          source: "session.error.tracked-provider-403",
        })
        if (externalRestarted) {
          return
        }
        // External restart failed — fall back to in-process fresh session
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

    // Network/infra errors (TLS cert, DNS, ECONNRESET) cannot be fixed by switching
    // models.  When same-model retry was attempted but failed (already in-flight or
    // window expired), do NOT escalate to fallback_chain — just log and return.
    // Only quota/limit errors (429) warrant cross-model fallback.
    if (isSameModelRetryAction(action) && isNetworkError(effectiveError)) {
      log(`[${HOOK_NAME}] Network error retry exhausted — NOT escalating to fallback_chain (switching models cannot fix network)`, {
        sessionID,
        currentModel: state.currentModel,
        error: getErrorMessage(effectiveError),
        action,
      })
      return
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
