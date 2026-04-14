export const INTERNAL_CONTINUATION_LOOP_TERMINAL_ERROR = "Terminal internal continuation loop detected by runtime-fallback"

export function isInternalContinuationLoopTerminalError(error: string | undefined): boolean {
  return typeof error === "string" && error.includes(INTERNAL_CONTINUATION_LOOP_TERMINAL_ERROR)
}
