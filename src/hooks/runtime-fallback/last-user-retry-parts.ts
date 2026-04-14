import { extractSessionMessages } from "./session-messages"
import { isInternalInitiatorMessage } from "./internal-continuation-loop-detector"

export function getLastUserRetryParts(
  messagesResponse: unknown,
): Array<{ type: "text"; text: string }> {
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

  return (lastUserParts ?? [])
    .filter(
      (part): part is { type: "text"; text: string } =>
        part.type === "text"
        && typeof part.text === "string"
        && part.text.length > 0,
    )
    .map((part) => ({ type: "text" as const, text: part.text }))
}
