import type { HookDeps } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import {
  activateManualProviderClearance,
  isManualProviderClearanceActive,
} from "./fallback-state"
import {
  classifyTracked403ProviderFamily,
  getTrackedProvider403ClearanceUrl,
} from "./provider-403-diagnostics"
import {
  extractStatusCode,
  getErrorMessage,
  isGatewayBlockedForbiddenError,
  isTransientForbiddenError,
} from "./error-classifier"
import { HOOK_NAME } from "./constants"
import { log } from "../../shared/logger"

const MANUAL_PROVIDER_CLEARANCE_TOAST_DURATION_MS = 15_000

function isTrackedProvider403(args: {
  model: string | undefined
  error: unknown
}): { providerFamily: "claude" | "codex"; url: string } | undefined {
  const providerFamily = classifyTracked403ProviderFamily(args.model)
  if (!providerFamily) {
    return undefined
  }

  const statusCode = extractStatusCode(args.error, [403])
  const message = getErrorMessage(args.error)
  const isTrackedForbidden =
    isGatewayBlockedForbiddenError(args.error) || isTransientForbiddenError(args.error)
  if (!isTrackedForbidden && statusCode !== 403 && !/\b403\b/.test(message)) {
    return undefined
  }

  return {
    providerFamily,
    url: getTrackedProvider403ClearanceUrl({
      providerFamily,
      error: args.error,
    }),
  }
}

function formatManualProviderClearanceMessage(args: {
  providerFamily: "claude" | "codex"
  model: string
  url: string
  pauseWindowSeconds: number
}): string {
  const providerLabel = args.providerFamily === "claude" ? "Claude" : "Codex/OpenAI"
  const modelLabel = args.model.split("/").pop() ?? args.model
  const pauseLabel = args.pauseWindowSeconds >= 60
    ? `${Math.max(1, Math.round(args.pauseWindowSeconds / 60))}m`
    : `${Math.max(1, Math.round(args.pauseWindowSeconds))}s`

  return [
    `${providerLabel} access check detected for ${modelLabel}.`,
    `Open ${args.url} and complete any provider/browser challenge manually.`,
    `This session will stay on the same paid model for up to ${pauseLabel} before normal fallback resumes.`,
  ].join(" ")
}

export async function maybePauseForManualProviderClearance(
  deps: HookDeps,
  helpers: AutoRetryHelpers,
  args: {
    sessionID: string
    resolvedAgent?: string
    model?: string
    error: unknown
    source: string
  },
): Promise<boolean> {
  if (!deps.config.manual_provider_clearance_enabled) {
    return false
  }

  const state = deps.sessionStates.get(args.sessionID)
  if (!state) {
    return false
  }

  const tracked403 = isTrackedProvider403({
    model: args.model ?? state.currentModel,
    error: args.error,
  })
  if (!tracked403) {
    return false
  }

  const pauseWindowSeconds = Math.max(
    0,
    deps.config.manual_provider_clearance_pause_window_seconds ?? 0,
  )
  if (pauseWindowSeconds <= 0) {
    return false
  }

  const now = Date.now()
  if (
    typeof state.manualProviderClearanceUntil === "number"
    && state.manualProviderClearanceUntil <= now
  ) {
    log(`[${HOOK_NAME}] Manual provider-clearance pause window expired; resuming normal fallback policy`, {
      sessionID: args.sessionID,
      source: args.source,
      model: args.model ?? state.currentModel,
      providerFamily: state.manualProviderClearanceProviderFamily,
    })
    return false
  }

  if (!isManualProviderClearanceActive(state, now)) {
    activateManualProviderClearance(state, {
      until: now + pauseWindowSeconds * 1000,
      providerFamily: tracked403.providerFamily,
      url: tracked403.url,
    })
  }

  state.transientRetryMaxAttempts = undefined

  const shouldNotify =
    deps.config.manual_provider_clearance_notify_on_pause !== false
    && typeof state.manualProviderClearanceNotifiedAt !== "number"
  if (shouldNotify) {
    await deps.ctx.client.tui
      .showToast({
        body: {
          title: "Manual Provider Clearance Required",
          message: formatManualProviderClearanceMessage({
            providerFamily: tracked403.providerFamily,
            model: args.model ?? state.currentModel,
            url: tracked403.url,
            pauseWindowSeconds,
          }),
          variant: "warning",
          duration: MANUAL_PROVIDER_CLEARANCE_TOAST_DURATION_MS,
        },
      })
      .catch(() => {})
    state.manualProviderClearanceNotifiedAt = now
  }

  log(`[${HOOK_NAME}] Holding tracked provider 403 on the same paid model for manual clearance`, {
    sessionID: args.sessionID,
    source: args.source,
    model: args.model ?? state.currentModel,
    providerFamily: tracked403.providerFamily,
    clearanceUrl: tracked403.url,
    manualProviderClearanceUntil: state.manualProviderClearanceUntil,
  })

  return await helpers.retryCurrentModel(
    args.sessionID,
    args.resolvedAgent,
    `${args.source}.manual-provider-clearance`,
    { immediate: false },
  )
}
