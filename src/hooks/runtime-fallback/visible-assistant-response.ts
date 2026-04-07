import type { HookDeps } from "./types"
import type { SessionMessage, SessionMessagePart } from "./session-messages"
import { extractSessionMessages } from "./session-messages"
import { extractAutoRetrySignal } from "./error-classifier"

const NON_VISIBLE_ASSISTANT_TEXT_PREFIXES = [
  /^thinking\b[:\s-]*/i,
  /^reasoning\b[:\s-]*/i,
]

function getLastUserMessageIndex(messages: SessionMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.info?.role === "user") {
      return index
    }
  }

  return -1
}

function getAssistantText(parts: SessionMessagePart[] | undefined): string {
  return (parts ?? [])
    .flatMap((part) => {
      if (part.type !== "text") {
        return []
      }

      const text = typeof part.text === "string" ? part.text.trim() : ""
      return text.length > 0 ? [text] : []
    })
    .join("\n")
}

function hasVisibleNonTextAssistantPart(parts: SessionMessagePart[] | undefined): boolean {
  for (const part of parts ?? []) {
    const type = part?.type
    if (!type) {
      continue
    }

    if (
      type === "tool" ||
      type === "tool_use" ||
      type === "tool_result" ||
      type === "tool-call"
    ) {
      return true
    }
  }

  return false
}

function isNonVisibleAssistantText(text: string): boolean {
  return NON_VISIBLE_ASSISTANT_TEXT_PREFIXES.some((pattern) => pattern.test(text))
}

export function hasVisibleAssistantEventContent(
  extractAutoRetrySignalFn: typeof extractAutoRetrySignal,
  args: {
    message?: unknown
    parts?: SessionMessagePart[]
  },
): boolean {
  const messageText = typeof args.message === "string" ? args.message.trim() : ""
  if (
    messageText.length > 0 &&
    !isNonVisibleAssistantText(messageText) &&
    !extractAutoRetrySignalFn({ message: messageText })
  ) {
    return true
  }

  const assistantText = getAssistantText(args.parts)
  if (
    assistantText.length > 0 &&
    !isNonVisibleAssistantText(assistantText) &&
    !extractAutoRetrySignalFn({ message: assistantText })
  ) {
    return true
  }

  return hasVisibleNonTextAssistantPart(args.parts)
}

export function hasVisibleAssistantResponse(extractAutoRetrySignalFn: typeof extractAutoRetrySignal) {
  return async (
    ctx: HookDeps["ctx"],
    sessionID: string,
    _info: Record<string, unknown> | undefined,
  ): Promise<boolean> => {
    try {
      const messagesResponse = await ctx.client.session.messages({
        path: { id: sessionID },
        query: { directory: ctx.directory },
      })
      const messages = extractSessionMessages(messagesResponse)
      if (!messages || messages.length === 0) return false

      const lastUserMessageIndex = getLastUserMessageIndex(messages)
      if (lastUserMessageIndex === -1) return false

      for (let index = lastUserMessageIndex + 1; index < messages.length; index++) {
        const message = messages[index]
        if (message?.info?.role !== "assistant") {
          continue
        }

        if (message.info?.error) {
          continue
        }

        const infoParts = message.info?.parts
        const infoMessageParts = Array.isArray(infoParts)
          ? infoParts.filter((part): part is SessionMessagePart => typeof part === "object" && part !== null)
          : undefined
        const parts = message.parts && message.parts.length > 0
          ? message.parts
          : infoMessageParts
        if (hasVisibleAssistantEventContent(extractAutoRetrySignalFn, {
          message: message.info?.message,
          parts,
        })) {
          return true
        }
      }

      return false
    } catch {
      return false
    }
  }
}
