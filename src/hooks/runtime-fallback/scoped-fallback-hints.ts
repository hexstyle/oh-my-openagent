import type { FallbackState, HookDeps, ScopedFallbackSessionHint } from "./types"
import { isRuntimeFallbackScopedHandoffTitle } from "../../shared/runtime-fallback-session-titles"

function normalizeParentSessionID(parentSessionID: string | undefined): string | undefined {
  if (typeof parentSessionID !== "string") {
    return undefined
  }

  const normalizedParentSessionID = parentSessionID.trim()
  return normalizedParentSessionID.length > 0 ? normalizedParentSessionID : undefined
}

function getScopedFallbackHintMap(deps: HookDeps): Map<string, ScopedFallbackSessionHint> {
  if (!deps.sessionScopedFallbackHints) {
    deps.sessionScopedFallbackHints = new Map()
  }

  return deps.sessionScopedFallbackHints
}

export function rememberScopedFallbackSessionHint(
  deps: HookDeps,
  sessionID: string,
  title: string | undefined,
  parentSessionID?: string,
  bootstrapPending = false,
): boolean {
  const hintMap = getScopedFallbackHintMap(deps)
  const isScopedFallbackChild = isRuntimeFallbackScopedHandoffTitle(title)
  const normalizedParentSessionID = normalizeParentSessionID(parentSessionID)

  if (isScopedFallbackChild) {
    const previousHint = hintMap.get(sessionID)
    hintMap.set(sessionID, {
      isScopedFallbackChild: true,
      parentSessionID: normalizedParentSessionID ?? previousHint?.parentSessionID,
      bootstrapPending: bootstrapPending || previousHint?.bootstrapPending === true,
    })
    return true
  }

  hintMap.delete(sessionID)
  return false
}

export function applyScopedFallbackSessionHint(
  deps: HookDeps,
  sessionID: string,
  state: FallbackState,
): void {
  const hint = getScopedFallbackHintMap(deps).get(sessionID)
  if (hint?.isScopedFallbackChild) {
    state.isScopedFallbackChild = true
    state.scopedFallbackBootstrapPending = hint.bootstrapPending === true
    if (hint.parentSessionID) {
      state.scopedFallbackParentSessionID = hint.parentSessionID
    }
  }
}

export function getScopedFallbackParentSessionHint(
  deps: HookDeps,
  sessionID: string,
): string | undefined {
  return getScopedFallbackHintMap(deps).get(sessionID)?.parentSessionID
}

export function clearScopedFallbackSessionHint(
  deps: HookDeps,
  sessionID: string,
): void {
  getScopedFallbackHintMap(deps).delete(sessionID)
}
