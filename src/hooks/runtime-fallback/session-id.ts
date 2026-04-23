import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { getDataDir } from "../../shared/data-path"

function asSessionID(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function getDbPath(): string {
  return join(getDataDir(), "opencode", "opencode.db")
}

const messageSessionCache = new Map<string, string>()
const partSessionCache = new Map<string, string>()

function primeEventSessionCaches(
  sessionID: string | undefined,
  messageID: string | undefined,
  partID: string | undefined,
): void {
  if (!sessionID) {
    return
  }

  if (messageID) {
    messageSessionCache.set(messageID, sessionID)
  }

  if (partID) {
    partSessionCache.set(partID, sessionID)
  }
}

function lookupSessionIDByMessageID(messageID: string | undefined): string | undefined {
  if (!messageID) return undefined

  if (messageSessionCache.has(messageID)) {
    return messageSessionCache.get(messageID)
  }

  const dbPath = getDbPath()
  if (!existsSync(dbPath)) {
    return undefined
  }

  let db: InstanceType<typeof Database> | undefined
  try {
    db = new Database(dbPath)
    const row = db.query("SELECT session_id FROM message WHERE id = ? LIMIT 1").get(messageID) as
      | { session_id?: string }
      | null
    const resolved = asSessionID(row?.session_id)
    if (resolved) {
      messageSessionCache.set(messageID, resolved)
    }
    return resolved
  } catch {
    return undefined
  } finally {
    try {
      db?.close()
    } catch {
    }
  }
}

function lookupSessionIDByPartID(partID: string | undefined): string | undefined {
  if (!partID) return undefined

  if (partSessionCache.has(partID)) {
    return partSessionCache.get(partID)
  }

  const dbPath = getDbPath()
  if (!existsSync(dbPath)) {
    return undefined
  }

  let db: InstanceType<typeof Database> | undefined
  try {
    db = new Database(dbPath)
    const row = db.query(`
      SELECT message.session_id AS session_id
      FROM part
      INNER JOIN message ON message.id = part.message_id
      WHERE part.id = ?
      LIMIT 1
    `).get(partID) as { session_id?: string } | null
    const resolved = asSessionID(row?.session_id)
    if (resolved) {
      partSessionCache.set(partID, resolved)
    }
    return resolved
  } catch {
    return undefined
  } finally {
    try {
      db?.close()
    } catch {
    }
  }
}

function getEventMessageID(props: Record<string, unknown> | undefined): string | undefined {
  const info = props?.info as Record<string, unknown> | undefined
  const part = props?.part as Record<string, unknown> | undefined

  return asSessionID(part?.messageID)
    ?? asSessionID(part?.messageId)
    ?? asSessionID(info?.messageID)
    ?? asSessionID(info?.messageId)
    ?? asSessionID(props?.messageID)
    ?? asSessionID(props?.messageId)
    ?? asSessionID(info?.id)
}

function getEventPartID(props: Record<string, unknown> | undefined): string | undefined {
  const part = props?.part as Record<string, unknown> | undefined

  return asSessionID(part?.id)
    ?? asSessionID(props?.partID)
    ?? asSessionID(props?.partId)
}

export function resetRuntimeFallbackSessionIDCache(): void {
  messageSessionCache.clear()
  partSessionCache.clear()
}

export function getRuntimeFallbackSessionID(props: Record<string, unknown> | undefined): string | undefined {
  const info = props?.info as Record<string, unknown> | undefined
  const part = props?.part as Record<string, unknown> | undefined
  const directSessionID =
    asSessionID(info?.sessionID)
    ?? asSessionID(info?.sessionId)
    ?? asSessionID(part?.sessionID)
    ?? asSessionID(part?.sessionId)
    ?? asSessionID(props?.sessionID)
    ?? asSessionID(props?.sessionId)
  const messageID = getEventMessageID(props)
  const partID = getEventPartID(props)

  if (directSessionID) {
    primeEventSessionCaches(directSessionID, messageID, partID)
    return directSessionID
  }

  const resolvedFromMessageID = lookupSessionIDByMessageID(messageID)
  if (resolvedFromMessageID) {
    primeEventSessionCaches(resolvedFromMessageID, messageID, partID)
    return resolvedFromMessageID
  }

  const resolvedFromPartID = lookupSessionIDByPartID(partID)
  if (resolvedFromPartID) {
    primeEventSessionCaches(resolvedFromPartID, messageID, partID)
    return resolvedFromPartID
  }

  return undefined
}
