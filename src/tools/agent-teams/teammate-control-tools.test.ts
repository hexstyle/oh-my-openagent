/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createForceKillTeammateTool, createProcessShutdownApprovedTool } from "./teammate-control-tools"
import { readTeamConfig } from "./team-config-store"
import { upsertTeammate, writeTeamConfig } from "./team-config-store"
import { ensureInbox } from "./inbox-store"

const TEST_SUFFIX = randomUUID().substring(0, 8)

interface TestToolContext {
  sessionID: string
  messageID: string
  agent: string
  abort: AbortSignal
}

function createContext(sessionID = "ses-main"): TestToolContext {
  return {
    sessionID,
    messageID: "msg-main",
    agent: "sisyphus",
    abort: new AbortController().signal as AbortSignal,
  }
}

async function executeJsonTool(
  tool: any,
  args: Record<string, unknown>,
  context: TestToolContext,
): Promise<unknown> {
  const output = await tool.execute(args, context)
  return JSON.parse(output)
}

describe("teammate-control-tools", () => {
  let originalCwd: string
  let tempProjectDir: string
  const teamName = `test-team-control-${TEST_SUFFIX}`

  beforeEach(() => {
    originalCwd = process.cwd()
    tempProjectDir = mkdtempSync(join(tmpdir(), "agent-teams-control-"))
    process.chdir(tempProjectDir)

    const { createTeamConfig, readTeamConfig } = require("./team-config-store")
    const context = createContext()
    const cwd = process.cwd()

    if (!readTeamConfig(teamName)) {
      createTeamConfig(
        teamName,
        "Test team",
        context.sessionID,
        cwd,
        "native/team-lead",
      )
    }

    ensureInbox(teamName, "team-lead")
  })

  afterEach(() => {
    process.chdir(originalCwd)
    if (existsSync(tempProjectDir)) {
      rmSync(tempProjectDir, { recursive: true, force: true })
    }
  })

  describe("createForceKillTeammateTool", () => {
    it("returns error when team not found", async () => {
      const tool = createForceKillTeammateTool()
      const testContext = createContext()

      const result = await executeJsonTool(
        tool,
        { team_name: "nonexistent-team", teammate_name: "test-teammate" },
        testContext,
      )

      expect(result).toHaveProperty("error")
    })

    it("returns error when trying to remove team-lead", async () => {
      const tool = createForceKillTeammateTool()
      const testContext = createContext()

      const result = await executeJsonTool(
        tool,
        { team_name: teamName, teammate_name: "team-lead" },
        testContext,
      )

      expect(result).toHaveProperty("error", "cannot_remove_team_lead")
    })

    it("returns error when teammate does not exist", async () => {
      const tool = createForceKillTeammateTool()
      const testContext = createContext()

      const result = await executeJsonTool(
        tool,
        { team_name: teamName, teammate_name: "nonexistent-teammate" },
        testContext,
      )

      expect(result).toHaveProperty("error", "teammate_not_found")
    })

    it("removes teammate from config and deletes inbox", async () => {
      const config = readTeamConfig(teamName)!
      const currentCwd = process.cwd()
      const teammate = {
        agentId: `test-teammate-${TEST_SUFFIX}@${teamName}`,
        name: `test-teammate-${TEST_SUFFIX}`,
        agentType: "teammate" as const,
        category: "quick",
        model: "gpt-5-mini",
        prompt: "Test prompt",
        planModeRequired: false,
        joinedAt: new Date().toISOString(),
        cwd: currentCwd,
        subscriptions: [],
        backendType: "native" as const,
        isActive: true,
        sessionID: `ses_teammate-${TEST_SUFFIX}`,
        backgroundTaskID: undefined,
        color: "#FF6B6B",
      }
      const updatedConfig = upsertTeammate(config, teammate)
      writeTeamConfig(teamName, updatedConfig)

      ensureInbox(teamName, `test-teammate-${TEST_SUFFIX}`)

      const tool = createForceKillTeammateTool()
      const testContext = createContext()

      const result = await executeJsonTool(
        tool,
        { team_name: teamName, teammate_name: `test-teammate-${TEST_SUFFIX}` },
        testContext,
      )

      expect(result).toHaveProperty("killed", true)
      expect(result).toHaveProperty("teammate_name", `test-teammate-${TEST_SUFFIX}`)

      const finalConfig = readTeamConfig(teamName)
      expect(finalConfig?.members.some((m) => m.name === `test-teammate-${TEST_SUFFIX}`)).toBe(false)

      const inboxPath = `.sisyphus/teams/${teamName}/inbox/test-teammate-${TEST_SUFFIX}.json`
      expect(existsSync(inboxPath)).toBe(false)
    })
  })

  describe("createProcessShutdownApprovedTool", () => {
    it("returns error when team not found", async () => {
      const tool = createProcessShutdownApprovedTool()
      const testContext = createContext()

      const result = await executeJsonTool(
        tool,
        { team_name: "nonexistent-team", teammate_name: "test-teammate" },
        testContext,
      )

      expect(result).toHaveProperty("error")
    })

    it("returns error when trying to remove team-lead", async () => {
      const tool = createProcessShutdownApprovedTool()
      const testContext = createContext()

      const result = await executeJsonTool(
        tool,
        { team_name: teamName, teammate_name: "team-lead" },
        testContext,
      )

      expect(result).toHaveProperty("error", "cannot_remove_team_lead")
    })

    it("returns error when teammate does not exist", async () => {
      const tool = createProcessShutdownApprovedTool()
      const testContext = createContext()

      const result = await executeJsonTool(
        tool,
        { team_name: teamName, teammate_name: "nonexistent-teammate" },
        testContext,
      )

      expect(result).toHaveProperty("error", "teammate_not_found")
    })

    it("removes teammate from config and deletes inbox gracefully", async () => {
      const config = readTeamConfig(teamName)!
      const currentCwd = process.cwd()
      const teammateName = `test-teammate2-${TEST_SUFFIX}`
      const teammate = {
        agentId: `${teammateName}@${teamName}`,
        name: teammateName,
        agentType: "teammate" as const,
        category: "quick",
        model: "gpt-5-mini",
        prompt: "Test prompt",
        planModeRequired: false,
        joinedAt: new Date().toISOString(),
        cwd: currentCwd,
        subscriptions: [],
        backendType: "native" as const,
        isActive: true,
        sessionID: `ses_${teammateName}`,
        backgroundTaskID: undefined,
        color: "#4ECDC4",
      }
      const updatedConfig = upsertTeammate(config, teammate)
      writeTeamConfig(teamName, updatedConfig)

      ensureInbox(teamName, teammateName)

      const tool = createProcessShutdownApprovedTool()
      const testContext = createContext()

      const result = await executeJsonTool(
        tool,
        { team_name: teamName, teammate_name: teammateName },
        testContext,
      )

      expect(result).toHaveProperty("shutdown_processed", true)
      expect(result).toHaveProperty("teammate_name", teammateName)

      const finalConfig = readTeamConfig(teamName)
      expect(finalConfig?.members.some((m) => m.name === teammateName)).toBe(false)

      const inboxPath = `.sisyphus/teams/${teamName}/inbox/${teammateName}.json`
      expect(existsSync(inboxPath)).toBe(false)
    })
  })
})
