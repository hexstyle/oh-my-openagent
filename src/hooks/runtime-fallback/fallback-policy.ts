import type { FallbackState } from "./types"
import {
  classifyErrorType,
  extractStatusCode,
  getErrorMessage,
  isGatewayBlockedForbiddenError,
  isTransientForbiddenError,
} from "./error-classifier"

export type RuntimeFallbackAction =
  | "retry_same_model"
  | "retry_same_model_delayed"
  | "retry_same_model_delayed_persistent"
  | "fallback_chain"
  | "limit_fallback"
export type RuntimeFallbackTier = "paid" | "spark" | "free"

const LIMIT_STATUS_CODES = new Set([402, 429])
const TRANSIENT_STATUS_CODES = new Set([408, 500, 502, 503, 504, 521, 522, 523, 524, 525, 526])
const NETWORK_ERROR_PATTERNS = [
  /certificate/i,
  /\btls\b/i,
  /\bssl\b/i,
  /network/i,
  /socket hang up/i,
  /econnreset/i,
  /econnrefused/i,
  /etimedout/i,
  /temporarily unavailable/i,
  /service unavailable/i,
  /internal[_\s-]*server[_\s-]*error/i,
  /bad gateway/i,
  /overloaded/i,
]

function isPlainLocalToolAbort(error: unknown): boolean {
  const message = getErrorMessage(error)
  if (!/tool execution aborted/i.test(message)) {
    return false
  }

  const statusCode = extractStatusCode(error, [...LIMIT_STATUS_CODES, ...TRANSIENT_STATUS_CODES, 403])
  if (statusCode !== undefined) {
    return false
  }

  const serialized = (() => {
    try {
      return JSON.stringify(error).toLowerCase()
    } catch {
      return message
    }
  })()

  return !(
    /request not allowed|forbidden|quota|usage limit|payment required|internal server error|service unavailable/.test(serialized)
  )
}

export function isSameModelRetryAction(action: RuntimeFallbackAction): boolean {
  return action === "retry_same_model"
    || action === "retry_same_model_delayed"
    || action === "retry_same_model_delayed_persistent"
}

export function isPersistentSameModelRetryAction(action: RuntimeFallbackAction): boolean {
  return action === "retry_same_model_delayed_persistent"
}

function dedupeModels(models: string[], currentModel?: string): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const model of models) {
    if (!model || model === currentModel || seen.has(model)) {
      continue
    }

    seen.add(model)
    result.push(model)
  }

  return result
}

export function getRuntimeFallbackAction(error: unknown, retryOnErrors: number[]): RuntimeFallbackAction {
  const errorType = classifyErrorType(error)
  const statusCode = extractStatusCode(error, retryOnErrors)
  const message = getErrorMessage(error)

  if (errorType === "quota_exceeded" || (statusCode !== undefined && LIMIT_STATUS_CODES.has(statusCode))) {
    return "limit_fallback"
  }

  if (
    errorType === "missing_api_key" ||
    errorType === "invalid_api_key" ||
    errorType === "model_not_found" ||
    errorType === "agent_not_found"
  ) {
    return "fallback_chain"
  }

  if (isGatewayBlockedForbiddenError(error)) {
    return "fallback_chain"
  }

  if (isTransientForbiddenError(error)) {
    return "retry_same_model_delayed_persistent"
  }

  if (isPlainLocalToolAbort(error)) {
    return "retry_same_model_delayed_persistent"
  }

  if (statusCode !== undefined && TRANSIENT_STATUS_CODES.has(statusCode)) {
    return "retry_same_model"
  }

  if (NETWORK_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
    return "retry_same_model"
  }

  if (errorType === "unknown_error") {
    return "retry_same_model_delayed"
  }

  return "fallback_chain"
}

export function getRuntimeFallbackTier(model: string): RuntimeFallbackTier {
  const normalized = model.toLowerCase()

  if (normalized.includes("/gpt-5.3-codex-spark")) {
    return "spark"
  }

  if (/(^|\/)big-pickle(?:\(|$)/i.test(normalized)) {
    return "free"
  }

  if (/(^|\/)[^/]+-free(?:\(|$)/i.test(normalized)) {
    return "free"
  }

  return "paid"
}

export function selectFallbackModelsForAction(args: {
  currentModel: string
  fallbackModels: string[]
  action: RuntimeFallbackAction
}): string[] {
  const candidates = dedupeModels(args.fallbackModels, args.currentModel)
  if (args.action !== "limit_fallback") {
    return candidates
  }

  const sparkCandidates = candidates.filter((model) => getRuntimeFallbackTier(model) === "spark")
  const freeCandidates = candidates.filter((model) => getRuntimeFallbackTier(model) === "free")
  const currentTier = getRuntimeFallbackTier(args.currentModel)

  if (currentTier === "free") {
    return freeCandidates.length > 0 ? freeCandidates : candidates
  }

  if (currentTier === "spark") {
    return freeCandidates.length > 0 ? freeCandidates : candidates
  }

  const limitCandidates = [...sparkCandidates, ...freeCandidates]
  return limitCandidates.length > 0 ? dedupeModels(limitCandidates) : candidates
}

export function getRecoveryProbeCandidates(state: FallbackState): string[] {
  const currentTier = getRuntimeFallbackTier(state.currentModel)
  if (currentTier === "paid") {
    return []
  }

  const recoveryChain = dedupeModels([state.originalModel, ...state.fallbackModels])
  const currentIndex = recoveryChain.indexOf(state.currentModel)
  if (currentIndex <= 0) {
    return []
  }

  return recoveryChain
    .slice(0, currentIndex)
    .filter((candidate) => getRuntimeFallbackTier(candidate) !== "free")
}
