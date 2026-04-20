import type { HookDeps } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { HOOK_NAME, resolveLongRunningProgressTimeoutMs } from "./constants"
import { resolveRecentActiveStatusTimeoutOverride } from "./active-status-timeout"
import { log } from "../../shared/logger"
import { extractStatusCode, extractErrorName, classifyErrorType, isRetryableError, extractAutoRetrySignal, containsErrorContent, containsLocalToolAbortPart, isAbortWrapperError } from "./error-classifier"
import { createFallbackState, hasSameModelIdentity, markFallbackResponseSuccess, markMeaningfulProgress, markLimitError, markLocalToolAbort, markSessionError, isRecentLocalToolAbort } from "./fallback-state"
import { getFallbackModelsForSession } from "./fallback-models"
import { resolveFallbackBootstrapModel } from "./fallback-bootstrap-model"
import { dispatchFallbackRetry } from "./fallback-retry-dispatcher"
import { extractEventModelString } from "./event-model"
import {
  getSameModelRetryAttemptLimit,
  getRuntimeFallbackAction,
  getRuntimeFallbackTier,
  isPersistentSameModelRetryAction,
  isSameModelRetryAction,
  selectFallbackModelsForAction,
} from "./fallback-policy"
import { logTrackedProvider403, shouldPreferFreshTrackedProvider403Handoff } from "./provider-403-diagnostics"
import {
  hasVisibleAssistantEventContent,
  hasVisibleAssistantResponse,
} from "./visible-assistant-response"
import {
  clearRecentCompletionState,
  recordLastUserMessageID,
  shouldSuppressRecentCompletionReplay,
} from "./recent-completion-guard"
import { isInternalInitiatorMessage } from "./internal-continuation-loop-detector"
import { maybePauseForManualProviderClearance } from "./manual-provider-clearance"
import {
  handleInternalContinuationUserMessage,
  resetInternalContinuationLoopForRealUser,
  resetInternalContinuationLoopForVisibleAssistant,
} from "./internal-continuation-loop-state"

export { hasVisibleAssistantResponse } from "./visible-assistant-response"

