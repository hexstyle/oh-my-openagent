/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { ensureDir } from "../../features/claude-tasks/storage"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  getTeamTaskPath,
  readTeamTask,
  writeTeamTask,
  listTeamTasks,
  deleteTeamTask,
} from "./team-task-store"
import type { TeamTask } from "./types"

describe("getTeamTaskPath", () => {
  test("returns correct file path for team task", () => {
    //#given
    const teamName = "my-team"
    const taskId = "T-abc123"

    //#when
    const result = getTeamTaskPath(teamName, taskId)

    //#then
    expect(result).toContain("my-team")
    expect(result).toContain("T-abc123.json")
  })
})

describe("readTeamTask", () => {
  let originalCwd: string
  let tempProjectDir: string

  beforeEach(() => {
    originalCwd = process.cwd()
    tempProjectDir = mkdtempSync(join(tmpdir(), "team-task-store-test-"))
    process.chdir(tempProjectDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    if (existsSync(tempProjectDir)) {
      rmSync(tempProjectDir, { recursive: true, force: true })
    }
  })

  test("returns null when task file does not exist", () => {
    //#given
    const teamName = "nonexistent-team"
    const taskId = "T-does-not-exist"

    //#when
    const result = readTeamTask(teamName, taskId)

    //#then
    expect(result).toBeNull()
  })

  test("returns task when valid task file exists", () => {
    //#given
    const task: TeamTask = {
      id: "T-existing-task",
      subject: "Test task",
      description: "Test description",
      status: "pending",
      blocks: [],
      blockedBy: [],
      threadID: "ses_test",
    }
    writeTeamTask("test-team", "T-existing-task", task)

    //#when
    const result = readTeamTask("test-team", "T-existing-task")

    //#then
    expect(result).not.toBeNull()
    expect(result?.id).toBe("T-existing-task")
    expect(result?.subject).toBe("Test task")
  })

  test("returns null when task file contains invalid JSON", () => {
    //#given
    const taskPath = getTeamTaskPath("invalid-team", "T-invalid-json")
    const parentDir = dirname(taskPath)
    rmSync(parentDir, { recursive: true, force: true })
    ensureDir(parentDir)
    writeFileSync(taskPath, "{ invalid json }")

    //#when
    const result = readTeamTask("invalid-team", "T-invalid-json")

    //#then
    expect(result).toBeNull()
  })

  test("returns null when task file does not match schema", () => {
    //#given
    const taskPath = getTeamTaskPath("invalid-schema-team", "T-bad-schema")
    const parentDir = dirname(taskPath)
    rmSync(parentDir, { recursive: true, force: true })
    ensureDir(parentDir)
    const invalidData = { id: "T-bad-schema" }
    writeFileSync(taskPath, JSON.stringify(invalidData))

    //#when
    const result = readTeamTask("invalid-schema-team", "T-bad-schema")

    //#then
    expect(result).toBeNull()
  })
})

describe("writeTeamTask", () => {
  let originalCwd: string
  let tempProjectDir: string

  beforeEach(() => {
    originalCwd = process.cwd()
    tempProjectDir = mkdtempSync(join(tmpdir(), "team-task-store-test-"))
    process.chdir(tempProjectDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    if (existsSync(tempProjectDir)) {
      rmSync(tempProjectDir, { recursive: true, force: true })
    }
  })

  test("creates task file in team namespace", () => {
    //#given
    const task: TeamTask = {
      id: "T-write-test",
      subject: "Write test task",
      description: "Test writing task",
      status: "in_progress",
      blocks: [],
      blockedBy: [],
      threadID: "ses_write",
    }

    //#when
    writeTeamTask("write-team", "T-write-test", task)

    //#then
    const taskPath = getTeamTaskPath("write-team", "T-write-test")
    expect(existsSync(taskPath)).toBe(true)
  })

  test("overwrites existing task file", () => {
    //#given
    const task: TeamTask = {
      id: "T-overwrite-test",
      subject: "Original subject",
      description: "Original description",
      status: "pending",
      blocks: [],
      blockedBy: [],
      threadID: "ses_original",
    }
    writeTeamTask("overwrite-team", "T-overwrite-test", task)

    const updatedTask: TeamTask = {
      ...task,
      subject: "Updated subject",
      status: "completed",
    }

    //#when
    writeTeamTask("overwrite-team", "T-overwrite-test", updatedTask)

    //#then
    const result = readTeamTask("overwrite-team", "T-overwrite-test")
    expect(result?.subject).toBe("Updated subject")
    expect(result?.status).toBe("completed")
  })

  test("creates team directory if it does not exist", () => {
    //#given
    const task: TeamTask = {
      id: "T-new-dir",
      subject: "New directory test",
      description: "Test",
      status: "pending",
      blocks: [],
      blockedBy: [],
      threadID: "ses_newdir",
    }

    //#when
    writeTeamTask("new-team-directory", "T-new-dir", task)

    //#then
    const taskPath = getTeamTaskPath("new-team-directory", "T-new-dir")
    expect(existsSync(taskPath)).toBe(true)
  })
})

describe("listTeamTasks", () => {
  let originalCwd: string
  let tempProjectDir: string

  beforeEach(() => {
    originalCwd = process.cwd()
    tempProjectDir = mkdtempSync(join(tmpdir(), "team-task-store-test-"))
    process.chdir(tempProjectDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    if (existsSync(tempProjectDir)) {
      rmSync(tempProjectDir, { recursive: true, force: true })
    }
  })

  test("returns empty array when team has no tasks", () => {
    //#given
    // No tasks written

    //#when
    const result = listTeamTasks("empty-team")

    //#then
    expect(result).toEqual([])
  })

  test("returns all tasks for a team", () => {
    //#given
    const task1: TeamTask = {
      id: "T-task-1",
      subject: "Task 1",
      description: "First task",
      status: "pending",
      blocks: [],
      blockedBy: [],
      threadID: "ses_1",
    }
    const task2: TeamTask = {
      id: "T-task-2",
      subject: "Task 2",
      description: "Second task",
      status: "in_progress",
      blocks: [],
      blockedBy: [],
      threadID: "ses_2",
    }
    writeTeamTask("list-test-team", "T-task-1", task1)
    writeTeamTask("list-test-team", "T-task-2", task2)

    //#when
    const result = listTeamTasks("list-test-team")

    //#then
    expect(result).toHaveLength(2)
    expect(result.some((t) => t.id === "T-task-1")).toBe(true)
    expect(result.some((t) => t.id === "T-task-2")).toBe(true)
  })

  test("includes tasks with all statuses", () => {
    //#given
    const pendingTask: TeamTask = {
      id: "T-pending",
      subject: "Pending task",
      description: "Test",
      status: "pending",
      blocks: [],
      blockedBy: [],
      threadID: "ses_pending",
    }
    const inProgressTask: TeamTask = {
      id: "T-in-progress",
      subject: "In progress task",
      description: "Test",
      status: "in_progress",
      blocks: [],
      blockedBy: [],
      threadID: "ses_inprogress",
    }
    const completedTask: TeamTask = {
      id: "T-completed",
      subject: "Completed task",
      description: "Test",
      status: "completed",
      blocks: [],
      blockedBy: [],
      threadID: "ses_completed",
    }
    const deletedTask: TeamTask = {
      id: "T-deleted",
      subject: "Deleted task",
      description: "Test",
      status: "deleted",
      blocks: [],
      blockedBy: [],
      threadID: "ses_deleted",
    }
    writeTeamTask("status-test-team", "T-pending", pendingTask)
    writeTeamTask("status-test-team", "T-in-progress", inProgressTask)
    writeTeamTask("status-test-team", "T-completed", completedTask)
    writeTeamTask("status-test-team", "T-deleted", deletedTask)

    //#when
    const result = listTeamTasks("status-test-team")

    //#then
    expect(result).toHaveLength(4)
    const statuses = result.map((t) => t.status)
    expect(statuses).toContain("pending")
    expect(statuses).toContain("in_progress")
    expect(statuses).toContain("completed")
    expect(statuses).toContain("deleted")
  })

  test("does not include tasks from other teams", () => {
    //#given
    const taskTeam1: TeamTask = {
      id: "T-team1-task",
      subject: "Team 1 task",
      description: "Test",
      status: "pending",
      blocks: [],
      blockedBy: [],
      threadID: "ses_team1",
    }
    const taskTeam2: TeamTask = {
      id: "T-team2-task",
      subject: "Team 2 task",
      description: "Test",
      status: "pending",
      blocks: [],
      blockedBy: [],
      threadID: "ses_team2",
    }
    writeTeamTask("team-1", "T-team1-task", taskTeam1)
    writeTeamTask("team-2", "T-team2-task", taskTeam2)

    //#when
    const result = listTeamTasks("team-1")

    //#then
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("T-team1-task")
  })
})

describe("deleteTeamTask", () => {
  let originalCwd: string
  let tempProjectDir: string

  beforeEach(() => {
    originalCwd = process.cwd()
    tempProjectDir = mkdtempSync(join(tmpdir(), "team-task-store-test-"))
    process.chdir(tempProjectDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    if (existsSync(tempProjectDir)) {
      rmSync(tempProjectDir, { recursive: true, force: true })
    }
  })

  test("deletes existing task file", () => {
    //#given
    const task: TeamTask = {
      id: "T-delete-me",
      subject: "Delete this task",
      description: "Test",
      status: "pending",
      blocks: [],
      blockedBy: [],
      threadID: "ses_delete",
    }
    writeTeamTask("delete-test-team", "T-delete-me", task)
    const taskPath = getTeamTaskPath("delete-test-team", "T-delete-me")

    //#when
    deleteTeamTask("delete-test-team", "T-delete-me")

    //#then
    expect(existsSync(taskPath)).toBe(false)
  })

  test("does not throw when task does not exist", () => {
    //#given
    // Task does not exist

    //#when
    expect(() => deleteTeamTask("nonexistent-team", "T-does-not-exist")).not.toThrow()

    //#then
    // No exception thrown
  })

  test("does not affect other tasks in same team", () => {
    //#given
    const task1: TeamTask = {
      id: "T-keep-me",
      subject: "Keep this task",
      description: "Test",
      status: "pending",
      blocks: [],
      blockedBy: [],
      threadID: "ses_keep",
    }
    const task2: TeamTask = {
      id: "T-delete-me",
      subject: "Delete this task",
      description: "Test",
      status: "pending",
      blocks: [],
      blockedBy: [],
      threadID: "ses_delete",
    }
    writeTeamTask("mixed-test-team", "T-keep-me", task1)
    writeTeamTask("mixed-test-team", "T-delete-me", task2)

    //#when
    deleteTeamTask("mixed-test-team", "T-delete-me")

    //#then
    const remaining = listTeamTasks("mixed-test-team")
    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBe("T-keep-me")
  })

  test("does not affect tasks from other teams", () => {
    //#given
    const task1: TeamTask = {
      id: "T-task-1",
      subject: "Task 1",
      description: "Test",
      status: "pending",
      blocks: [],
      blockedBy: [],
      threadID: "ses_1",
    }
    const task2: TeamTask = {
      id: "T-task-2",
      subject: "Task 2",
      description: "Test",
      status: "pending",
      blocks: [],
      blockedBy: [],
      threadID: "ses_2",
    }
    writeTeamTask("team-a", "T-task-1", task1)
    writeTeamTask("team-b", "T-task-2", task2)

    //#when
    deleteTeamTask("team-a", "T-task-1")

    //#then
    const remainingInTeamB = listTeamTasks("team-b")
    expect(remainingInTeamB).toHaveLength(1)
    expect(remainingInTeamB[0].id).toBe("T-task-2")
  })
})
