import type { AutoRetryHelpers } from "./auto-retry"
import { HOOK_NAME } from "./constants"
import { markSessionStopped, resetTransientRetryState } from "./fallback-state"
import type { HookDeps } from "./types"
import { log } from "../../shared/logger"

export function resetInternalContinuationLoopForRealUser(deps: HookDeps, sessionID: string): void {
  deps.loopDetector.reset(sessionID)
}

export function resetInternalContinuationLoopForVisibleAssistant(deps: HookDeps, sessionID: string): void {
  deps.loopDetector.recordVisibleResponse(sessionID)
  const state = deps.sessionStates.get(sessionID)
  if (state?.stoppedAt) {
    state.stoppedAt = undefined
  }
}

export function handleInternalContinuationUserMessage(
  deps: HookDeps,
  helpers: Pick<AutoRetryHelpers, "clearSessionFallbackTimeout">,
  sessionID: string,
): void {
  const result = deps.loopDetector.recordInternalContinuation(sessionID)

  log(`[${HOOK_NAME}] Skipping watchdog re-arm for internal initiator message`, {
    sessionID,
    source: "message.updated.user.internal",
    internalContinuationCount: result.count,
    terminal: result.isTerminal,
  })

  if (!result.isTerminal) {
    return
  }

  helpers.clearSessionFallbackTimeout(sessionID)
  deps.sessionRetryInFlight.delete(sessionID)
  deps.sessionAwaitingFallbackResult.delete(sessionID)
  deps.sessionStatusRetryKeys.delete(sessionID)

  const state = deps.sessionStates.get(sessionID)
  if (state) {
    markSessionStopped(state)
    state.pendingFallbackModel = undefined
    resetTransientRetryState(state)
  }

  log(`[${HOOK_NAME}] Terminal internal continuation loop detected by runtime-fallback`, {
    sessionID,
    source: "message.updated.user.internal",
    internalContinuationCount: result.count,
    hasState: Boolean(state),
  })
}
