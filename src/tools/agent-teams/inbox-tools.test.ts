/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { appendInboxMessage, ensureInbox } from "./inbox-store"
import { deleteTeamData } from "./team-config-store"
import { createReadInboxTool } from "./inbox-tools"

describe("read_inbox tool", () => {
  let originalCwd: string
  let tempProjectDir: string
  let teamName: string
  const TEST_SESSION_ID = "test-session-123"
  const TEST_ABORT_CONTROLLER = new AbortController()
  const TEST_CONTEXT = {
    sessionID: TEST_SESSION_ID,
    messageID: "test-message-123",
    agent: "test-agent",
    abort: TEST_ABORT_CONTROLLER.signal,
  }

  beforeEach(() => {
    originalCwd = process.cwd()
    tempProjectDir = mkdtempSync(join(tmpdir(), "agent-teams-inbox-tools-"))
    process.chdir(tempProjectDir)
    teamName = `test-team-${randomUUID()}`
  })

  afterEach(() => {
    try {
      deleteTeamData(teamName)
    } catch {
      // ignore
    }
    process.chdir(originalCwd)
    rmSync(tempProjectDir, { recursive: true, force: true })
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(tempProjectDir, { recursive: true, force: true })
  })

  describe("read inbox action", () => {
    test("returns all messages when no filters", async () => {
      //#given
      ensureInbox(teamName, "team-lead")
      appendInboxMessage(teamName, "team-lead", {
        id: "msg-1",
        type: "message",
        sender: "user",
        recipient: "team-lead",
        content: "Hello",
        timestamp: new Date().toISOString(),
        read: false,
      })
      appendInboxMessage(teamName, "team-lead", {
        id: "msg-2",
        type: "message",
        sender: "user",
        recipient: "team-lead",
        content: "World",
        timestamp: new Date().toISOString(),
        read: true,
      })

      const tool = createReadInboxTool()

      //#when
      const resultStr = await tool.execute({
        team_name: teamName,
        agent_name: "team-lead",
      }, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result).toHaveLength(2)
      expect(result[0].id).toBe("msg-1")
      expect(result[1].id).toBe("msg-2")
    })

    test("returns only unread messages when unread_only is true", async () => {
      //#given
      ensureInbox(teamName, "team-lead")
      appendInboxMessage(teamName, "team-lead", {
        id: "msg-1",
        type: "message",
        sender: "user",
        recipient: "team-lead",
        content: "Hello",
        timestamp: new Date().toISOString(),
        read: false,
      })
      appendInboxMessage(teamName, "team-lead", {
        id: "msg-2",
        type: "message",
        sender: "user",
        recipient: "team-lead",
        content: "World",
        timestamp: new Date().toISOString(),
        read: true,
      })

      const tool = createReadInboxTool()

      //#when
      const resultStr = await tool.execute({
        team_name: teamName,
        agent_name: "team-lead",
        unread_only: true,
      }, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe("msg-1")
    })

    test("marks messages as read when mark_as_read is true", async () => {
      //#given
      ensureInbox(teamName, "team-lead")
      appendInboxMessage(teamName, "team-lead", {
        id: "msg-1",
        type: "message",
        sender: "user",
        recipient: "team-lead",
        content: "Hello",
        timestamp: new Date().toISOString(),
        read: false,
      })

      const tool = createReadInboxTool()

      //#when
      await tool.execute({
        team_name: teamName,
        agent_name: "team-lead",
        mark_as_read: true,
      }, TEST_CONTEXT)

      // Read again to check if marked as read
      const resultStr = await tool.execute({
        team_name: teamName,
        agent_name: "team-lead",
        unread_only: true,
      }, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result).toHaveLength(0) // Should be marked as read
    })

    test("returns empty array for non-existent inbox", async () => {
      //#given
      const tool = createReadInboxTool()

      //#when
      const resultStr = await tool.execute({
        team_name: "nonexistent",
        agent_name: "team-lead",
      }, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result).toEqual([])
    })

    test("requires team_name and agent_name parameters", async () => {
      //#given
      const tool = createReadInboxTool()

      //#when
      const resultStr = await tool.execute({}, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result).toHaveProperty("error")
    })
  })
})