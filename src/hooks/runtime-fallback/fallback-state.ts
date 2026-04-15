import type { FallbackState, FallbackResult } from "./types"
import { HOOK_NAME } from "./constants"
import { log } from "../../shared/logger"
import type { RuntimeFallbackConfig } from "../../config"

function dedupeModels(models: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const model of models) {
    if (!model || seen.has(model)) {
      continue
    }

    seen.add(model)
    result.push(model)
  }

  return result
}

function getRecoveryChain(state: FallbackState): string[] {
  return dedupeModels([state.originalModel, ...state.fallbackModels])
}

export function createFallbackState(originalModel: string, fallbackModels: string[] = []): FallbackState {
  return {
    originalModel,
    currentModel: originalModel,
    fallbackIndex: -1,
    fallbackModels: dedupeModels(fallbackModels),
    failedModels: new Map<string, number>(),
    attemptCount: 0,
    fullChainCyclesCompleted: 0,
    transientRetryCount: 0,
    transientRetryStartedAt: undefined,
    transientRetryDelayMs: undefined,
    pendingTransientRetry: false,
    pendingFallbackModel: undefined,
    lastLimitErrorAt: undefined,
    lastMeaningfulProgressAt: undefined,
    lastActiveStatusRefreshAt: undefined,
    stoppedAt: undefined,
  }
}

const LIMIT_ERROR_SIGNAL_WINDOW_MS = 5 * 60 * 1000
const STOP_INHIBIT_WINDOW_MS = 15_000

export function markLimitError(state: FallbackState, now = Date.now()): void {
  state.lastLimitErrorAt = now
}

export function isRecentLimitError(
  state: FallbackState,
  windowMs = LIMIT_ERROR_SIGNAL_WINDOW_MS,
  now = Date.now(),
): boolean {
  if (state.lastLimitErrorAt === undefined) return false
  return now - state.lastLimitErrorAt < windowMs
}

export function markSessionStopped(state: FallbackState, now = Date.now()): void {
  state.stoppedAt = now
}

export function wasRecentlyStopped(
  state: FallbackState,
  windowMs = STOP_INHIBIT_WINDOW_MS,
  now = Date.now(),
): boolean {
  if (state.stoppedAt === undefined) return false
  return now - state.stoppedAt < windowMs
}

export function updateFallbackModels(state: FallbackState, fallbackModels: string[]): void {
  state.fallbackModels = dedupeModels(fallbackModels)
  state.fallbackIndex = state.fallbackModels.indexOf(state.currentModel)
}

export function pruneExpiredFailedModels(state: FallbackState, cooldownSeconds: number, now = Date.now()): void {
  const cooldownMs = cooldownSeconds * 1000

  for (const [model, failedAt] of state.failedModels.entries()) {
    if (now - failedAt >= cooldownMs) {
      state.failedModels.delete(model)
    }
  }
}

export function markFallbackResponseSuccess(state: FallbackState): void {
  state.pendingFallbackModel = undefined
  state.attemptCount = 0
  state.fullChainCyclesCompleted = 0
  state.lastActiveStatusRefreshAt = undefined
  resetTransientRetryState(state)
}

export function markMeaningfulProgress(state: FallbackState, now = Date.now()): void {
  state.lastMeaningfulProgressAt = now
  state.lastActiveStatusRefreshAt = undefined
}

export function canRefreshFromActiveStatus(state: FallbackState): boolean {
  if (state.lastActiveStatusRefreshAt === undefined) {
    return true
  }

  return (state.lastMeaningfulProgressAt ?? 0) > state.lastActiveStatusRefreshAt
}

export function markActiveStatusRefresh(state: FallbackState, now = Date.now()): void {
  state.lastActiveStatusRefreshAt = now
}

export function resetTransientRetryState(state: FallbackState): void {
  state.transientRetryCount = 0
  state.transientRetryStartedAt = undefined
  state.transientRetryDelayMs = undefined
  state.pendingTransientRetry = false
}

export function canKeepRetryingTransiently(
  state: FallbackState,
  config: Required<RuntimeFallbackConfig>,
  now = Date.now(),
): boolean {
  if (config.transient_retry_window_seconds <= 0) {
    return false
  }

  if (state.transientRetryStartedAt === undefined) {
    return true
  }

  return now - state.transientRetryStartedAt < config.transient_retry_window_seconds * 1000
}

export function beginTransientRetryWindow(state: FallbackState, now = Date.now()): void {
  if (state.transientRetryStartedAt === undefined) {
    state.transientRetryStartedAt = now
  }
}

export function getNextTransientRetryDelayMs(
  state: FallbackState,
  config: Required<RuntimeFallbackConfig>,
): number {
  const initialDelayMs = Math.max(0, Math.round(config.transient_retry_initial_delay_seconds * 1000))
  const maxDelayMs = Math.max(initialDelayMs, Math.round(config.transient_retry_max_delay_seconds * 1000))

  if (state.transientRetryDelayMs === undefined || state.transientRetryDelayMs <= 0) {
    return initialDelayMs
  }

  return Math.min(state.transientRetryDelayMs * 2, maxDelayMs)
}

