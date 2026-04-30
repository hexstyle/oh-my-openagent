import { log } from "../../shared/logger"
import { HOOK_NAME } from "./constants"
import {
  classifyErrorType,
  extractErrorName,
  extractStatusCode,
  getErrorMessage,
  isGatewayBlockedForbiddenError,
} from "./error-classifier"

type Tracked403ProviderFamily = "claude" | "codex"

function hasExplicit403StatusCode(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const obj = error as Record<string, unknown>
  const candidates = [
    obj.statusCode,
    obj.status,
    (obj.data as Record<string, unknown> | undefined)?.statusCode,
    (obj.error as Record<string, unknown> | undefined)?.statusCode,
    (obj.cause as Record<string, unknown> | undefined)?.statusCode,
  ]
  return candidates.some((code) => code === 403)
}

function isRequestNotAllowedForbiddenError(error: unknown): boolean {
  const message = getErrorMessage(error)
  if (/\brequest not allowed\b/i.test(message)) {
    return true
  }

  try {
    return /\brequest not allowed\b/i.test(JSON.stringify(error))
  } catch {
    return false
  }
}

export function getTrackedProvider403Details(args: {
  model: string | undefined
  error: unknown
}): { providerFamily: Tracked403ProviderFamily; url: string } | undefined {
  const providerFamily = classifyTracked403ProviderFamily(args.model)
  if (!providerFamily) {
    return undefined
  }

  // Any 403 from a tracked provider (Claude/Codex) is an access block that
  // benefits from a session restart.  Previously only "request not allowed" and
  // gateway-blocked patterns matched, so a plain "forbidden" 403 would slip
  // through and cascade to free models instead of triggering external restart.
  // Use hasExplicit403StatusCode to avoid matching "403" in unrelated message
  // text (e.g. "remote compact task: unexpected status 403 Forbidden").
  const isAccessBlocked403 =
    isGatewayBlockedForbiddenError(args.error)
    || isRequestNotAllowedForbiddenError(args.error)
    || hasExplicit403StatusCode(args.error)

  if (!isAccessBlocked403) {
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

export function shouldPreferFreshTrackedProvider403Handoff(args: {
  model: string | undefined
  error: unknown
  isScopedFallbackChild?: boolean
}): boolean {
  return getTrackedProvider403Details({
    model: args.model,
    error: args.error,
  }) !== undefined
}

export function classifyTracked403ProviderFamily(model: string | undefined): Tracked403ProviderFamily | undefined {
  const normalized = model?.trim().toLowerCase()
  if (!normalized) {
    return undefined
  }

  if (normalized.startsWith("anthropic/") || normalized.includes("claude")) {
    return "claude"
  }

  if (
    normalized.startsWith("openai/")
    || normalized.startsWith("github-copilot/")
    || normalized.startsWith("opencode/gpt-")
    || normalized.includes("codex")
  ) {
    return "codex"
  }

  return undefined
}

function extractTrackedProvider403Url(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined
  }

  const candidates = [
    error as Record<string, unknown>,
    (error as Record<string, unknown>).data as Record<string, unknown> | undefined,
    (error as Record<string, unknown>).error as Record<string, unknown> | undefined,
    (error as Record<string, unknown>).cause as Record<string, unknown> | undefined,
  ]

  for (const candidate of candidates) {
    const url = candidate?.url
    if (typeof url === "string" && /^https?:\/\//i.test(url.trim())) {
      return url.trim()
    }
  }

  return undefined
}

export function getTrackedProvider403ClearanceUrl(args: {
  providerFamily: Tracked403ProviderFamily
  error: unknown
}): string {
  const rawUrl = extractTrackedProvider403Url(args.error)
  if (rawUrl && !/\/v1\//i.test(rawUrl)) {
    return rawUrl
  }

  return args.providerFamily === "claude"
    ? "https://console.anthropic.com/"
    : "https://platform.openai.com/"
}

function extractResponseBodySnippet(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined
  }

  const candidates = [
    error as Record<string, unknown>,
    (error as Record<string, unknown>).data as Record<string, unknown> | undefined,
    (error as Record<string, unknown>).error as Record<string, unknown> | undefined,
    (error as Record<string, unknown>).cause as Record<string, unknown> | undefined,
  ]

  for (const candidate of candidates) {
    const responseBody = candidate?.responseBody
    if (typeof responseBody !== "string") {
      continue
    }

    const trimmed = responseBody.trim()
    if (!trimmed) {
      continue
    }

    return trimmed.slice(0, 300)
  }

  return undefined
}

export function logTrackedProvider403(args: {
  source: string
  sessionID: string
  model?: string
  resolvedAgent?: string
  error: unknown
  action?: string
}): void {
  const providerFamily = classifyTracked403ProviderFamily(args.model)
  if (!providerFamily) {
    return
  }

  const statusCode = extractStatusCode(args.error, [403])
  const errorMessage = getErrorMessage(args.error)
  if (statusCode !== 403 && !/\b403\b/.test(errorMessage)) {
    return
  }

  log(`[${HOOK_NAME}] Observed tracked provider 403`, {
    source: args.source,
    sessionID: args.sessionID,
    providerFamily,
    model: args.model,
    resolvedAgent: args.resolvedAgent,
    action: args.action,
    statusCode,
    errorName: extractErrorName(args.error),
    errorType: classifyErrorType(args.error),
    errorMessage,
    responseBodySnippet: extractResponseBodySnippet(args.error),
  })
}
