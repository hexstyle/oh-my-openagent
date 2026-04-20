import type { HookDeps } from "./types"
import { resolveLongRunningProgressTimeoutMs } from "./constants"

export function resolveRecentActiveStatusTimeoutOverride(
  deps: Pick<HookDeps, "options" | "config" | "sessionRecentActiveStatusUntil">,
  sessionID: string,
): number | undefined {
  const activeUntil = deps.sessionRecentActiveStatusUntil?.get(sessionID)
  if (typeof activeUntil !== "number") {
    return undefined
  }

  if (activeUntil < Date.now()) {
    deps.sessionRecentActiveStatusUntil?.delete(sessionID)
    return undefined
  }

  const baseTimeoutMs = deps.options?.session_timeout_ms ?? deps.config.timeout_seconds * 1000
  return resolveLongRunningProgressTimeoutMs(baseTimeoutMs)
}