export function markTransientRetryDispatched(
  state: FallbackState,
  options?: {
    now?: number
    nextDelayMs?: number
  },
): void {
  beginTransientRetryWindow(state, options?.now)
  state.transientRetryCount += 1
  state.pendingTransientRetry = true

  if (typeof options?.nextDelayMs === "number") {
    state.transientRetryDelayMs = options.nextDelayMs
  }
}

export function getPreferredRecoveryCandidate(
  state: FallbackState,
  cooldownSeconds: number,
  now = Date.now(),
): string | undefined {
  pruneExpiredFailedModels(state, cooldownSeconds, now)

  const recoveryChain = getRecoveryChain(state)
  const currentIndex = recoveryChain.indexOf(state.currentModel)
  if (currentIndex <= 0) {
    return undefined
  }

  for (let index = 0; index < currentIndex; index++) {
    const candidate = recoveryChain[index]
    if (!candidate) {
      continue
    }

    if (isModelInCooldown(candidate, state, cooldownSeconds)) {
      continue
    }

    return candidate
  }

  return undefined
}

export function recoverPreferredModel(
  state: FallbackState,
  cooldownSeconds: number,
  now = Date.now(),
): string | undefined {
  const recoveryChain = getRecoveryChain(state)
  const currentIndex = recoveryChain.indexOf(state.currentModel)
  const candidate = getPreferredRecoveryCandidate(state, cooldownSeconds, now)
  if (!candidate) {
    return undefined
  }

  state.currentModel = candidate
  state.pendingFallbackModel = undefined
  state.attemptCount = 0
  resetTransientRetryState(state)
  state.fallbackIndex = candidate === state.originalModel
    ? -1
    : state.fallbackModels.indexOf(candidate)

  log(`[${HOOK_NAME}] Restored preferred model after cooldown`, {
    from: recoveryChain[currentIndex],
    to: candidate,
  })

  return candidate
}

export function canAutoResumeRecoveredModel(
  state: FallbackState,
  maxFullChainCycles: number,
): boolean {
  return (state.fullChainCyclesCompleted ?? 0) < maxFullChainCycles
}

export function markRecoveredModelAutoResume(state: FallbackState): void {
  state.fullChainCyclesCompleted = (state.fullChainCyclesCompleted ?? 0) + 1
}

export function isModelInCooldown(model: string, state: FallbackState, cooldownSeconds: number): boolean {
  const failedAt = state.failedModels.get(model)
  if (failedAt === undefined) return false
  const cooldownMs = cooldownSeconds * 1000
  return Date.now() - failedAt < cooldownMs
}

export function findNextAvailableFallback(
  state: FallbackState,
  fallbackModels: string[],
  cooldownSeconds: number,
): string | undefined {
  for (let i = state.fallbackIndex + 1; i < fallbackModels.length; i++) {
    const candidate = fallbackModels[i]
    if (candidate === state.currentModel) {
      continue
    }
    if (!isModelInCooldown(candidate, state, cooldownSeconds)) {
      return candidate
    }
    log(`[${HOOK_NAME}] Skipping fallback model in cooldown`, { model: candidate, index: i })
  }
  return undefined
}

export function prepareFallback(
  sessionID: string,
  state: FallbackState,
  fallbackModels: string[],
  config: Required<RuntimeFallbackConfig>
): FallbackResult {
  updateFallbackModels(state, fallbackModels)
  pruneExpiredFailedModels(state, config.cooldown_seconds)

  if (state.attemptCount >= config.max_fallback_attempts) {
    log(`[${HOOK_NAME}] Max fallback attempts reached`, { sessionID, attempts: state.attemptCount })
    return { success: false, error: "Max fallback attempts reached", maxAttemptsReached: true }
  }

  const nextModel = findNextAvailableFallback(state, fallbackModels, config.cooldown_seconds)

  if (!nextModel) {
    log(`[${HOOK_NAME}] No available fallback models`, { sessionID })
    return { success: false, error: "No available fallback models (all in cooldown or exhausted)" }
  }

  log(`[${HOOK_NAME}] Preparing fallback`, {
    sessionID,
    from: state.currentModel,
    to: nextModel,
    attempt: state.attemptCount + 1,
  })

  const failedModel = state.currentModel
  const now = Date.now()

  state.fallbackIndex = fallbackModels.indexOf(nextModel)
  state.failedModels.set(failedModel, now)
  state.attemptCount++
  resetTransientRetryState(state)
  state.currentModel = nextModel
  state.pendingFallbackModel = nextModel

  return { success: true, newModel: nextModel }
}
