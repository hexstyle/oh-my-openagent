import type { HookDeps } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import {
  ACTIVE_STATUS_MESSAGE_UPDATE_GRACE_MS,
  HOOK_NAME,
  RETRYABLE_ERROR_PATTERNS,
  resolveLongRunningProgressTimeoutMs,
} from "./constants"
import { log } from "../../shared/logger"
import { extractAutoRetrySignal } from "./error-classifier"
import { canRefreshFromActiveStatus, createFallbackState, hasSameModelIdentity, markActiveStatusRefresh, markLimitError } from "./fallback-state"
import { getFallbackModelsForSession } from "./fallback-models"
import { normalizeRetryStatusMessage, extractRetryAttempt } from "../../shared/retry-status-utils"
import { resolveFallbackBootstrapModel } from "./fallback-bootstrap-model"
import { dispatchFallbackRetry } from "./fallback-retry-dispatcher"
import {
  getSameModelRetryAttemptLimit,
  getRuntimeFallbackAction,
  getRuntimeFallbackTier,
  isPersistentSameModelRetryAction,
  isSameModelRetryAction,
  selectFallbackModelsForAction,
} from "./fallback-policy"
import { isQuotaAutoRetrySignal } from "./error-classifier"
import { logTrackedProvider403, shouldPreferFreshTrackedProvider403Handoff } from "./provider-403-diagnostics"
import { maybePauseForManualProviderClearance } from "./manual-provider-clearance"
import {
  clearRecentCompletionState,
  shouldSuppressRecentCompletionReplay,
} from "./recent-completion-guard"
import { getRuntimeFallbackSessionID } from "./session-id"
import { applyScopedFallbackSessionHint } from "./scoped-fallback-hints"
import { getAwaitingScopedFallbackParentSessionID } from "./scoped-fallback-parent-watch"

const ACTIVE_SESSION_STATUS_TYPES = new Set(["busy", "running"])

