import type { PluginInput } from "@opencode-ai/plugin"
import { log } from "../../shared"
import { consumeNewMessages } from "../../shared/session-cursor"

interface SDKMessage {
  info?: { role?: string; time?: { created?: number } }
  parts?: Array<{ type: string; text?: string }>
}

export async function processMessages(
  sessionID: string,
  ctx: PluginInput
): Promise<string> {
  const messagesResult = await ctx.client.session.messages({
    path: { id: sessionID },
  })

  if (messagesResult.error) {
    log(`[call_omo_agent] Messages error:`, messagesResult.error)
    throw new Error(`Failed to get messages: ${messagesResult.error}`)
  }

  const messages = messagesResult.data
  log(`[call_omo_agent] Got ${messages.length} messages`)

  // Only assistant messages contain the subagent's synthesized response.
  // Tool results (grep, bash, file reads) are intermediate data that pollute
  // the parent context with service tags, escape chars, and raw output.
  const assistantMessages = messages.filter(
    (m: SDKMessage) => m.info?.role === "assistant"
  )

  if (assistantMessages.length === 0) {
    log(`[call_omo_agent] No assistant messages found`)
    throw new Error("No assistant response found")
  }

  log(`[call_omo_agent] Found ${assistantMessages.length} assistant messages`)

  // Sort by time ascending (oldest first) to process messages in order
  const sortedMessages = [...assistantMessages].sort((a: SDKMessage, b: SDKMessage) => {
    const timeA = a.info?.time?.created ?? 0
    const timeB = b.info?.time?.created ?? 0
    return timeA - timeB
  })

  const newMessages = consumeNewMessages(sessionID, sortedMessages)

  if (newMessages.length === 0) {
    return "No new output since last check."
  }

  // Extract only text/reasoning from assistant messages — the subagent's
  // final response already contains all relevant information.
  const extractedContent: string[] = []

  for (const message of newMessages) {
    for (const part of message.parts ?? []) {
      if ((part.type === "text" || part.type === "reasoning") && part.text) {
        extractedContent.push(part.text)
      }
    }
  }

  const responseText = extractedContent
    .filter((text) => text.length > 0)
    .join("\n\n")

  log(`[call_omo_agent] Got response, length: ${responseText.length}`)

  return responseText
}
