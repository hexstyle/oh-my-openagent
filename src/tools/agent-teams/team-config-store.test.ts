/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

  beforeEach(() => {
    originalCwd = process.cwd()
    tempProjectDir = mkdtempSync(join(tmpdir(), "agent-teams-config-store-"))
    process.chdir(tempProjectDir)
    createdTeams = []
    const timestamp = Date.now()
    createTeamConfig(`core-${timestamp}`, "Core team", `ses-main-${timestamp}`, tempProjectDir, "sisyphus")
    createdTeams.push(`core-${timestamp}`)
  })

  afterEach(() => {
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
    rmSync(tempProjectDir, { recursive: true, force: true })
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

    //#when - cleanup teammate to allow afterEach to succeed
    const cleared = { ...updated, members: updated.members.filter(m => m.name === "team-lead") }
    writeTeamConfig(teamName, cleared)
    deleteTeamData(teamName)

    //#then
    expect(teamExists(teamName)).toBe(false)
  })

})
