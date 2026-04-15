export const RUNTIME_FALLBACK_SCOPED_HANDOFF_TITLE_PREFIX = "[runtime-fallback] Scoped Fallback"

export function isRuntimeFallbackScopedHandoffTitle(title: string | undefined): boolean {
  return typeof title === "string"
    && title.startsWith(RUNTIME_FALLBACK_SCOPED_HANDOFF_TITLE_PREFIX)
}
