import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import * as dataPathModule from "../../shared/data-path"
import { getRuntimeFallbackSessionID, resetRuntimeFallbackSessionIDCache } from "./session-id"

describe("runtime fallback session id resolution", () => {
  let db: Database | undefined
  let dataDir: string

  beforeEach(() => {
    dataDir = join(tmpdir(), `runtime-fallback-session-id-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(join(dataDir, "opencode"), { recursive: true })
    db = new Database(join(dataDir, "opencode", "opencode.db"))
    db.exec(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL
      );
    `)
    mock.module("../../shared/data-path", () => ({
      ...dataPathModule,
      getDataDir: () => dataDir,
    }))
    resetRuntimeFallbackSessionIDCache()
  })

  afterEach(() => {
    resetRuntimeFallbackSessionIDCache()
    try {
      db?.close()
    } catch {
    }
    mock.restore()
  })

  it("does not poison later lookups when an event arrives before its message row is committed", () => {
    const messageID = "msg_live_pending_commit"
    const sessionID = "ses_live_commit_later"

    expect(getRuntimeFallbackSessionID({
      info: {
        id: messageID,
        role: "assistant",
      },
    })).toBeUndefined()

    db?.query("INSERT INTO message (id, session_id) VALUES (?, ?)").run(messageID, sessionID)

    expect(getRuntimeFallbackSessionID({
      info: {
        id: messageID,
        role: "assistant",
      },
    })).toBe(sessionID)
  })

  it("does not poison later lookups when an event arrives before its part row is committed", () => {
    const messageID = "msg_live_part_commit_later"
    const partID = "prt_live_part_commit_later"
    const sessionID = "ses_live_part_commit_later"

    expect(getRuntimeFallbackSessionID({
      part: {
        id: partID,
        type: "tool",
      },
    })).toBeUndefined()

    db?.query("INSERT INTO message (id, session_id) VALUES (?, ?)").run(messageID, sessionID)
    db?.query("INSERT INTO part (id, message_id) VALUES (?, ?)").run(partID, messageID)

    expect(getRuntimeFallbackSessionID({
      part: {
        id: partID,
        type: "tool",
      },
    })).toBe(sessionID)
  })

  it("reuses a cached part to session binding for later delta-only events before the part row is committed", () => {
    const messageID = "msg_live_part_cache_only"
    const partID = "prt_live_part_cache_only"
    const sessionID = "ses_live_part_cache_only"

    expect(getRuntimeFallbackSessionID({
      part: {
        id: partID,
        sessionID,
        messageID,
        type: "reasoning",
      },
    })).toBe(sessionID)

    expect(getRuntimeFallbackSessionID({
      partID,
      field: "text",
      delta: "Still streaming the same assistant turn.",
    })).toBe(sessionID)
  })

  it("reuses a cached message to session binding for later info-only events before the message row is committed", () => {
    const messageID = "msg_live_message_cache_only"
    const sessionID = "ses_live_message_cache_only"

    expect(getRuntimeFallbackSessionID({
      info: {
        sessionID,
        id: messageID,
        role: "assistant",
      },
    })).toBe(sessionID)

    expect(getRuntimeFallbackSessionID({
      info: {
        id: messageID,
        role: "assistant",
      },
    })).toBe(sessionID)
  })
})
