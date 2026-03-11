import type { HookDeps } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { HOOK_NAME } from "./constants"
import { log } from "../../shared/logger"
import { isRetryableError } from "./error-classifier"
import { createFallbackState, prepareFallback } from "./fallback-state"
import { getFallbackModelsForSession } from "./fallback-models"
import { extractRetryAttempt, extractRetryStatusModel, normalizeRetryStatusMessage } from "../../shared/retry-status-utils"

type SessionStatus = {
  type?: string
  message?: string
  attempt?: number
}

function resolveInitialModel(
  props: Record<string, unknown> | undefined,
  retryMessage: string,
  resolvedAgent: string | undefined,
  pluginConfig: HookDeps["pluginConfig"],
): string | undefined {
  const eventModel = typeof props?.model === "string" ? props.model : undefined
  if (eventModel) {
    return eventModel
  }

  const retryModel = extractRetryStatusModel(retryMessage)
  if (retryModel) {
    return retryModel
  }

  const agentConfig = resolvedAgent
    ? pluginConfig?.agents?.[resolvedAgent as keyof typeof pluginConfig.agents]
    : undefined

  return typeof agentConfig?.model === "string" ? agentConfig.model : undefined
}

export function createSessionStatusHandler(deps: HookDeps, helpers: AutoRetryHelpers): {
  clearRetryKey: (sessionID: string) => void
  handleSessionStatus: (props: Record<string, unknown> | undefined) => Promise<void>
} {
  const {
    config,
    pluginConfig,
    sessionStates,
    sessionLastAccess,
    sessionRetryInFlight,
    sessionAwaitingFallbackResult,
  } = deps
  const sessionStatusRetryKeys = new Map<string, string>()

  const clearRetryKey = (sessionID: string): void => {
    sessionStatusRetryKeys.delete(sessionID)
  }

  const handleSessionStatus = async (props: Record<string, unknown> | undefined): Promise<void> => {
    const sessionID = props?.sessionID as string | undefined
    const status = props?.status as SessionStatus | undefined
    const agent = props?.agent as string | undefined
    const timeoutEnabled = config.timeout_seconds > 0

    if (!sessionID || status?.type !== "retry" || !timeoutEnabled) {
      return
    }

    const retryMessage = typeof status.message === "string" ? status.message : ""
    if (!retryMessage || !isRetryableError({ message: retryMessage }, config.retry_on_errors)) {
      return
    }

    const currentState = sessionStates.get(sessionID)
    const retryAttempt = extractRetryAttempt(status.attempt, retryMessage)
    const retryModel =
      (typeof props?.model === "string" ? props.model : undefined) ??
      extractRetryStatusModel(retryMessage) ??
      currentState?.currentModel ??
      "unknown-model"
    const retryKey = `${retryAttempt}:${retryModel}:${normalizeRetryStatusMessage(retryMessage)}`

    if (sessionStatusRetryKeys.get(sessionID) === retryKey) {
      return
    }
    sessionStatusRetryKeys.set(sessionID, retryKey)

    if (sessionRetryInFlight.has(sessionID)) {
      log(`[${HOOK_NAME}] Overriding in-flight retry due to provider session.status retry signal`, {
        sessionID,
        retryModel,
      })
      await helpers.abortSessionRequest(sessionID, "session.status.retry-signal")
      sessionRetryInFlight.delete(sessionID)
    }

    sessionAwaitingFallbackResult.delete(sessionID)

    const resolvedAgent = await helpers.resolveAgentForSessionFromContext(sessionID, agent)
    const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, pluginConfig)

    if (fallbackModels.length === 0) {
      log(`[${HOOK_NAME}] No fallback models configured`, { sessionID, agent: resolvedAgent ?? agent })
      return
    }

    let state = currentState
    if (!state) {
      const initialModel = resolveInitialModel(props, retryMessage, resolvedAgent, pluginConfig)
      if (!initialModel) {
        log(`[${HOOK_NAME}] session.status retry missing model info, cannot fallback`, { sessionID })
        return
      }

      state = createFallbackState(initialModel)
      sessionStates.set(sessionID, state)
    }

    sessionLastAccess.set(sessionID, Date.now())

    if (state.pendingFallbackModel) {
      log(`[${HOOK_NAME}] Clearing pending fallback due to provider session.status retry signal`, {
        sessionID,
        pendingFallbackModel: state.pendingFallbackModel,
      })
      state.pendingFallbackModel = undefined
    }

    log(`[${HOOK_NAME}] Detected provider auto-retry signal in session.status`, {
      sessionID,
      model: state.currentModel,
      retryAttempt,
    })

    const result = prepareFallback(sessionID, state, fallbackModels, config)

    if (result.success && config.notify_on_fallback) {
      await deps.ctx.client.tui
        .showToast({
          body: {
            title: "Model Fallback",
            message: `Switching to ${result.newModel?.split("/").pop() || result.newModel} for next request`,
            variant: "warning",
            duration: 5000,
          },
        })
        .catch(() => {})
    }

    if (result.success && result.newModel) {
      await helpers.autoRetryWithFallback(sessionID, result.newModel, resolvedAgent, "session.status")
      return
    }

    log(`[${HOOK_NAME}] Fallback preparation failed`, { sessionID, error: result.error })
  }

  return {
    clearRetryKey,
    handleSessionStatus,
  }
}
