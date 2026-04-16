import { log } from "../../shared/logger"
import { setContinuationMarkerSource } from "../../features/run-continuation-state"
import { isInternalInitiatorMessage } from "../runtime-fallback/internal-continuation-loop-detector"

import { COUNTDOWN_GRACE_PERIOD_MS, HOOK_NAME } from "./constants"
import type { SessionStateStore } from "./session-state"

export function handleNonIdleEvent(args: {
  directory?: string
  eventType: string
  properties: Record<string, unknown> | undefined
  sessionStateStore: SessionStateStore
}): void {
  const { directory, eventType, properties, sessionStateStore } = args
  const updateContinuationMarker = (sessionID: string) => {
    if (!directory) {
      return
    }
    setContinuationMarkerSource(directory, sessionID, "todo", "idle")
  }

  if (eventType === "message.updated") {
    const info = properties?.info as Record<string, unknown> | undefined
    const sessionID = info?.sessionID as string | undefined
    const role = info?.role as string | undefined
    const eventParts = properties?.parts as Array<{ type?: string; text?: string }> | undefined
    const infoParts = info?.parts as Array<{ type?: string; text?: string }> | undefined
    const parts = eventParts && eventParts.length > 0 ? eventParts : infoParts
    if (!sessionID) return

    if (role === "user") {
      if (isInternalInitiatorMessage(parts)) {
        log(`[${HOOK_NAME}] Ignoring internal user message`, { sessionID })
        return
      }

      const state = sessionStateStore.getExistingState(sessionID)
      if (state?.countdownStartedAt) {
        const elapsed = Date.now() - state.countdownStartedAt
        if (elapsed < COUNTDOWN_GRACE_PERIOD_MS) {
          log(`[${HOOK_NAME}] Ignoring user message in grace period`, { sessionID, elapsed })
          return
        }
      }
      if (state) {
        state.abortDetectedAt = undefined
        state.transientRetryDetectedAt = undefined
      }
      sessionStateStore.cancelCountdown(sessionID)
      updateContinuationMarker(sessionID)
      return
    }

    if (role === "assistant") {
      const state = sessionStateStore.getExistingState(sessionID)
      if (state) {
        state.abortDetectedAt = undefined
        state.transientRetryDetectedAt = undefined
      }
      sessionStateStore.cancelCountdown(sessionID)
      updateContinuationMarker(sessionID)
      return
    }

    return
  }

  if (eventType === "message.part.updated") {
    const info = properties?.info as Record<string, unknown> | undefined
    const sessionID = info?.sessionID as string | undefined
    const role = info?.role as string | undefined

    if (sessionID && role === "assistant") {
      const state = sessionStateStore.getExistingState(sessionID)
      if (state) {
        state.abortDetectedAt = undefined
        state.transientRetryDetectedAt = undefined
      }
      sessionStateStore.cancelCountdown(sessionID)
    }
    return
  }

  if (eventType === "tool.execute.before" || eventType === "tool.execute.after") {
    const sessionID = properties?.sessionID as string | undefined
    if (sessionID) {
      const state = sessionStateStore.getExistingState(sessionID)
      if (state) {
        state.abortDetectedAt = undefined
        state.transientRetryDetectedAt = undefined
      }
      sessionStateStore.cancelCountdown(sessionID)
      updateContinuationMarker(sessionID)
    }
    return
  }

  if (eventType === "session.deleted") {
    const sessionInfo = properties?.info as { id?: string } | undefined
    if (sessionInfo?.id) {
      sessionStateStore.cleanup(sessionInfo.id)
      log(`[${HOOK_NAME}] Session deleted: cleaned up`, { sessionID: sessionInfo.id })
    }
    return
  }
}
