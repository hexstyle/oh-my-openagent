import type { FallbackState, HookDeps } from "./types"

export function getAwaitingScopedFallbackParentSessionID(
  deps: Pick<HookDeps, "sessionAwaitingFallbackResult">,
  sessionID: string,
  state: Pick<FallbackState, "isScopedFallbackChild" | "scopedFallbackParentSessionID"> | undefined,
): string | undefined {
  if (!state?.isScopedFallbackChild) {
    return undefined
  }

  const parentSessionID = state.scopedFallbackParentSessionID?.trim()
  if (!parentSessionID || parentSessionID === sessionID) {
    return undefined
  }

  if (!deps.sessionAwaitingFallbackResult.has(parentSessionID)) {
    return undefined
  }

  return parentSessionID
}
