import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { z } from "zod"
import { acquireLock, ensureDir, writeJsonAtomic } from "../../features/claude-tasks/storage"
import { getTeamInboxPath } from "./paths"
import type { InboxMessage } from "./types"
import { InboxMessageSchema } from "./types"

const InboxMessageListSchema = z.array(InboxMessageSchema)

function assertValidTeamName(teamName: string): void {
  const errors: string[] = []

  if (!/^[A-Za-z0-9_-]+$/.test(teamName)) {
    errors.push("Team name must contain only letters, numbers, hyphens, and underscores")
  }
  if (teamName.length > 64) {
    errors.push("Team name must be at most 64 characters")
  }

  if (errors.length > 0) {
    throw new Error(`Invalid team name: ${errors.join(", ")}`)
  }
}

function assertValidAgentName(agentName: string): void {
  if (!agentName || agentName.length === 0) {
    throw new Error("Agent name must not be empty")
  }
}

function getTeamInboxDirFromName(teamName: string): string {
  const { dirname } = require("node:path")
  return dirname(getTeamInboxPath(teamName, "dummy"))
}

function withInboxLock<T>(teamName: string, operation: () => T): T {
  assertValidTeamName(teamName)
  const inboxDir = getTeamInboxDirFromName(teamName)
  ensureDir(inboxDir)
  const lock = acquireLock(inboxDir)

  if (!lock.acquired) {
    throw new Error("inbox_lock_unavailable")
  }

  try {
    return operation()
  } finally {
    lock.release()
  }
}

function parseInboxFile(content: string): InboxMessage[] {
  let parsed: unknown

  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error("team_inbox_parse_failed")
  }

  const result = InboxMessageListSchema.safeParse(parsed)
  if (!result.success) {
    throw new Error("team_inbox_schema_invalid")
  }

  return result.data
}

function readInboxMessages(teamName: string, agentName: string): InboxMessage[] {
  assertValidTeamName(teamName)
  assertValidAgentName(agentName)
  const path = getTeamInboxPath(teamName, agentName)

  if (!existsSync(path)) {
    return []
  }

  return parseInboxFile(readFileSync(path, "utf-8"))
}

function writeInboxMessages(teamName: string, agentName: string, messages: InboxMessage[]): void {
  assertValidTeamName(teamName)
  assertValidAgentName(agentName)
  const path = getTeamInboxPath(teamName, agentName)
  writeJsonAtomic(path, messages)
}

export function ensureInbox(teamName: string, agentName: string): void {
  assertValidTeamName(teamName)
  assertValidAgentName(agentName)

  withInboxLock(teamName, () => {
    const path = getTeamInboxPath(teamName, agentName)

    if (!existsSync(path)) {
      writeJsonAtomic(path, [])
    }
  })
}

export function appendInboxMessage(teamName: string, agentName: string, message: InboxMessage): void {
  assertValidTeamName(teamName)
  assertValidAgentName(agentName)

  withInboxLock(teamName, () => {
    const path = getTeamInboxPath(teamName, agentName)
    const messages = existsSync(path) ? parseInboxFile(readFileSync(path, "utf-8")) : []
    messages.push(InboxMessageSchema.parse(message))
    writeInboxMessages(teamName, agentName, messages)
  })
}

export function readInbox(teamName: string, agentName: string, unreadOnly = false, markAsRead = false): InboxMessage[] {
  return withInboxLock(teamName, () => {
    const messages = readInboxMessages(teamName, agentName)

    const selectedIndexes = new Set<number>()

    const selected = unreadOnly
      ? messages.filter((message, index) => {
          if (!message.read) {
            selectedIndexes.add(index)
            return true
          }
          return false
        })
      : messages.map((message, index) => {
          selectedIndexes.add(index)
          return message
        })

    if (!markAsRead || selected.length === 0) {
      return selected
    }

    let changed = false

    const updated = messages.map((message, index) => {
      if (selectedIndexes.has(index) && !message.read) {
        changed = true
        return { ...message, read: true }
      }
      return message
    })

    if (changed) {
      writeInboxMessages(teamName, agentName, updated)
    }

    return updated.filter((_, index) => selectedIndexes.has(index))
  })
}

export function markMessagesRead(teamName: string, agentName: string, messageIds: string[]): void {
  assertValidTeamName(teamName)
  assertValidAgentName(agentName)

  if (messageIds.length === 0) {
    return
  }

  withInboxLock(teamName, () => {
    const messages = readInboxMessages(teamName, agentName)
    const idsToMark = new Set(messageIds)

    const updated = messages.map((message) => {
      if (idsToMark.has(message.id) && !message.read) {
        return { ...message, read: true }
      }
      return message
    })

    const changed = updated.some((msg, index) => msg.read !== messages[index].read)

    if (changed) {
      writeInboxMessages(teamName, agentName, updated)
    }
  })
}

export function deleteInbox(teamName: string, agentName: string): void {
  assertValidTeamName(teamName)
  assertValidAgentName(agentName)

  withInboxLock(teamName, () => {
    const path = getTeamInboxPath(teamName, agentName)

    if (existsSync(path)) {
      unlinkSync(path)
    }
  })
}

export const clearInbox = deleteInbox

export { buildShutdownRequestId, sendPlainInboxMessage, sendStructuredInboxMessage } from "./inbox-message-sender"
