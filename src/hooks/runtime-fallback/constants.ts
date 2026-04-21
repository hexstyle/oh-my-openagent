/**
 * Runtime Fallback Hook - Constants
 *
 * Default values and configuration constants for the runtime fallback feature.
 */

import type { ResolvedRuntimeFallbackConfig } from "./types"

/**
 * Default configuration values for runtime fallback
 */
export const DEFAULT_CONFIG: ResolvedRuntimeFallbackConfig = {
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
  manual_provider_clearance_enabled: false,
  manual_provider_clearance_pause_window_seconds: 10 * 60,
  manual_provider_clearance_notify_on_pause: true,
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
export const FALLBACK_CONTINUATION_PROMPT = "[runtime-fallback] Continue the current task from the existing session context on the new model. Do not restate the user request or redo completed work."
export const LONG_RUNNING_PROGRESS_TIMEOUT_MULTIPLIER = 4
export const ACTIVE_STATUS_MESSAGE_UPDATE_GRACE_MS = 5_000
const LONG_RUNNING_PENDING_TOOL_NAMES = new Set(["task", "call_omo_agent"])
const LONG_RUNNING_PREEXECUTION_TOOL_NAMES = new Set(["write", "apply_patch", "todowrite"])
const LONG_RUNNING_REGROUP_TOOL_NAMES = new Set(["write", "apply_patch", "todowrite"])
const LONG_RUNNING_TERMINAL_TOOL_STATUSES = new Set(["completed", "error", "aborted", "interrupted"])

export const MODEL_RECOVERY_INTERVAL_MS = 2 * 60 * 1000
export const MODEL_RECOVERY_PROBE_MIN_INTERVAL_MS = 60 * 1000
export const MODEL_RECOVERY_PROBE_TIMEOUT_MS = 30 * 1000
export const STALLED_SESSION_NUDGE_MS = 15 * 60 * 1000

export function isLongRunningAssistantProgress(args: {
  partType?: string
  toolStatus?: string
  toolName?: string
}): boolean {
  return (
    args.partType === "compaction"
    || args.partType === "step-start"
    || args.partType === "tool_use"
    || args.partType === "tool-call"
    || (
      args.partType === "tool" && (
        args.toolStatus === "running"
        || isPreExecutionRegroupToolProgress(args)
        || (
          args.toolStatus === "pending"
          && LONG_RUNNING_PENDING_TOOL_NAMES.has(args.toolName ?? "")
        )
        || (
          LONG_RUNNING_TERMINAL_TOOL_STATUSES.has(args.toolStatus ?? "")
          && LONG_RUNNING_REGROUP_TOOL_NAMES.has(args.toolName ?? "")
        )
      )
    )
  )
}

export function isPreExecutionRegroupToolProgress(args: {
  partType?: string
  toolStatus?: string
  toolName?: string
}): boolean {
  return (
    args.partType === "tool"
    && (args.toolStatus === undefined || args.toolStatus === "pending")
    && LONG_RUNNING_PREEXECUTION_TOOL_NAMES.has(args.toolName ?? "")
  )
}

export function resolveLongRunningProgressTimeoutMs(baseTimeoutMs: number): number {
  return baseTimeoutMs * LONG_RUNNING_PROGRESS_TIMEOUT_MULTIPLIER
}
