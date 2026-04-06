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
    pendingFallbackModel: undefined,
  }
}

export function updateFallbackModels(state: FallbackState, fallbackModels: string[]): void {
  state.fallbackModels = dedupeModels(fallbackModels)
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
}

export function recoverPreferredModel(state: FallbackState, cooldownSeconds: number, now = Date.now()): string | undefined {
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

    state.currentModel = candidate
    state.pendingFallbackModel = undefined
    state.attemptCount = 0
    state.fallbackIndex = candidate === state.originalModel
      ? -1
      : state.fallbackModels.indexOf(candidate)

    log(`[${HOOK_NAME}] Restored preferred model after cooldown`, {
      from: recoveryChain[currentIndex],
      to: candidate,
    })

    return candidate
  }

  return undefined
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
cooldownSeconds: number
): string | undefined {
for (let i = state.fallbackIndex + 1; i < fallbackModels.length; i++) {
    const candidate = fallbackModels[i]
    // Skip current model — never fallback to the same model
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
  state.currentModel = nextModel
  state.pendingFallbackModel = nextModel

  return { success: true, newModel: nextModel }
}
