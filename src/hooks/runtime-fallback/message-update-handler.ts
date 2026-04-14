import type { HookDeps } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { HOOK_NAME, resolveLongRunningProgressTimeoutMs } from "./constants"
import { log } from "../../shared/logger"
import { extractStatusCode, extractErrorName, classifyErrorType, isRetryableError, extractAutoRetrySignal, containsErrorContent } from "./error-classifier"
import { createFallbackState, markFallbackResponseSuccess, markLimitError } from "./fallback-state"
import { getFallbackModelsForSession } from "./fallback-models"
import { resolveFallbackBootstrapModel } from "./fallback-bootstrap-model"
import { dispatchFallbackRetry } from "./fallback-retry-dispatcher"
import { extractEventModelString } from "./event-model"
import { getRuntimeFallbackAction, selectFallbackModelsForAction } from "./fallback-policy"
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

  const resolveRecentActiveStatusTimeoutOverride = (sessionID: string): number | undefined => {
    const activeUntil = sessionRecentActiveStatusUntil?.get(sessionID)
    if (typeof activeUntil !== "number") {
      return undefined
    }

    if (activeUntil < Date.now()) {
      sessionRecentActiveStatusUntil?.delete(sessionID)
      return undefined
    }

    const baseTimeoutMs = deps.options?.session_timeout_ms ?? deps.config.timeout_seconds * 1000
    return resolveLongRunningProgressTimeoutMs(baseTimeoutMs)
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
    })

    if (sessionID && role === "user") {
      // Internal initiator prompts (from atlas/todo-continuation) must NOT
      // clear stoppedAt or re-arm the fallback watchdog — treating them as
      // fresh user intent causes infinite retry loops.
      if (isInternalInitiatorMessage(parts)) {
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
      if (stateForUser?.stoppedAt) {
        stateForUser.stoppedAt = undefined
      }
      await armActiveSessionWatchdog({
        sessionID,
        role,
        source: "message.updated.user",
        info,
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

      if (currentEventHasVisibleResponse) {
        sessionLastAccess.set(sessionID, Date.now())
        sessionRecentActiveStatusUntil?.delete(sessionID)
        sessionSilentAssistantUpdateCounts?.delete(sessionID)
        sessionAwaitingFallbackResult.delete(sessionID)
        sessionStatusRetryKeys.delete(sessionID)
        helpers.clearSessionFallbackTimeout(sessionID)
        resetInternalContinuationLoopForVisibleAssistant(deps, sessionID)
        const state = sessionStates.get(sessionID)
        if (state) {
          markFallbackResponseSuccess(state)
        }
        log(`[${HOOK_NAME}] Assistant response observed directly in message.updated; cleared fallback timeout`, {
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
      const timeoutMsOverride = resolveRecentActiveStatusTimeoutOverride(sessionID)
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
        helpers.clearSessionFallbackTimeout(sessionID)
        resetInternalContinuationLoopForVisibleAssistant(deps, sessionID)
        const state = sessionStates.get(sessionID)
        if (state) {
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
      const retryable = isRetryableError(error, config.retry_on_errors)
      const retryAction = retryable
        ? getRuntimeFallbackAction(error, config.retry_on_errors)
        : undefined

      if (retryAction === "retry_same_model_delayed" && sessionTransientRetryTimeouts.has(sessionID)) {
        log(`[${HOOK_NAME}] message.updated transient retry already scheduled; preserving existing timer`, {
          sessionID,
          model,
        })
        return
      }

      if (!retrySignal) {
        helpers.clearSessionFallbackTimeout(sessionID)
      }

      log(`[${HOOK_NAME}] message.updated with assistant error`, {
        sessionID,
        model,
        statusCode: extractStatusCode(error, config.retry_on_errors),
        errorName: extractErrorName(error),
        errorType: classifyErrorType(error),
      })

      if (!retryable) {
        log(`[${HOOK_NAME}] message.updated error not retryable, skipping fallback`, {
          sessionID,
          statusCode: extractStatusCode(error, config.retry_on_errors),
          errorName: extractErrorName(error),
          errorType: classifyErrorType(error),
        })
        return
      }

      const action = retryAction ?? getRuntimeFallbackAction(error, config.retry_on_errors)

      let state = sessionStates.get(sessionID)
      const agent = info?.agent as string | undefined
      const resolvedAgent = await helpers.resolveAgentForSessionFromContext(sessionID, agent)
      const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, pluginConfig)

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
          if (retrySignal && timeoutEnabled) {
            log(`[${HOOK_NAME}] Clearing pending fallback due to provider auto-retry signal`, {
              sessionID,
              pendingFallbackModel: state.pendingFallbackModel,
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

      if (action === "limit_fallback") {
        markLimitError(state)
      }

      if (action === "retry_same_model" || action === "retry_same_model_delayed") {
        const retried = await helpers.retryCurrentModel(sessionID, resolvedAgent, "message.updated", {
          immediate: action === "retry_same_model",
        })
        if (retried) {
          return
        }
      }

      const effectiveAction =
        action === "retry_same_model" || action === "retry_same_model_delayed"
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
        source: `message.updated.${effectiveAction}`,
      })
    }
  }
}