export function createSessionStatusHandler(
  deps: HookDeps,
  helpers: AutoRetryHelpers,
  sessionStatusRetryKeys: Map<string, string>,
) {
  const {
    ctx,
    pluginConfig,
    sessionStates,
    sessionLastAccess,
    sessionLastUserMessageIDs,
    sessionRecentCompletionUntil,
    sessionRecentActiveStatusUntil,
    sessionRetryInFlight,
  } = deps

  return async (props: Record<string, unknown> | undefined) => {
    const sessionID = getRuntimeFallbackSessionID(props)
    const status = props?.status as { type?: string; message?: string; attempt?: number } | undefined
    const agent = props?.agent as string | undefined
    const model = props?.model as string | undefined
    const timeoutEnabled = deps.config.timeout_seconds > 0

    if (!sessionID) return

    if (timeoutEnabled && status?.type && ACTIVE_SESSION_STATUS_TYPES.has(status.type)) {
      if (await shouldSuppressRecentCompletionReplay({
        ctx,
        sessionID,
        source: "session.status.active",
        sessionRecentCompletionUntil,
        sessionLastUserMessageIDs,
      })) {
        return
      }

      clearRecentCompletionState(sessionID, sessionRecentCompletionUntil)
      const liveResolvedAgent = await helpers.resolveAgentForSessionFromContext(sessionID, agent)
      let state = sessionStates.get(sessionID)
      const resolvedAgent = liveResolvedAgent ?? state?.resolvedAgent
      if (!state) {
        const initialModel = resolveFallbackBootstrapModel({
          sessionID,
          source: "session.status.active",
          eventModel: model,
          resolvedAgent,
          pluginConfig,
        })

        if (initialModel) {
          state = createFallbackState(initialModel)
          applyScopedFallbackSessionHint(deps, sessionID, state)
          sessionStates.set(sessionID, state)
        }
      }

      if (state) {
        if (resolvedAgent) {
          state.resolvedAgent = resolvedAgent
        }
        if (!canRefreshFromActiveStatus(state)) {
          log(`[${HOOK_NAME}] Ignored repeated active session.status without new progress`, {
            sessionID,
            statusType: status.type,
            model: state.currentModel,
            resolvedAgent,
          })
          return
        }
        sessionLastAccess.set(sessionID, Date.now())
        const baseTimeoutMs = deps.options?.session_timeout_ms ?? deps.config.timeout_seconds * 1000
        sessionRecentActiveStatusUntil?.set(
          sessionID,
          Date.now() + ACTIVE_STATUS_MESSAGE_UPDATE_GRACE_MS,
        )
        helpers.scheduleSessionFallbackTimeout(sessionID, {
          resolvedAgent,
          source: "session.status.active",
          timeoutMsOverride: resolveLongRunningProgressTimeoutMs(baseTimeoutMs),
        })
        const awaitingScopedFallbackParentSessionID = getAwaitingScopedFallbackParentSessionID(
          deps,
          sessionID,
          state,
        )
        if (awaitingScopedFallbackParentSessionID) {
          sessionLastAccess.set(awaitingScopedFallbackParentSessionID, Date.now())
          helpers.scheduleSessionFallbackTimeout(awaitingScopedFallbackParentSessionID, {
            resolvedAgent:
              sessionStates.get(awaitingScopedFallbackParentSessionID)?.resolvedAgent
              ?? resolvedAgent,
            source: "session.status.active.awaiting-fallback-parent",
            timeoutMsOverride: resolveLongRunningProgressTimeoutMs(baseTimeoutMs),
          })
        }
        markActiveStatusRefresh(state)

        log(`[${HOOK_NAME}] Refreshed fallback timeout after active session.status`, {
          sessionID,
          statusType: status.type,
          model: state.currentModel,
          resolvedAgent,
          timeoutMsOverride: resolveLongRunningProgressTimeoutMs(baseTimeoutMs),
        })
      }

      return
    }

    if (status?.type !== "retry") return

    const retryMessage = typeof status.message === "string" ? status.message : ""
    const retrySignal = extractAutoRetrySignal({ status: retryMessage, message: retryMessage })
    if (!retrySignal) {
      // Fallback: status.type is already "retry", so check the message against
      // retryable error patterns directly. This handles providers like Gemini whose
      // retry status message may not contain "retrying in" text alongside the error.
      const messageLower = retryMessage.toLowerCase()
      const matchesRetryablePattern = RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(messageLower))
      if (!matchesRetryablePattern) return
    }

    const retryKey = `${extractRetryAttempt(status.attempt, retryMessage)}:${normalizeRetryStatusMessage(retryMessage)}`
    if (sessionStatusRetryKeys.get(sessionID) === retryKey) {
      return
    }
    sessionStatusRetryKeys.set(sessionID, retryKey)

    if (sessionRetryInFlight.has(sessionID)) {
      if (timeoutEnabled) {
        log(`[${HOOK_NAME}] Overriding in-flight retry due to provider auto-retry signal`, {
          sessionID,
          model,
        })
        await helpers.abortSessionRequest(sessionID, "session.status.retry-signal")
        sessionRetryInFlight.delete(sessionID)
      } else {
        log(`[${HOOK_NAME}] session.status retry skipped — retry already in flight`, { sessionID })
        return
      }
    }

    const liveResolvedAgent = await helpers.resolveAgentForSessionFromContext(sessionID, agent)
    const existingState = sessionStates.get(sessionID)
    const resolvedAgent = liveResolvedAgent ?? existingState?.resolvedAgent
    const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, pluginConfig)
    if (fallbackModels.length === 0) {
      if (!sessionStates.has(sessionID)) {
        sessionStatusRetryKeys.delete(sessionID)
      }
      return
    }

    let state = sessionStates.get(sessionID)
    if (!state) {
      const initialModel = resolveFallbackBootstrapModel({
        sessionID,
        source: "session.status",
        eventModel: model,
        resolvedAgent,
        pluginConfig,
      })
      if (!initialModel) {
        sessionStatusRetryKeys.delete(sessionID)
        log(`[${HOOK_NAME}] session.status retry missing model info, cannot fallback`, { sessionID })
        return
      }

      state = createFallbackState(initialModel)
      applyScopedFallbackSessionHint(deps, sessionID, state)
      sessionStates.set(sessionID, state)
    }

    if (resolvedAgent) {
      state.resolvedAgent = resolvedAgent
    }
    sessionLastAccess.set(sessionID, Date.now())

    if (state.pendingFallbackModel) {
      const isCurrentPendingModelRetry =
        typeof model === "string" && hasSameModelIdentity(model, state.currentModel)

      if (!isCurrentPendingModelRetry) {
        log(`[${HOOK_NAME}] session.status retry skipped (pending fallback in progress)`, {
          sessionID,
          model,
          currentModel: state.currentModel,
          pendingFallbackModel: state.pendingFallbackModel,
        })
        return
      }

      if (timeoutEnabled) {
        log(`[${HOOK_NAME}] Clearing pending fallback due to provider auto-retry signal`, {
          sessionID,
          model,
          currentModel: state.currentModel,
          pendingFallbackModel: state.pendingFallbackModel,
        })
        state.pendingFallbackModel = undefined
      } else {
        log(`[${HOOK_NAME}] session.status retry skipped (pending fallback in progress)`, {
          sessionID,
          model,
          currentModel: state.currentModel,
          pendingFallbackModel: state.pendingFallbackModel,
        })
        return
      }
    }

    // Route quota/rate-limit signals through limit_fallback (remaining paid chain before free)
    // so we don't waste quota retrying paid models.
    const isQuota = isQuotaAutoRetrySignal(retryMessage)
    if (isQuota) {
      markLimitError(state)
    }
    const statusFallbackModels = isQuota
      ? selectFallbackModelsForAction({ currentModel: state.currentModel, fallbackModels, action: "limit_fallback" })
      : fallbackModels

    log(`[${HOOK_NAME}] Detected provider auto-retry signal in session.status`, {
      sessionID,
      model: state.currentModel,
      retryAttempt: status.attempt,
      isQuota,
    })

    const retryAction = getRuntimeFallbackAction({ message: retryMessage }, deps.config.retry_on_errors)
    logTrackedProvider403({
      source: "session.status.retry",
      sessionID,
      model: state.currentModel,
      resolvedAgent,
      error: { message: retryMessage },
      action: retryAction,
    })

    if (await maybePauseForManualProviderClearance(deps, helpers, {
      sessionID,
      resolvedAgent,
      model: state.currentModel,
      error: { message: retryMessage },
      source: "session.status.retry",
    })) {
      return
    }

    const preferFreshTrackedProvider403Handoff =
      getRuntimeFallbackTier(state.currentModel) === "paid"
      && shouldPreferFreshTrackedProvider403Handoff({
        model: state.currentModel,
        error: { message: retryMessage },
        isScopedFallbackChild: state.isScopedFallbackChild,
      })

    if (isSameModelRetryAction(retryAction)) {
      const maxAttempts = getSameModelRetryAttemptLimit({ message: retryMessage }, retryAction)
      if (preferFreshTrackedProvider403Handoff) {
        await helpers.abortSessionRequest(sessionID, "session.status.tracked-provider-403")
        const freshRetried = await helpers.retryCurrentModelInFreshSession(
          sessionID,
          resolvedAgent,
          "session.status",
        )
        if (freshRetried) {
          return
        }
      }

      await helpers.abortSessionRequest(sessionID, "session.status.transient-retry")

      const retried = await helpers.retryCurrentModel(
        sessionID,
        resolvedAgent,
        "session.status.transient_same_model",
        {
          immediate: retryAction === "retry_same_model",
          persistent: isPersistentSameModelRetryAction(retryAction),
          maxAttempts,
        },
      )
      if (retried) {
        return
      }

      if (!preferFreshTrackedProvider403Handoff && getRuntimeFallbackTier(state.currentModel) === "paid") {
        const freshRetried = await helpers.retryCurrentModelInFreshSession(
          sessionID,
          resolvedAgent,
          "session.status",
        )
        if (freshRetried) {
          return
        }
      }
    }

    await helpers.abortSessionRequest(sessionID, "session.status.retry-signal")

    await dispatchFallbackRetry(deps, helpers, {
      sessionID,
      state,
      fallbackModels: statusFallbackModels,
      resolvedAgent,
      source: `session.status.${isQuota ? "limit_fallback" : "fallback_chain"}`,
      prepareFallbackOptions:
        (
          isSameModelRetryAction(retryAction) && getRuntimeFallbackTier(state.currentModel) === "paid"
        ) || (isQuota && getRuntimeFallbackTier(state.currentModel) !== "paid")
          ? {
            ...(isSameModelRetryAction(retryAction) && getRuntimeFallbackTier(state.currentModel) === "paid"
              ? { skipFailedModelCooldown: true }
              : {}),
            ...(isQuota && getRuntimeFallbackTier(state.currentModel) !== "paid"
              ? { ignoreCandidateCooldown: true }
              : {}),
          }
          : undefined,
    })
  }
}
