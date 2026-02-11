/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createTeamCreateTool, createTeamDeleteTool } from "./team-lifecycle-tools"
import { getTeamConfigPath, getTeamDir, getTeamTaskDir } from "./paths"
import { readTeamConfig, listTeammates } from "./team-config-store"
import { getTeamsRootDir, getTeamTasksRootDir } from "./paths"
import { deleteTeamData } from "./team-config-store"

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
  tool: ReturnType<typeof createTeamCreateTool | typeof createTeamDeleteTool>,
  args: Record<string, unknown>,
  context: TestToolContext,
): Promise<unknown> {
  const output = await tool.execute(args, context)
  return JSON.parse(output)
}

describe("team_lifecycle tools", () => {
  let originalCwd: string
  let tempProjectDir: string

  beforeEach(() => {
    originalCwd = process.cwd()
    tempProjectDir = mkdtempSync(join(tmpdir(), "agent-teams-lifecycle-"))
    process.chdir(tempProjectDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(tempProjectDir, { recursive: true, force: true })
  })

  describe("team_create", () => {
    test("creates team with valid name and description", async () => {
      //#given
      const tool = createTeamCreateTool()
      const context = createContext()
      const teamName = `test-team-${TEST_SUFFIX}`

      //#when
      const result = await executeJsonTool(tool, {
        team_name: teamName,
        description: "My test team",
      }, context)

      //#then
      expect(result).toEqual({
        team_name: teamName,
        config_path: getTeamConfigPath(teamName),
        lead_agent_id: `team-lead@${teamName}`,
      })

      // Verify team was actually created
      const teamConfig = readTeamConfig(teamName)
      expect(teamConfig).not.toBeNull()
      expect(teamConfig?.name).toBe(teamName)
      expect(teamConfig?.description).toBe("My test team")
      expect(teamConfig?.leadAgentId).toBe(`team-lead@${teamName}`)
      expect(teamConfig?.leadSessionId).toBe("ses-main")
      expect(teamConfig?.members).toHaveLength(1)
      expect(teamConfig?.members[0].agentType).toBe("team-lead")
    })

    test("creates team with only name (description optional)", async () => {
      //#given
      const tool = createTeamCreateTool()
      const context = createContext()
      const teamName = `minimal-team-${TEST_SUFFIX}`

      //#when
      const result = await executeJsonTool(tool, {
        team_name: teamName,
      }, context)

      //#then
      expect(result).toEqual({
        team_name: teamName,
        config_path: getTeamConfigPath(teamName),
        lead_agent_id: `team-lead@${teamName}`,
      })

      const teamConfig = readTeamConfig(teamName)
      expect(teamConfig?.description).toBe("")
    })

    test("validates team name format (alphanumeric, hyphens, underscores only)", async () => {
      //#given
      const tool = createTeamCreateTool()
      const context = createContext()

      //#when
      const result = await executeJsonTool(tool, {
        team_name: "invalid@name",
      }, context)

      //#then
      expect(result).toEqual({
        error: "team_create_failed",
      })
    })

    test("validates team name max length (64 chars)", async () => {
      //#given
      const tool = createTeamCreateTool()
      const context = createContext()
      const longName = "a".repeat(65)

      //#when
      const result = await executeJsonTool(tool, {
        team_name: longName,
      }, context)

      //#then
      expect(result).toEqual({
        error: "team_create_failed",
      })
    })

    test("rejects duplicate team names", async () => {
      //#given
      const tool = createTeamCreateTool()
      const context1 = createContext("ses-1")
      const context2 = createContext("ses-2")
      const teamName = `duplicate-team-${TEST_SUFFIX}`

      // Create team first
      await executeJsonTool(tool, {
        team_name: teamName,
      }, context1)

      //#when - try to create same team again
      const result = await executeJsonTool(tool, {
        team_name: teamName,
      }, context2)

      //#then
      expect(result).toEqual({
        error: "team_already_exists",
      })

      // Verify first team still exists
      const teamConfig = readTeamConfig(teamName)
      expect(teamConfig).not.toBeNull()
    })
  })

  describe("team_delete", () => {
    test("deletes team when no active teammates", async () => {
      //#given
      const createTool = createTeamCreateTool()
      const deleteTool = createTeamDeleteTool()
      const context = createContext()
      const teamName = `test-delete-team-${TEST_SUFFIX}`

      // Create team first
      await executeJsonTool(createTool, {
        team_name: teamName,
      }, context)

      //#when
      const result = await executeJsonTool(deleteTool, {
        team_name: teamName,
      }, context)

      //#then
      expect(result).toEqual({
        deleted: true,
        team_name: teamName,
      })

      // Verify team dir is deleted
      expect(existsSync(getTeamDir(teamName))).toBe(false)
      expect(existsSync(getTeamTaskDir(teamName))).toBe(false)
      expect(existsSync(getTeamConfigPath(teamName))).toBe(false)
    })

    test("blocks deletion when team has active teammates", async () => {
      //#given
      const createTool = createTeamCreateTool()
      const deleteTool = createTeamDeleteTool()
      const context = createContext()
      const teamName = `team-with-members-${TEST_SUFFIX}`

      // Create team
      await executeJsonTool(createTool, {
        team_name: teamName,
      }, context)

      // Add a teammate by modifying config directly for test
      const teamConfig = readTeamConfig(teamName)
      expect(teamConfig).not.toBeNull()

      // Manually add a teammate to simulate active member
      const { writeTeamConfig } = await import("./team-config-store")
      if (teamConfig) {
        writeTeamConfig(teamName, {
          ...teamConfig,
          members: [
            ...teamConfig.members,
            {
              agentId: "teammate-1",
              name: "test-teammate",
              agentType: "teammate",
              color: "#FF6B6B",
              category: "test",
              model: "test-model",
              prompt: "Test prompt",
              planModeRequired: false,
              joinedAt: new Date().toISOString(),
              cwd: "/tmp",
              subscriptions: [],
              backendType: "native",
              isActive: true,
              sessionID: "test-session",
            },
          ],
        })
      }

      //#when
      const result = await executeJsonTool(deleteTool, {
        team_name: teamName,
      }, context)

      //#then
      expect(result).toEqual({
        error: "team_has_active_members",
        members: ["test-teammate"],
      })

      // Cleanup - manually remove teammates first, then delete
      const configApi = await import("./team-config-store")
      const cleanupConfig = readTeamConfig(teamName)
      if (cleanupConfig) {
        configApi.writeTeamConfig(teamName, {
          ...cleanupConfig,
          members: cleanupConfig.members.filter((m) => m.agentType === "team-lead"),
        })
        configApi.deleteTeamData(teamName)
      }
    })

    test("validates team name format on deletion", async () => {
      //#given
      const deleteTool = createTeamDeleteTool()
      const context = createContext()
      const teamName = `invalid-team-${TEST_SUFFIX}`

      //#when
      const result = await executeJsonTool(deleteTool, {
        team_name: "invalid@name",
      }, context)

      //#then - Zod returns detailed validation error array
      const parsedResult = result as { error: string }
      expect(parsedResult.error).toContain("Team name must contain only letters")
    })

    test("returns error for non-existent team", async () => {
      //#given
      const deleteTool = createTeamDeleteTool()
      const context = createContext()

      //#when
      const result = await executeJsonTool(deleteTool, {
        team_name: "non-existent-team",
      }, context)

      //#then
      expect(result).toEqual({
        error: "team_not_found",
      })
    })
  })
})
