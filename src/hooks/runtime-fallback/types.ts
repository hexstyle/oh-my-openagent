import type { RuntimeFallbackConfig, OhMyOpenCodeConfig } from "../../config"
import type { BackgroundTask } from "../../features/background-agent/types"
import type { LoopDetector } from "./internal-continuation-loop-detector"

export interface RuntimeFallbackBackgroundManager {
  getTasksByParentSession: (sessionID: string) => BackgroundTask[]
}

export interface RuntimeFallbackInterval {
  unref: () => void
}

export type RuntimeFallbackTimeout = object | number

export interface ResolvedRuntimeFallbackConfig {
  enabled: boolean
  retry_on_errors: number[]
  max_fallback_attempts: number
  max_full_chain_cycles: number
  cooldown_seconds: number
  timeout_seconds: number
  transient_retry_window_seconds: number
  transient_retry_initial_delay_seconds: number
  transient_retry_max_delay_seconds: number
  notify_on_fallback: boolean
  manual_provider_clearance_enabled?: boolean
  manual_provider_clearance_pause_window_seconds?: number
  manual_provider_clearance_notify_on_pause?: boolean
}

export interface RuntimeFallbackPluginInput {
  client: {
    session: {
      create?: (input: {
        body: Record<string, unknown>
        query: { directory: string }
      }) => Promise<{ data?: { id?: string }; error?: unknown }>
      children?: (input: {
        path: { id: string }
        query: { directory: string }
      }) => Promise<unknown>
      get?: (input: { path: { id: string } }) => Promise<{ data?: { directory?: string } }>
      abort: (input: { path: { id: string } }) => Promise<unknown>
      messages: (input: { path: { id: string }; query: { directory: string } }) => Promise<unknown>
      promptAsync: (input: {
        path: { id: string }
        body: {
          agent?: string
          model: { providerID: string; modelID: string }
          parts: Array<{ type: "text"; text: string }>
        }
        query: { directory: string }
      }) => Promise<unknown>
      status?: (input: {
        query: { directory: string }
      }) => Promise<unknown>
    }
    tui: {
      showToast: (input: {
        body: {
          title: string
          message: string
          variant: "success" | "error" | "info" | "warning"
          duration: number
        }
      }) => Promise<unknown>
    }
  }
  directory: string
}

export interface FallbackState {
  originalModel: string
  currentModel: string
  resolvedAgent?: string
  fallbackIndex: number
  fallbackModels: string[]
  failedModels: Map<string, number>
  attemptCount: number
  /**
   * Counts recovery-driven auto-resume loops within the current unresolved turn.
   * This is reset after a visible successful response.
   */
  fullChainCyclesCompleted?: number
  transientRetryCount: number
  transientRetryStartedAt?: number
  transientRetryDelayMs?: number
  transientRetryMaxAttempts?: number
  pendingTransientRetry?: boolean
  persistentTransientRetry?: boolean
  pendingFallbackModel?: string
  /** Timestamp of the last quota / rate-limit signal for this session. Used to
   *  route `MessageAbortedError` events and watchdog timeouts through the
   *  `limit_fallback` path (all remaining paid models before free) instead of
   *  `fallback_chain`. */
  lastLimitErrorAt?: number
  /** Timestamp of the last real assistant/tool progress that should allow
   *  the active session.status path to extend the watchdog once more. */
  lastMeaningfulProgressAt?: number
  /** Timestamp of the last assistant/session error. Used to distinguish
   *  a clean terminal idle from an idle event that merely followed an abort. */
  lastErrorAt?: number
  /** Timestamp of the last time an active session.status pulse extended the
   *  watchdog without any newer assistant/tool progress. */
  lastActiveStatusRefreshAt?: number
  /** Timestamp of the last terminal idle/stop signal. Used to avoid nudging
   *  sessions that already settled cleanly and no longer need recovery. */
  lastTerminalIdleAt?: number
  /** Timestamp set by `session.stop`. Prevents the watchdog timer from
   *  dispatching a new retry if the user explicitly stopped the session. */
  stoppedAt?: number
  /** Temporary opt-in same-model hold window for tracked Claude/Codex 403s while
   *  the user clears provider-side access checks manually. */
  manualProviderClearanceUntil?: number
  manualProviderClearanceProviderFamily?: "claude" | "codex"
  manualProviderClearanceUrl?: string
  manualProviderClearanceNotifiedAt?: number
}

export type FallbackResult =
  | {
      success: true
      newModel: string
      previousModel: string
      error?: undefined
      maxAttemptsReached?: false
    }
  | {
      success: false
      newModel?: undefined
      previousModel?: undefined
      error: string
      maxAttemptsReached?: boolean
    }

export interface RuntimeFallbackOptions {
  config?: RuntimeFallbackConfig
  pluginConfig?: OhMyOpenCodeConfig
  session_timeout_ms?: number
  backgroundManager?: RuntimeFallbackBackgroundManager
  probeModelAvailability?: (args: {
    sessionID: string
    model: string
    directory: string
  }) => Promise<boolean>
}

export interface RuntimeFallbackHook {
  event: (input: { event: { type: string; properties?: unknown } }) => Promise<void>
  "chat.message"?: (input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string } }, output: { message: { model?: { providerID: string; modelID: string } }; parts?: Array<{ type: string; text?: string }> }) => Promise<void>
  dispose?: () => void
  /** Exposed for structural testing only — do not use in production code. */
  _deps?: HookDeps
}

export interface HookDeps {
  ctx: RuntimeFallbackPluginInput
  config: ResolvedRuntimeFallbackConfig
  options: RuntimeFallbackOptions | undefined
  pluginConfig: OhMyOpenCodeConfig | undefined
  loopDetector: LoopDetector
  sessionStates: Map<string, FallbackState>
  sessionLastAccess: Map<string, number>
  sessionLastUserMessageIDs: Map<string, string>
  sessionRecentCompletionUntil: Map<string, number>
  sessionRecentActiveStatusUntil?: Map<string, number>
  sessionSilentAssistantUpdateCounts?: Map<string, number>
  sessionRetryInFlight: Set<string>
  sessionAwaitingFallbackResult: Set<string>
  sessionFallbackTimeouts: Map<string, RuntimeFallbackTimeout>
  sessionTransientRetryTimeouts: Map<string, RuntimeFallbackTimeout>
  sessionStatusRetryKeys: Map<string, string>
}
