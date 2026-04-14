import { describe, expect, it, spyOn } from "bun:test"

import * as loggerModule from "../../shared/logger"

import { inspectParentSessionTasks } from "./parent-session-tasks"

describe("inspectParentSessionTasks", () => {
  it("returns running task state when the manager lookup succeeds", () => {
    const result = inspectParentSessionTasks({
      backgroundManager: {
        getTasksByParentSession: () => [
          { id: "task-1", status: "running" },
          { id: "task-2", status: "completed" },
        ],
      } as never,
      sessionID: "session-running",
      logScope: "test-scope",
    })

    expect(result.available).toBe(true)
    expect(result.hasRunningTasks).toBe(true)
    expect(result.hasActiveTasks).toBe(true)
    expect(result.tasks).toHaveLength(2)
  })

  it("treats pending tasks as active parent-session work", () => {
    const result = inspectParentSessionTasks({
      backgroundManager: {
        getTasksByParentSession: () => [
          { id: "task-1", status: "pending" },
          { id: "task-2", status: "completed" },
        ],
      } as never,
      sessionID: "session-pending",
      logScope: "test-scope",
    })

    expect(result.available).toBe(true)
    expect(result.hasRunningTasks).toBe(false)
    expect(result.hasActiveTasks).toBe(true)
    expect(result.tasks).toHaveLength(2)
  })

  it("swallows manager lookup failures and logs a readable error", () => {
    const logCalls: Array<{ message: string; data?: unknown }> = []
    const logSpy = spyOn(loggerModule, "log").mockImplementation((message: string, data?: unknown) => {
      logCalls.push({ message, data })
    })

    const result = inspectParentSessionTasks({
      backgroundManager: {
        getTasksByParentSession: () => {
          throw new Error("task registry unavailable")
        },
      } as never,
      sessionID: "session-error",
      logScope: "test-scope",
    })

    expect(result).toEqual({
      available: false,
      tasks: [],
      hasRunningTasks: false,
      hasActiveTasks: false,
    })
    expect(logCalls).toContainEqual({
      message: "[test-scope] Failed to inspect background tasks",
      data: {
        sessionID: "session-error",
        error: "Error: task registry unavailable",
      },
    })

    logSpy.mockRestore()
  })
})
