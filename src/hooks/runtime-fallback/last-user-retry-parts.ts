import { extractSessionMessages } from "./session-messages"
import { isInternalInitiatorMessage } from "./internal-continuation-loop-detector"
import type { FallbackState, RuntimeFallbackTextPart } from "./types"

export function getLastUserRetryParts(
  messagesResponse: unknown,
): RuntimeFallbackTextPart[] {
  const messages = extractSessionMessages(messagesResponse)
  const userMessages = messages?.filter((message) => message.info?.role === "user") ?? []
  const lastRealUserMessage = userMessages
    .filter((message) => {
      const parts = message.parts
        ?? (message.info?.parts as Array<{ type?: string; text?: string }> | undefined)
      return !isInternalInitiatorMessage(parts)
    })
    .pop()
  const lastUserParts =
    lastRealUserMessage?.parts
    ?? (lastRealUserMessage?.info?.parts as Array<{ type?: string; text?: string }> | undefined)

  return extractRetryTextParts(lastUserParts)
}

export function extractRetryTextParts(
  parts: Array<{ type?: string; text?: string }> | undefined,
): RuntimeFallbackTextPart[] {
  return (parts ?? [])
    .filter(
      (part): part is { type: "text"; text: string } =>
        part.type === "text"
        && typeof part.text === "string"
        && part.text.length > 0,
    )
    .map((part) => ({ type: "text" as const, text: part.text }))
}

export function resolveRetryBriefParts(
  messagesResponse: unknown,
  state?: Pick<FallbackState, "canonicalRetryParts">,
): RuntimeFallbackTextPart[] {
  const lastUserRetryParts = getLastUserRetryParts(messagesResponse)
  if (lastUserRetryParts.length > 0) {
    return lastUserRetryParts
  }

  const canonicalRetryParts = state?.canonicalRetryParts ?? []
  return canonicalRetryParts.map((part) => ({ type: "text" as const, text: part.text }))
}

export function hasCanonicalRetryParts(
  state?: Pick<FallbackState, "canonicalRetryParts"> | null,
): boolean {
  return Array.isArray(state?.canonicalRetryParts) && state.canonicalRetryParts.length > 0
}

export function resolveCanonicalRetryBriefParts(
  state: Pick<FallbackState, "canonicalRetryParts">,
): RuntimeFallbackTextPart[] {
  return (state.canonicalRetryParts ?? []).map((part) => ({ type: "text" as const, text: part.text }))
}
