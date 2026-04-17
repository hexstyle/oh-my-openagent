const RECENT_RUNTIME_FALLBACK_CONTINUATIONS = new Map<string, number>()

export const RECENT_RUNTIME_FALLBACK_CONTINUATION_GUARD_MS = 5_000

export function markRecentRuntimeFallbackContinuationDispatch(
  sessionID: string,
  timestamp: number = Date.now(),
): void {
  RECENT_RUNTIME_FALLBACK_CONTINUATIONS.set(sessionID, timestamp)
}

export function wasRecentRuntimeFallbackContinuationDispatched(
  sessionID: string,
  options?: {
    now?: number
    guardMs?: number
  },
): boolean {
  const dispatchedAt = RECENT_RUNTIME_FALLBACK_CONTINUATIONS.get(sessionID)
  if (typeof dispatchedAt !== "number") {
    return false
  }

  const now = options?.now ?? Date.now()
  const guardMs = options?.guardMs ?? RECENT_RUNTIME_FALLBACK_CONTINUATION_GUARD_MS
  if (now - dispatchedAt >= guardMs) {
    RECENT_RUNTIME_FALLBACK_CONTINUATIONS.delete(sessionID)
    return false
  }

  return true
}

export function clearRecentRuntimeFallbackContinuationDispatch(sessionID: string): void {
  RECENT_RUNTIME_FALLBACK_CONTINUATIONS.delete(sessionID)
}

export function resetRecentRuntimeFallbackContinuationDispatchesForTests(): void {
  RECENT_RUNTIME_FALLBACK_CONTINUATIONS.clear()
}