export function createMessageUpdateHandler(deps: HookDeps, helpers: AutoRetryHelpers) {
  const { ctx, config, pluginConfig, sessionStates, sessionLastAccess, sessionLastUserMessageIDs, sessionRecentCompletionUntil, sessionRetryInFlight, sessionAwaitingFallbackResult, sessionTransientRetryTimeouts, sessionStatusRetryKeys, sessionRecentActiveStatusUntil, sessionSilentAssistantUpdateCounts } = deps
  const checkVisibleResponse = hasVisibleAssistantResponse(extractAutoRetrySignal)
  const timeoutEnabled = config.timeout_seconds > 0

  const armActiveSessionWatchdog = async (args: {
    sessionID: string
    role: string
    source: string
    info: Record<string, unknown> | undefined
    timeoutMsOverride?: number
  }): Promise<{ resolvedAgent?: string; model?: string } | null> => {
    if (!timeoutEnabled) return null

    const resolvedAgent = await helpers.resolveAgentForSessionFromContext(
      args.sessionID,
      args.info?.agent as string | undefined,
    )
    const model = extractEventModelString({
      model: args.info?.model,
      providerID: args.info?.providerID,
      modelID: args.info?.modelID,
      variant: args.info?.variant,
    }) ?? resolveFallbackBootstrapModel({
      sessionID: args.sessionID,
      source: args.source,
      eventModel: undefined,
      resolvedAgent,
      pluginConfig,
    })

    if (!sessionStates.has(args.sessionID)) {
      if (!model) {
        log(`[${HOOK_NAME}] Active-session watchdog could not bootstrap from message.updated`, {
          sessionID: args.sessionID,
          role: args.role,
          source: args.source,
        })
        return null
      }

      sessionStates.set(args.sessionID, createFallbackState(model))
      log(`[${HOOK_NAME}] Bootstrapped fallback state from message.updated`, {
        sessionID: args.sessionID,
        role: args.role,
        source: args.source,
        model,
        resolvedAgent,
      })
    }

    const state = sessionStates.get(args.sessionID)
    if (state && resolvedAgent) {
      state.resolvedAgent = resolvedAgent
    }

    sessionLastAccess.set(args.sessionID, Date.now())
    helpers.scheduleSessionFallbackTimeout(args.sessionID, {
      resolvedAgent,
      source: args.source,
      timeoutMsOverride: args.timeoutMsOverride,
    })

    return { resolvedAgent, model }
  }

  const resolveInitialUserTimeoutOverride = (model: string | undefined): number | undefined => {
    if (!model?.startsWith("anthropic/")) {
      return undefined
    }

    const baseTimeoutMs = deps.options?.session_timeout_ms ?? deps.config.timeout_seconds * 1000
    return resolveLongRunningProgressTimeoutMs(baseTimeoutMs)
  }

  const isPendingFallbackUserContinuation = (args: {
    sessionID: string
    model: string | undefined
    parts: Array<{ type?: string; text?: string }> | undefined
  }): boolean => {
    if (!sessionAwaitingFallbackResult.has(args.sessionID)) {
      return false
    }

    if ((args.parts?.length ?? 0) > 0) {
      return false
    }

    const state = sessionStates.get(args.sessionID)
    if (!state?.pendingFallbackModel || !args.model) {
      return false
    }

    return hasSameModelIdentity(args.model, state.pendingFallbackModel)
  }

  const hasTerminalAssistantFinish = (info: Record<string, unknown> | undefined): boolean => {
    const finish = typeof info?.finish === "string" ? info.finish : undefined
    return finish !== undefined && finish !== "tool-calls" && finish !== "unknown"
  }

  return async (props: Record<string, unknown> | undefined) => {
    const info = props?.info as Record<string, unknown> | undefined
    const sessionID = info?.sessionID as string | undefined
    const eventParts = props?.parts as Array<{ type?: string; text?: string }> | undefined
    const infoParts = info?.parts as Array<{ type?: string; text?: string }> | undefined
    const parts = eventParts && eventParts.length > 0 ? eventParts : infoParts
    const retrySignalResult = extractAutoRetrySignal(info)
    const partsText = (parts ?? [])
      .filter((p) => typeof p?.text === "string")
      .map((p) => (p.text ?? "").trim())
      .filter((text) => text.length > 0)
      .join("\n")
    const retrySignalFromParts = partsText
      ? extractAutoRetrySignal({ message: partsText, status: partsText, summary: partsText })?.signal
      : undefined
    const retrySignal = retrySignalResult?.signal ?? retrySignalFromParts
    const errorContentResult = containsErrorContent(parts)
    const error = info?.error ?? 
      (retrySignal && timeoutEnabled ? { name: "ProviderRateLimitError", message: retrySignal } : undefined) ??
      (errorContentResult.hasError ? { name: "MessageContentError", message: errorContentResult.errorMessage || "Message contains error content" } : undefined)
    const role = info?.role as string | undefined
    const model = extractEventModelString({
      model: info?.model,
      providerID: info?.providerID,
      modelID: info?.modelID,
      variant: info?.variant,
    })

    if (sessionID && role === "user") {
      // Internal initiator prompts (from atlas/todo-continuation) must NOT
      // clear stoppedAt or re-arm the fallback watchdog — treating them as
      // fresh user intent causes infinite retry loops.
      if (isInternalInitiatorMessage(parts) || isPendingFallbackUserContinuation({ sessionID, model, parts })) {
        handleInternalContinuationUserMessage(deps, helpers, sessionID)
        return
      }

      const messageID = typeof info?.id === "string" ? info.id : undefined
      if (await shouldSuppressRecentCompletionReplay({
        ctx,
        sessionID,
        info,
        source: "message.updated.user",
        sessionRecentCompletionUntil,
        sessionLastUserMessageIDs,
        currentUserMessageID: messageID,
      })) {
        return
      }

      recordLastUserMessageID(sessionID, messageID, sessionLastUserMessageIDs)
      sessionRecentActiveStatusUntil?.delete(sessionID)
      sessionSilentAssistantUpdateCounts?.delete(sessionID)
      resetInternalContinuationLoopForRealUser(deps, sessionID)
      clearRecentCompletionState(sessionID, sessionRecentCompletionUntil)
      sessionAwaitingFallbackResult.delete(sessionID)
      sessionStatusRetryKeys.delete(sessionID)
      // Clear the stop inhibitor so the watchdog can re-arm for this new request.
      const stateForUser = sessionStates.get(sessionID)
      if (stateForUser) {
        if (stateForUser.stoppedAt) {
          stateForUser.stoppedAt = undefined
        }
        stateForUser.lastActiveStatusRefreshAt = undefined
        stateForUser.lastErrorAt = undefined
        stateForUser.lastMeaningfulProgressAt = undefined
        stateForUser.lastTerminalIdleAt = undefined
      }
      await armActiveSessionWatchdog({
        sessionID,
        role,
        source: "message.updated.user",
        info,
        timeoutMsOverride: resolveInitialUserTimeoutOverride(model),
      })
      return
    }

    if (sessionID && role === "assistant" && !error) {
      const currentEventHasVisibleResponse = hasVisibleAssistantEventContent(
        extractAutoRetrySignal,
        {
          message: info?.message,
          parts,
        },
      )
      const hasTerminalFinish = hasTerminalAssistantFinish(info)

      if (currentEventHasVisibleResponse) {
        sessionLastAccess.set(sessionID, Date.now())
        sessionSilentAssistantUpdateCounts?.delete(sessionID)
        sessionAwaitingFallbackResult.delete(sessionID)
        sessionStatusRetryKeys.delete(sessionID)
        helpers.clearSessionTransientRetryTimeout(sessionID)
        resetInternalContinuationLoopForVisibleAssistant(deps, sessionID)
        const state = sessionStates.get(sessionID)
        if (state) {
          state.lastTerminalIdleAt = undefined
          markMeaningfulProgress(state)
          markFallbackResponseSuccess(state)
        }

        const timeoutMsOverride = resolveRecentActiveStatusTimeoutOverride(deps, sessionID)
        if (timeoutMsOverride !== undefined && !hasTerminalFinish) {
          await armActiveSessionWatchdog({
            sessionID,
            role,
            source: "message.updated.assistant.visible-progress",
            info,
            timeoutMsOverride,
          })
          log(`[${HOOK_NAME}] Assistant response observed during active generation; preserved fallback timeout`, {
            sessionID,
            model,
            timeoutMsOverride,
          })
        } else {
          sessionRecentActiveStatusUntil?.delete(sessionID)
          helpers.clearSessionFallbackTimeout(sessionID)
          log(`[${HOOK_NAME}] Assistant response observed directly in message.updated; cleared fallback timeout`, {
            sessionID,
            model,
          })
        }
        return
      }

      const state = sessionStates.get(sessionID)
      if (state?.lastMeaningfulProgressAt !== undefined) {
        sessionRecentActiveStatusUntil?.delete(sessionID)
        sessionSilentAssistantUpdateCounts?.delete(sessionID)
        log(`[${HOOK_NAME}] Ignored silent assistant update after meaningful progress`, {
          sessionID,
          model,
        })
        return
      }

      if (await shouldSuppressRecentCompletionReplay({
        ctx,
        sessionID,
        info,
        source: "message.updated.assistant",
        sessionRecentCompletionUntil,
        sessionLastUserMessageIDs,
      })) {
        return
      }

      clearRecentCompletionState(sessionID, sessionRecentCompletionUntil)
      const silentAssistantUpdateCount = (sessionSilentAssistantUpdateCounts?.get(sessionID) ?? 0) + 1
      sessionSilentAssistantUpdateCounts?.set(sessionID, silentAssistantUpdateCount)
      const timeoutMsOverride = resolveRecentActiveStatusTimeoutOverride(deps, sessionID)
        ?? (
          silentAssistantUpdateCount >= 2
            ? resolveLongRunningProgressTimeoutMs(
              deps.options?.session_timeout_ms ?? deps.config.timeout_seconds * 1000,
            )
            : undefined
        )
      await armActiveSessionWatchdog({
        sessionID,
        role,
        source: "message.updated.assistant",
        info,
        timeoutMsOverride,
      })

      const hasVisible = await checkVisibleResponse(ctx, sessionID, info)
      if (hasVisible) {
        sessionRecentActiveStatusUntil?.delete(sessionID)
        sessionSilentAssistantUpdateCounts?.delete(sessionID)
        sessionAwaitingFallbackResult.delete(sessionID)
        sessionStatusRetryKeys.delete(sessionID)
        helpers.clearSessionTransientRetryTimeout(sessionID)
        helpers.clearSessionFallbackTimeout(sessionID)
        resetInternalContinuationLoopForVisibleAssistant(deps, sessionID)
        const state = sessionStates.get(sessionID)
        if (state) {
          markMeaningfulProgress(state)
          markFallbackResponseSuccess(state)
        }
        log(`[${HOOK_NAME}] Assistant response observed; cleared fallback timeout`, { sessionID, model })
        return
      }

      if (!sessionAwaitingFallbackResult.has(sessionID)) {
        return
      }

      log(`[${HOOK_NAME}] Assistant update observed without visible final response; keeping fallback timeout`, {
        sessionID,
        model,
      })
      return
    }

    if (sessionID && role === "assistant" && error) {
      sessionRecentActiveStatusUntil?.delete(sessionID)
      sessionSilentAssistantUpdateCounts?.delete(sessionID)
      clearRecentCompletionState(sessionID, sessionRecentCompletionUntil)
      sessionAwaitingFallbackResult.delete(sessionID)
      if (sessionRetryInFlight.has(sessionID) && !retrySignal) {
        log(`[${HOOK_NAME}] message.updated fallback skipped (retry in flight)`, { sessionID })
        return
      }

      if (retrySignal && sessionRetryInFlight.has(sessionID) && timeoutEnabled) {
        log(`[${HOOK_NAME}] Overriding in-flight retry due to provider auto-retry signal`, {
          sessionID,
          model,
        })
        await helpers.abortSessionRequest(sessionID, "message.updated.retry-signal")
        sessionRetryInFlight.delete(sessionID)
      }

      if (retrySignal && timeoutEnabled) {
        log(`[${HOOK_NAME}] Detected provider auto-retry signal`, { sessionID, model })
      }

      log(`[${HOOK_NAME}] message.updated with assistant error`, {
        sessionID,
        model,
        statusCode: extractStatusCode(error, config.retry_on_errors),
        errorName: extractErrorName(error),
        errorType: classifyErrorType(error),
      })

      let state = sessionStates.get(sessionID)
      const agent = info?.agent as string | undefined
      const liveResolvedAgent = await helpers.resolveAgentForSessionFromContext(sessionID, agent)
      const resolvedAgent = liveResolvedAgent ?? state?.resolvedAgent
      const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, pluginConfig)
      const hasWrappedLocalToolAbort = containsLocalToolAbortPart(parts)

      if (fallbackModels.length === 0) {
        return
      }

      if (!state) {
        const initialModel = resolveFallbackBootstrapModel({
          sessionID,
          source: "message.updated",
          eventModel: model,
          resolvedAgent,
          pluginConfig,
        })

        if (!initialModel) {
          log(`[${HOOK_NAME}] message.updated missing model info, cannot fallback`, {
            sessionID,
            errorName: extractErrorName(error),
            errorType: classifyErrorType(error),
          })
          return
        }

        state = createFallbackState(initialModel)
        sessionStates.set(sessionID, state)
        sessionLastAccess.set(sessionID, Date.now())
      } else {
        sessionLastAccess.set(sessionID, Date.now())

        if (state.pendingFallbackModel) {
          const pendingFallbackFailed = Boolean(
            model
            && hasSameModelIdentity(model, state.pendingFallbackModel),
          )
          if (retrySignal && timeoutEnabled) {
            log(`[${HOOK_NAME}] Clearing pending fallback due to provider auto-retry signal`, {
              sessionID,
              pendingFallbackModel: state.pendingFallbackModel,
            })
            state.pendingFallbackModel = undefined
          } else if (pendingFallbackFailed) {
            log(`[${HOOK_NAME}] Clearing pending fallback because the pending model itself failed`, {
              sessionID,
              pendingFallbackModel: state.pendingFallbackModel,
              failedModel: model,
            })
            state.pendingFallbackModel = undefined
          } else {
            log(`[${HOOK_NAME}] message.updated fallback skipped (pending fallback in progress)`, {
              sessionID,
              pendingFallbackModel: state.pendingFallbackModel,
            })
            return
          }
        }
      }

      if (resolvedAgent) {
        state.resolvedAgent = resolvedAgent
      }

      if (hasWrappedLocalToolAbort) {
        markLocalToolAbort(state)
      }

      const effectiveError =
        isAbortWrapperError(error) && isRecentLocalToolAbort(state)
          ? { name: "LocalToolAbortWrappedError", message: "Tool execution aborted" }
          : error

      const retryable = isRetryableError(effectiveError, config.retry_on_errors)
      const action = getRuntimeFallbackAction(effectiveError, config.retry_on_errors)

      if (
        retryable
        && isSameModelRetryAction(action)
        && sessionTransientRetryTimeouts.has(sessionID)
      ) {
        log(`[${HOOK_NAME}] message.updated transient retry already scheduled; preserving existing timer`, {
          sessionID,
          model,
        })
        return
      }

      if (!retrySignal) {
        helpers.clearSessionFallbackTimeout(sessionID)
      }

      if (!retryable) {
        log(`[${HOOK_NAME}] message.updated error not retryable, skipping fallback`, {
          sessionID,
          statusCode: extractStatusCode(effectiveError, config.retry_on_errors),
          errorName: extractErrorName(effectiveError),
          errorType: classifyErrorType(effectiveError),
        })
        return
      }

      markSessionError(state)

      logTrackedProvider403({
        source: "message.updated.assistant.error",
        sessionID,
        model: state.currentModel,
        resolvedAgent,
        error: effectiveError,
        action: getRuntimeFallbackAction(effectiveError, config.retry_on_errors),
      })

      if (await maybePauseForManualProviderClearance(deps, helpers, {
        sessionID,
        resolvedAgent,
        model: state.currentModel,
        error: effectiveError,
        source: "message.updated.assistant.error",
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

      if (isSameModelRetryAction(action)) {
        if (preferFreshTrackedProvider403Handoff) {
          const freshRetried = await helpers.retryCurrentModelInFreshSession(
            sessionID,
            resolvedAgent,
            "message.updated",
          )
          if (freshRetried) {
            return
          }
        }

        const maxAttempts = getSameModelRetryAttemptLimit(effectiveError, action)
        const retried = await helpers.retryCurrentModel(sessionID, resolvedAgent, "message.updated", {
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
            "message.updated",
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
        source: `message.updated.${effectiveAction}`,
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
  }
}
