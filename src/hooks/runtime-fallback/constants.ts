/**
 * Runtime Fallback Hook - Constants
 *
 * Default values and configuration constants for the runtime fallback feature.
 */

import type { RuntimeFallbackConfig } from "../../config"

/**
 * Default configuration values for runtime fallback
 */
export const DEFAULT_CONFIG: Required<RuntimeFallbackConfig> = {
  enabled: false,
  retry_on_errors: [402, 429, 500, 502, 503, 504],
  max_fallback_attempts: 3,
  max_full_chain_cycles: 5,
  cooldown_seconds: 60,
  timeout_seconds: 30,
  transient_retry_window_seconds: 15 * 60,
  transient_retry_initial_delay_seconds: 10,
  transient_retry_max_delay_seconds: 5 * 60,
  notify_on_fallback: true,
}

/**
 * Error patterns that indicate rate limiting or temporary failures
 * These are checked in addition to HTTP status codes
 */
export const RETRYABLE_ERROR_PATTERNS = [
  /rate.?limit/i,
  /too.?many.?requests/i,
  /quota.?exceeded/i,
  /quota\s+will\s+reset\s+after/i,
  /(?:you(?:'ve|\s+have)\s+)?reached\s+your\s+usage\s+limit/i,
  /all\s+credentials\s+for\s+model/i,
  /cool(?:ing)?\s+down/i,
  /exhausted\s+your\s+capacity/i,
  /usage\s+limit\s+has\s+been\s+reached/i,
  /model.{0,20}?not.{0,10}?supported/i,
  /model_not_supported/i,
  /service.?unavailable/i,
  /internal[_\s-]*server[_\s-]*error/i,
  /overloaded/i,
  /temporarily.?unavailable/i,
  /try.?again/i,
  /credit.*balance.*too.*low/i,
  /insufficient.?(?:credits?|funds?|balance)/i,
  /subscription.*quota/i,
  /billing.?(?:hard.?)?limit/i,
  /payment.?required/i,
  /out\s+of\s+credits?/i,
  /extra\s+usage\s+is\s+required\s+for\s+long\s+context\s+requests/i,
  /(?:^|\s)402(?:\s|$)/,
  /(?:^|\s)429(?:\s|$)/,
  /(?:^|\s)503(?:\s|$)/,
  /(?:^|\s)529(?:\s|$)/,
]

/**
 * Hook name for identification and logging
 */
export const HOOK_NAME = "runtime-fallback"
export const WATCHDOG_CONTINUATION_PROMPT = "Continue the current task from where you left off. The previous request appears stalled. Resume from the existing context, do not redo completed work, and continue."
export const LONG_RUNNING_PROGRESS_TIMEOUT_MULTIPLIER = 4
export const ACTIVE_STATUS_MESSAGE_UPDATE_GRACE_MS = 5_000

export const MODEL_RECOVERY_INTERVAL_MS = 2 * 60 * 1000
export const MODEL_RECOVERY_PROBE_MIN_INTERVAL_MS = 60 * 1000
export const MODEL_RECOVERY_PROBE_TIMEOUT_MS = 30 * 1000

export function isLongRunningAssistantProgress(args: {
  partType?: string
  toolStatus?: string
}): boolean {
  return (
    args.partType === "compaction"
    || args.partType === "tool_use"
    || args.partType === "tool-call"
    || (args.partType === "tool" && args.toolStatus === "running")
  )
}

export function resolveLongRunningProgressTimeoutMs(baseTimeoutMs: number): number {
  return baseTimeoutMs * LONG_RUNNING_PROGRESS_TIMEOUT_MULTIPLIER
}
