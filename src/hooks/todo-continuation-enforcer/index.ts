import type { PluginInput } from "@opencode-ai/plugin"

import { log } from "../../shared/logger"

import { DEFAULT_SKIP_AGENTS, HOOK_NAME } from "./constants"
import { createTodoContinuationHandler } from "./handler"
import { createSessionStateStore } from "./session-state"
import type { TodoContinuationEnforcer, TodoContinuationEnforcerOptions } from "./types"

export type { TodoContinuationEnforcer, TodoContinuationEnforcerOptions } from "./types"

export function createTodoContinuationEnforcer(
  ctx: PluginInput,
  options: TodoContinuationEnforcerOptions = {}
): TodoContinuationEnforcer {
  const {
    backgroundManager,
    skipAgents = DEFAULT_SKIP_AGENTS,
    isContinuationStopped,
  } = options

  let hasActiveWork: ((sessionID: string) => boolean) | undefined = options.hasActiveWork

  const sessionStateStore = createSessionStateStore()

  const markRecovering = (sessionID: string): void => {
    const state = sessionStateStore.getState(sessionID)
    state.isRecovering = true
    sessionStateStore.cancelCountdown(sessionID)
    log(`[${HOOK_NAME}] Session marked as recovering`, { sessionID })
  }

  const markRecoveryComplete = (sessionID: string): void => {
    const state = sessionStateStore.getExistingState(sessionID)
    if (state) {
      state.isRecovering = false
      log(`[${HOOK_NAME}] Session recovery complete`, { sessionID })
    }
  }

  const activeWorkRef = { current: hasActiveWork }
  const handler = createTodoContinuationHandler({
    ctx,
    sessionStateStore,
    backgroundManager,
    skipAgents,
    isContinuationStopped,
    hasActiveWork: (sessionID: string) => activeWorkRef.current?.(sessionID) ?? false,
  })

  const cancelAllCountdowns = (): void => {
    sessionStateStore.cancelAllCountdowns()
    log(`[${HOOK_NAME}] All countdowns cancelled`)
  }

  return {
    handler,
    markRecovering,
    markRecoveryComplete,
    cancelAllCountdowns,
    setHasActiveWork: (fn: (sessionID: string) => boolean) => { activeWorkRef.current = fn },
    dispose: () => sessionStateStore.shutdown(),
  }
}
