import type { PluginInput } from "@opencode-ai/plugin"

import type { BackgroundManager } from "../../features/background-agent"
import { DEFAULT_CONFIG as DEFAULT_RUNTIME_FALLBACK_CONFIG } from "../runtime-fallback/constants"
import { getRuntimeFallbackAction, isSameModelRetryAction } from "../runtime-fallback/fallback-policy"
import {
  clearContinuationMarker,
  setContinuationMarkerSource,
} from "../../features/run-continuation-state"
import { log } from "../../shared/logger"

import { DEFAULT_SKIP_AGENTS, HOOK_NAME } from "./constants"
import { armCompactionGuard } from "./compaction-guard"
import type { SessionStateStore } from "./session-state"
import { handleSessionIdle } from "./idle-event"
import { handleNonIdleEvent } from "./non-idle-events"

function getSessionID(properties: Record<string, unknown> | undefined): string | undefined {
  if (!properties) return undefined
  const directSessionID = properties.sessionID
  if (typeof directSessionID === "string" && directSessionID.length > 0) {
    return directSessionID
  }

  const camelSessionID = properties.sessionId
  if (typeof camelSessionID === "string" && camelSessionID.length > 0) {
    return camelSessionID
  }

  const info = properties.info as Record<string, unknown> | undefined
  if (!info) return undefined

  const nestedSessionID = info.sessionID
  if (typeof nestedSessionID === "string" && nestedSessionID.length > 0) {
    return nestedSessionID
  }

  const nestedCamelSessionID = info.sessionId
  if (typeof nestedCamelSessionID === "string" && nestedCamelSessionID.length > 0) {
    return nestedCamelSessionID
  }

  const infoID = info.id
  if (typeof infoID === "string" && infoID.length > 0) {
    return infoID
  }

  return undefined
}

export function createTodoContinuationHandler(args: {
  ctx: PluginInput
  sessionStateStore: SessionStateStore
  backgroundManager?: BackgroundManager
  skipAgents?: string[]
  isContinuationStopped?: (sessionID: string) => boolean
  hasActiveWork?: (sessionID: string) => boolean
}): (input: { event: { type: string; properties?: unknown } }) => Promise<void> {
  const {
    ctx,
    sessionStateStore,
    backgroundManager,
    skipAgents = DEFAULT_SKIP_AGENTS,
    isContinuationStopped,
    hasActiveWork,
  } = args

  return async ({ event }: { event: { type: string; properties?: unknown } }): Promise<void> => {
    const props = event.properties as Record<string, unknown> | undefined

    if (event.type === "session.error") {
      const sessionID = getSessionID(props)
      if (!sessionID) return

      const error = props?.error as { name?: string } | undefined
      if (error?.name === "MessageAbortedError" || error?.name === "AbortError") {
        const state = sessionStateStore.getState(sessionID)
        state.abortDetectedAt = Date.now()
        log(`[${HOOK_NAME}] Abort detected via session.error`, { sessionID, errorName: error.name })
      }

      const retryAction = getRuntimeFallbackAction(
        props?.error,
        DEFAULT_RUNTIME_FALLBACK_CONFIG.retry_on_errors,
      )
      if (isSameModelRetryAction(retryAction)) {
        const state = sessionStateStore.getState(sessionID)
        state.transientRetryDetectedAt = Date.now()
        log(`[${HOOK_NAME}] Runtime fallback transient retry detected via session.error`, {
          sessionID,
          retryAction,
        })
      }

      setContinuationMarkerSource(ctx.directory, sessionID, "todo", "idle")
      sessionStateStore.cancelCountdown(sessionID)
      log(`[${HOOK_NAME}] session.error`, { sessionID })
      return
    }

    if (event.type === "session.idle") {
      const sessionID = getSessionID(props)
      if (!sessionID) return

      try {
        await handleSessionIdle({
          ctx,
          sessionID,
          sessionStateStore,
          backgroundManager,
          skipAgents,
          isContinuationStopped,
          hasActiveWork,
        })
      } catch (error) {
        log(`[${HOOK_NAME}] session.idle handling failed`, {
          sessionID,
          error: String(error),
        })
      }
      return
    }

    if (event.type === "session.compacted") {
      const sessionID = getSessionID(props)
      if (sessionID) {
        const state = sessionStateStore.getState(sessionID)
        const compactionEpoch = armCompactionGuard(state, Date.now())
        sessionStateStore.cancelCountdown(sessionID)
        log(`[${HOOK_NAME}] Session compacted: armed compaction guard`, { sessionID, compactionEpoch })
      }
      return
    }

    if (event.type === "session.deleted") {
      const sessionInfo = props?.info as { id?: string } | undefined
      if (sessionInfo?.id) {
        clearContinuationMarker(ctx.directory, sessionInfo.id)
      }
    }

    handleNonIdleEvent({
      directory: ctx.directory,
      eventType: event.type,
      properties: props,
      sessionStateStore,
    })
  }
}
