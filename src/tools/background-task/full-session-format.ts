import type { BackgroundTask } from "../../features/background-agent"
import type { BackgroundOutputClient, BackgroundOutputMessagesResult, BackgroundOutputMessage } from "./clients"
import { extractMessages, getErrorMessage } from "./session-messages"
import { formatMessageTime } from "./time-format"
import { truncateText } from "./truncate-text"
import { formatTaskStatus } from "./task-status-format"

const MAX_MESSAGE_LIMIT = 100
const THINKING_MAX_CHARS = 2000
const TOOL_RESULT_MAX_CHARS = 4000

function extractRayId(text: string): string | undefined {
  const match = text.match(/\bRay ID[:\s]*([A-Za-z0-9-]+)/i)
  return match?.[1]
}

function summarizeProviderChallenge(text: string): string | undefined {
  const normalized = text.trim()
  if (!normalized) return undefined

  const looksLikeOpenAIChallenge =
    /unable to load site/i.test(normalized)
    && (
      /cdn-cgi\/challenge-platform/i.test(normalized)
      || /\bRay ID\b/i.test(normalized)
      || /chatgpt\.com/i.test(normalized)
      || /__cf_bm/i.test(normalized)
    )

  if (!looksLikeOpenAIChallenge) {
    return undefined
  }

  const rayId = extractRayId(normalized)
  return rayId
    ? `[provider challenge omitted: OpenAI/Codex 403 Cloudflare block | Ray ID: ${rayId}]`
    : "[provider challenge omitted: OpenAI/Codex 403 Cloudflare block]"
}

function formatVisibleText(text: string): string {
  const normalized = text.trim()
  return summarizeProviderChallenge(normalized) ?? normalized
}

function formatToolResultText(text: string): string {
  const normalized = text.trim()
  const summarized = summarizeProviderChallenge(normalized)
  if (summarized) {
    return summarized
  }

  return truncateText(normalized, TOOL_RESULT_MAX_CHARS)
}

function extractToolResultText(part: NonNullable<BackgroundOutputMessage["parts"]>[number]): string[] {
  if (typeof part.content === "string" && part.content.length > 0) {
    return [part.content]
  }

  if (Array.isArray(part.content)) {
    const blocks: string[] = []
    for (const block of part.content) {
      if ((block.type === "text" || block.type === "reasoning") && block.text) {
        blocks.push(block.text)
      }
    }
    if (blocks.length > 0) return blocks
  }

  if (part.output && part.output.length > 0) {
    return [part.output]
  }

  return []
}

export async function formatFullSession(
  task: BackgroundTask,
  client: BackgroundOutputClient,
  options: {
    includeThinking: boolean
    messageLimit?: number
    sinceMessageId?: string
    includeToolResults: boolean
    thinkingMaxChars?: number
  }
): Promise<string> {
  if (!task.sessionID) {
    return formatTaskStatus(task)
  }

  const messagesResult: BackgroundOutputMessagesResult = await client.session.messages({
    path: { id: task.sessionID },
  })

  const errorMessage = getErrorMessage(messagesResult)
  if (errorMessage) {
    return `Error fetching messages: ${errorMessage}`
  }

  const rawMessages = extractMessages(messagesResult)
  if (!Array.isArray(rawMessages)) {
    return "Error fetching messages: invalid response"
  }

  const sortedMessages = [...rawMessages].sort((a, b) => {
    const timeA = String(a.info?.time ?? "")
    const timeB = String(b.info?.time ?? "")
    return timeA.localeCompare(timeB)
  })

  let filteredMessages = sortedMessages
  if (options.sinceMessageId) {
    const index = filteredMessages.findIndex((message) => message.id === options.sinceMessageId)
    if (index === -1) {
      return `Error: since_message_id not found: ${options.sinceMessageId}`
    }
    filteredMessages = filteredMessages.slice(index + 1)
  }

  const includeThinking = options.includeThinking
  const includeToolResults = options.includeToolResults
  const thinkingMaxChars = options.thinkingMaxChars ?? THINKING_MAX_CHARS

  const normalizedMessages: BackgroundOutputMessage[] = []
  for (const message of filteredMessages) {
    const parts = (message.parts ?? []).filter((part) => {
      if (part.type === "thinking" || part.type === "reasoning") {
        return includeThinking
      }
      if (part.type === "tool_result") {
        return includeToolResults
      }
      return part.type === "text"
    })

    if (parts.length === 0) {
      continue
    }

    normalizedMessages.push({ ...message, parts })
  }

  const limit = typeof options.messageLimit === "number" ? Math.min(options.messageLimit, MAX_MESSAGE_LIMIT) : undefined
  const hasMore = limit !== undefined && normalizedMessages.length > limit
  const visibleMessages = limit !== undefined ? normalizedMessages.slice(0, limit) : normalizedMessages

  const lines: string[] = []
  lines.push("# Full Session Output")
  lines.push("")
  lines.push(`Task ID: ${task.id}`)
  lines.push(`Description: ${task.description}`)
  lines.push(`Status: ${task.status}`)
  lines.push(`Session ID: ${task.sessionID}`)
  lines.push(`Total messages: ${normalizedMessages.length}`)
  lines.push(`Returned: ${visibleMessages.length}`)
  lines.push(`Has more: ${hasMore ? "true" : "false"}`)
  lines.push("")
  lines.push("## Messages")

  if (visibleMessages.length === 0) {
    lines.push("")
    lines.push("(No messages found)")
    return lines.join("\n")
  }

  for (const message of visibleMessages) {
    const role = message.info?.role ?? "unknown"
    const agent = message.info?.agent ? ` (${message.info.agent})` : ""
    const time = formatMessageTime(message.info?.time)
    const idLabel = message.id ? ` id=${message.id}` : ""
    lines.push("")
    lines.push(`[${role}${agent}] ${time}${idLabel}`)

    for (const part of message.parts ?? []) {
      if (part.type === "text" && part.text) {
        lines.push(formatVisibleText(part.text))
      } else if (part.type === "thinking" && part.thinking) {
        lines.push(`[thinking] ${truncateText(part.thinking, thinkingMaxChars)}`)
      } else if (part.type === "reasoning" && part.text) {
        lines.push(`[thinking] ${truncateText(part.text, thinkingMaxChars)}`)
      } else if (part.type === "tool_result") {
        const toolTexts = extractToolResultText(part)
        for (const toolText of toolTexts) {
          lines.push(`[tool result] ${formatToolResultText(toolText)}`)
        }
      }
    }
  }

  return lines.join("\n")
}
