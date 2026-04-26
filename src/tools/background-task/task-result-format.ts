import type { BackgroundTask } from "../../features/background-agent"
import { consumeNewMessages } from "../../shared/session-cursor"
import type { BackgroundOutputClient, BackgroundOutputMessagesResult } from "./clients"
import { extractMessages, getErrorMessage } from "./session-messages"
import { formatDuration } from "./time-format"

function getTimeString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

export async function formatTaskResult(task: BackgroundTask, client: BackgroundOutputClient): Promise<string> {
  if (!task.sessionID) {
    return `Error: Task has no sessionID`
  }

  const messagesResult: BackgroundOutputMessagesResult = await client.session.messages({
    path: { id: task.sessionID },
  })

  const errorMessage = getErrorMessage(messagesResult)
  if (errorMessage) {
    return `Error fetching messages: ${errorMessage}`
  }

  const messages = extractMessages(messagesResult)
  if (!Array.isArray(messages) || messages.length === 0) {
    return `Task Result

Task ID: ${task.id}
Description: ${task.description}
Duration: ${formatDuration(task.startedAt ?? new Date(), task.completedAt)}
Session ID: ${task.sessionID}

---

(No messages found)`
  }

  // Only assistant messages — tool results are intermediate data (raw grep/bash
  // output, service tags, escape chars) that pollute the parent context.
  const assistantMessages = messages.filter((m) => m.info?.role === "assistant")
  if (assistantMessages.length === 0) {
    return `Task Result

Task ID: ${task.id}
Description: ${task.description}
Duration: ${formatDuration(task.startedAt ?? new Date(), task.completedAt)}
Session ID: ${task.sessionID}

---

(No assistant response found)`
  }

  const sortedMessages = [...assistantMessages].sort((a, b) => {
    const timeA = getTimeString(a.info?.time)
    const timeB = getTimeString(b.info?.time)
    return timeA.localeCompare(timeB)
  })

  const newMessages = consumeNewMessages(task.sessionID, sortedMessages)
  if (newMessages.length === 0) {
    const duration = formatDuration(task.startedAt ?? new Date(), task.completedAt)
    return `Task Result

Task ID: ${task.id}
Description: ${task.description}
Duration: ${duration}
Session ID: ${task.sessionID}

---

(No new output since last check)`
  }

  const extractedContent: string[] = []
  for (const message of newMessages) {
    for (const part of message.parts ?? []) {
      if ((part.type === "text" || part.type === "reasoning") && part.text) {
        extractedContent.push(part.text)
      }
    }
  }

  const textContent = extractedContent.filter((text) => text.length > 0).join("\n\n")
  const duration = formatDuration(task.startedAt ?? new Date(), task.completedAt)

  return `Task Result

Task ID: ${task.id}
Description: ${task.description}
Duration: ${duration}
Session ID: ${task.sessionID}

---

${textContent || "(No text output)"}`
}
