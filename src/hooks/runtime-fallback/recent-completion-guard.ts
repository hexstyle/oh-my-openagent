import type { HookDeps } from "./types"
import { HOOK_NAME } from "./constants"
import { log } from "../../shared/logger"
import { extractAutoRetrySignal } from "./error-classifier"
import { hasVisibleAssistantResponse } from "./visible-assistant-response"

const RECENT_COMPLETION_SUPPRESSION_MS = 5_000

const checkVisibleAssistantResponse = hasVisibleAssistantResponse(extractAutoRetrySignal)

export function markSessionRecentlyCompleted(
  sessionID: string,
  sessionRecentCompletionUntil: Map<string, number>,
): void {
  sessionRecentCompletionUntil.set(sessionID, Date.now() + RECENT_COMPLETION_SUPPRESSION_MS)
}

export function clearRecentCompletionState(
  sessionID: string,
  sessionRecentCompletionUntil: Map<string, number>,
): void {
  sessionRecentCompletionUntil.delete(sessionID)
}

export function recordLastUserMessageID(
  sessionID: string,
  messageID: string | undefined,
  sessionLastUserMessageIDs: Map<string, string>,
): void {
  if (typeof messageID !== "string") {
    return
  }

  const normalizedMessageID = messageID.trim()
  if (normalizedMessageID.length === 0) {
    return
  }

  sessionLastUserMessageIDs.set(sessionID, normalizedMessageID)
}

export async function shouldSuppressRecentCompletionReplay(args: {
  ctx: HookDeps["ctx"]
  sessionID: string
  info?: Record<string, unknown>
  source: string
  sessionRecentCompletionUntil: Map<string, number>
  sessionLastUserMessageIDs: Map<string, string>
  currentUserMessageID?: string
}): Promise<boolean> {
  const completionDeadline = args.sessionRecentCompletionUntil.get(args.sessionID)
  if (typeof completionDeadline !== "number") {
    return false
  }

  if (completionDeadline <= Date.now()) {
    args.sessionRecentCompletionUntil.delete(args.sessionID)
    return false
  }

  const currentUserMessageID = args.currentUserMessageID?.trim()
  const previousUserMessageID = args.sessionLastUserMessageIDs.get(args.sessionID)
  if (
    currentUserMessageID &&
    previousUserMessageID &&
    currentUserMessageID !== previousUserMessageID
  ) {
    args.sessionRecentCompletionUntil.delete(args.sessionID)
    return false
  }

  const hasVisibleAssistant = await checkVisibleAssistantResponse(
    args.ctx,
    args.sessionID,
    args.info,
  )
  if (!hasVisibleAssistant) {
    args.sessionRecentCompletionUntil.delete(args.sessionID)
    return false
  }

  log(`[${HOOK_NAME}] Suppressed stale runtime-fallback re-arm after recent session completion`, {
    sessionID: args.sessionID,
    source: args.source,
    currentUserMessageID: currentUserMessageID || undefined,
    previousUserMessageID,
  })
  return true
}
