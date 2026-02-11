/// <reference types="bun-types" />
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { acquireLock } from "../../features/claude-tasks/storage"
import { getTeamDir, getTeamTaskDir, getTeamsRootDir } from "./paths"
import {
  createTeamConfig,
  deleteTeamData,
  deleteTeamDir,
  listTeams,
  readTeamConfigOrThrow,
  teamExists,
  upsertTeammate,
  writeTeamConfig,
} from "./team-config-store"

describe("agent-teams team config store", () => {
  let originalCwd: string
  let tempProjectDir: string
  let createdTeams: string[]
  let teamPrefix: string

  beforeAll(() => {
    const allTeams = listTeams()
    for (const team of allTeams) {
      if (team.startsWith("core-") || team.startsWith("team-alpha-") || team.startsWith("team-beta-") || team.startsWith("delete-dir-test-")) {
        try {
          deleteTeamData(team)
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  })

  beforeEach(() => {
    originalCwd = process.cwd()
    tempProjectDir = mkdtempSync(join(tmpdir(), "agent-teams-config-store-"))
    process.chdir(tempProjectDir)
    createdTeams = []
    teamPrefix = randomUUID().slice(0, 8)
    createTeamConfig(`core-${teamPrefix}`, "Core team", `ses-main-${teamPrefix}`, tempProjectDir, "sisyphus")
    createdTeams.push(`core-${teamPrefix}`)
  })

  afterAll(() => {
    for (const teamName of createdTeams) {
      if (teamExists(teamName)) {
        try {
          deleteTeamData(teamName)
        } catch {
          // Ignore cleanup errors
        }
      }
    }
    process.chdir(originalCwd)
    try {
      rmSync(tempProjectDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
  })

  test("deleteTeamData waits for team lock before removing team files", () => {
    //#given
    const teamName = createdTeams[0]
    const lock = acquireLock(getTeamDir(teamName))
    expect(lock.acquired).toBe(true)

    try {
      //#when
      const deleteWhileLocked = () => deleteTeamData(teamName)

      //#then
      expect(deleteWhileLocked).toThrow("team_lock_unavailable")
      expect(teamExists(teamName)).toBe(true)
    } finally {
      //#when
      lock.release()
    }

    deleteTeamData(teamName)

    //#then
    expect(teamExists(teamName)).toBe(false)
  })

  test("deleteTeamData waits for task lock before removing task files", () => {
    //#given
    const teamName = createdTeams[0]
    const lock = acquireLock(getTeamTaskDir(teamName))
    expect(lock.acquired).toBe(true)

    try {
      //#when
      const deleteWhileLocked = () => deleteTeamData(teamName)

      //#then
      expect(deleteWhileLocked).toThrow("team_task_lock_unavailable")
      expect(teamExists(teamName)).toBe(true)
    } finally {
      lock.release()
    }

    //#when
    deleteTeamData(teamName)

    //#then
    expect(teamExists(teamName)).toBe(false)
  })

  test("deleteTeamData removes task files before deleting team directory", () => {
    //#given
    const teamName = createdTeams[0]
    const taskDir = getTeamTaskDir(teamName)
    const teamDir = getTeamDir(teamName)
    const teamsRootDir = getTeamsRootDir()
    expect(existsSync(taskDir)).toBe(true)
    expect(existsSync(teamDir)).toBe(true)

    //#when
    chmodSync(teamsRootDir, 0o555)
    try {
      const deleteWithBlockedTeamParent = () => deleteTeamData(teamName)
      expect(deleteWithBlockedTeamParent).toThrow()
    } finally {
      chmodSync(teamsRootDir, 0o755)
    }

    //#then
    expect(existsSync(taskDir)).toBe(false)
    expect(existsSync(teamDir)).toBe(true)
  })

  test("listTeams returns empty array when no teams exist", () => {
    //#given
    const testTeamName = `empty-test-${randomUUID().slice(0, 8)}`
    const allTeamsBefore = listTeams().filter(t => !t.startsWith("core-") && !t.startsWith("team-alpha-") && !t.startsWith("team-beta-") && !t.startsWith("delete-dir-test-"))
    const uniqueTestTeam = allTeamsBefore.find(t => t !== testTeamName)

    //#when
    const teams = listTeams()

    //#then
    expect(teams.length).toBeGreaterThanOrEqual(allTeamsBefore.length)
  })

  test("listTeams returns list of team names", () => {
    //#given
    const teamName = createdTeams[0]
    const alphaTeam = `team-alpha-${teamPrefix}`
    const betaTeam = `team-beta-${teamPrefix}`
    createTeamConfig(alphaTeam, "Alpha team", `ses-alpha-${teamPrefix}`, tempProjectDir, "sisyphus")
    createdTeams.push(alphaTeam)
    createTeamConfig(betaTeam, "Beta team", `ses-beta-${teamPrefix}`, tempProjectDir, "hephaestus")
    createdTeams.push(betaTeam)

    //#when
    const teams = listTeams()

    //#then
    expect(teams).toContain(teamName)
    expect(teams).toContain(alphaTeam)
    expect(teams).toContain(betaTeam)
  })

  test("deleteTeamDir is alias for deleteTeamData", () => {
    //#given
    const testTeamName = `delete-dir-test-${teamPrefix}`
    createTeamConfig(testTeamName, "Test team", `ses-delete-dir-${teamPrefix}`, tempProjectDir, "sisyphus")
    createdTeams.push(testTeamName)
    expect(teamExists(testTeamName)).toBe(true)

    //#when
    deleteTeamDir(testTeamName)

    //#then
    expect(teamExists(testTeamName)).toBe(false)
  })

  test("deleteTeamData fails if team has active teammates", () => {
    //#given
    const teamName = createdTeams[0]
    const config = readTeamConfigOrThrow(teamName)
    const updated = upsertTeammate(config, {
      agentId: `teammate@${teamName}`,
      name: "teammate",
      agentType: "teammate",
      category: "test",
      model: "sisyphus",
      prompt: "test prompt",
      color: "#000000",
      planModeRequired: false,
      joinedAt: new Date().toISOString(),
      cwd: process.cwd(),
      subscriptions: [],
      backendType: "native",
      isActive: true,
      sessionID: "ses-sub",
    })
    writeTeamConfig(teamName, updated)

    //#when
    const deleteWithTeammates = () => deleteTeamData(teamName)

    //#then
    expect(deleteWithTeammates).toThrow("team_has_active_members")
    expect(teamExists(teamName)).toBe(true)
  })

})
