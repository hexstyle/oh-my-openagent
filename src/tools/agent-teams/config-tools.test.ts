/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createTeamConfig, deleteTeamData } from "./team-config-store"
import { createReadConfigTool } from "./config-tools"

describe("read_config tool", () => {
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
    tempProjectDir = mkdtempSync(join(tmpdir(), "agent-teams-config-tools-"))
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

  describe("read config action", () => {
    test("returns team config when team exists", async () => {
      //#given
      const config = createTeamConfig(teamName, "Test team", TEST_SESSION_ID, "/tmp", "claude-opus-4-6")
      const tool = createReadConfigTool()

      //#when
      const resultStr = await tool.execute({
        team_name: teamName,
      }, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result.name).toBe(teamName)
      expect(result.description).toBe("Test team")
      expect(result.members).toHaveLength(1)
      expect(result.members[0].name).toBe("team-lead")
      expect(result.members[0].agentType).toBe("team-lead")
    })

    test("returns error for non-existent team", async () => {
      //#given
      const tool = createReadConfigTool()

      //#when
      const resultStr = await tool.execute({
        team_name: "nonexistent-team-12345",
      }, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result).toHaveProperty("error")
      expect(result.error).toBe("team_not_found")
    })

    test("requires team_name parameter", async () => {
      //#given
      const tool = createReadConfigTool()

      //#when
      const resultStr = await tool.execute({}, TEST_CONTEXT)
      const result = JSON.parse(resultStr)

      //#then
      expect(result).toHaveProperty("error")
    })
  })
})