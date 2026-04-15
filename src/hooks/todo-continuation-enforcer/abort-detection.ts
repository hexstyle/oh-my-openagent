import type { MessageInfo } from "./types"
import { isInternalInitiatorMessage } from "../runtime-fallback/internal-continuation-loop-detector"

type SessionMessageLike = {
  info?: MessageInfo
  parts?: Array<{ type?: string; text?: string }>
}

function isAbortErrorName(errorName: string | undefined): boolean {
  return errorName === "MessageAbortedError" || errorName === "AbortError"
}

export function isLastAssistantMessageAborted(
  messages: SessionMessageLike[]
): boolean {
  if (!messages || messages.length === 0) return false

  const assistantMessages = messages.filter((message) => message.info?.role === "assistant")
  if (assistantMessages.length === 0) return false

  const lastAssistant = assistantMessages[assistantMessages.length - 1]
  const errorName = lastAssistant.info?.error?.name

  return isAbortErrorName(errorName)
}

export function isLastAssistantAbortAfterCompaction(
  messages: SessionMessageLike[],
): boolean {
  if (!messages || messages.length === 0) return false

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.info?.role !== "assistant") {
      continue
    }

    const errorName = message.info?.error?.name
    if (!isAbortErrorName(errorName)) {
      return false
    }

    if (message.info?.agent === "compaction") {
      return true
    }

    for (let previousIndex = index - 1; previousIndex >= 0; previousIndex -= 1) {
      const previousMessage = messages[previousIndex]
      const isCompactionMessage =
        previousMessage?.info?.agent === "compaction"
        || (previousMessage?.parts ?? []).some((part) => part.type === "compaction")

      if (isCompactionMessage) {
        return true
      }

      if (previousMessage?.info?.role === "user" && isInternalInitiatorMessage(previousMessage.parts)) {
        continue
      }

      if (previousMessage?.info?.role === "assistant" || previousMessage?.info?.role === "user") {
        return false
      }
    }

    return false
  }

  return false
}
