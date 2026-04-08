import { z } from "zod"

export const RuntimeFallbackConfigSchema = z.object({
  /** Enable runtime fallback (default: false) */
  enabled: z.boolean().optional(),
  /** HTTP status codes that trigger fallback (default: [400, 429, 503, 529]) */
  retry_on_errors: z.array(z.number()).optional(),
  /** Maximum fallback attempts per session (default: 3) */
  max_fallback_attempts: z.number().min(1).max(20).optional(),
  /** Maximum number of full fallback cycles (top→bottom) before failing (default: 5). */
  max_full_chain_cycles: z.number().min(1).max(20).optional(),
  /** Cooldown in seconds before retrying a failed model (default: 60) */
  cooldown_seconds: z.number().min(0).optional(),
  /** Session-level timeout in seconds to advance fallback when provider hangs (default: 30). Set to 0 to disable auto-retry signal detection (only error-based fallback remains active). */
  timeout_seconds: z.number().min(0).optional(),
  /** How long transient same-model retries may continue before falling back (default: 14400 / 4h). */
  transient_retry_window_seconds: z.number().min(0).optional(),
  /** Delay before the first delayed transient retry after the immediate attempt (default: 30). */
  transient_retry_initial_delay_seconds: z.number().min(0).optional(),
  /** Maximum delay between transient retries; retries will never become less frequent than this (default: 300 / 5m). */
  transient_retry_max_delay_seconds: z.number().min(1).optional(),
  /** Show toast notification when switching to fallback model (default: true) */
  notify_on_fallback: z.boolean().optional(),
})

export type RuntimeFallbackConfig = z.infer<typeof RuntimeFallbackConfigSchema>
