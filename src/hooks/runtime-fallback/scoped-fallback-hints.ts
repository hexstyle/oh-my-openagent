import type { FallbackState, HookDeps } from "./types"
import { isRuntimeFallbackScopedHandoffTitle } from "../../shared/runtime-fallback-session-titles"

function getScopedFallbackHintSet(deps: HookDeps): Set<string> {
  if (!deps.sessionScopedFallbackHints) {
    deps.sessionScopedFallbackHints = new Set()
  }

  return deps.sessionScopedFallbackHints
}

export function rememberScopedFallbackSessionHint(
  deps: HookDeps,
  sessionID: string,
  title: string | undefined,
): boolean {
  const hintSet = getScopedFallbackHintSet(deps)
  const isScopedFallbackChild = isRuntimeFallbackScopedHandoffTitle(title)

  if (isScopedFallbackChild) {
    hintSet.add(sessionID)
    return true
  }

  hintSet.delete(sessionID)
  return false
}

export function applyScopedFallbackSessionHint(
  deps: HookDeps,
  sessionID: string,
  state: FallbackState,
): void {
  if (getScopedFallbackHintSet(deps).has(sessionID)) {
    state.isScopedFallbackChild = true
  }
}

export function clearScopedFallbackSessionHint(
  deps: HookDeps,
  sessionID: string,
): void {
  getScopedFallbackHintSet(deps).delete(sessionID)
}
