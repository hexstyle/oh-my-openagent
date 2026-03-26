import { describe, expect, test } from "bun:test"
import { createBackgroundWait } from "./create-background-wait"
import type { BackgroundOutputManager, BackgroundWaitResult } from "./types"
import type { BackgroundTask } from "../../features/background-agent"

function parseResult(result: string): BackgroundWaitResult {
  return JSON.parse(result) as BackgroundWaitResult
}

function createTask(overrides: Partial<BackgroundTask>): BackgroundTask {
  return {
    id: "bg-1",
    parentSessionID: "main-1",
    parentMessageID: "msg-1",
    description: "task",
    prompt: "prompt",
    agent: "explore",
    status: "running",
    ...overrides,
  }
}

describe("background_wait", () => {
  test("#given grouped task IDs #when block=false #then returns grouped structured status", async () => {
    // given
    const runningTask = createTask({ id: "bg-running", status: "running" })
    const completedTask = createTask({ id: "bg-done", status: "completed" })
    const manager: BackgroundOutputManager = {
      getTask: (taskID: string) => {
        if (taskID === runningTask.id) return runningTask
        if (taskID === completedTask.id) return completedTask
        return undefined
      },
    }
    const tool = createBackgroundWait(manager)

    // when
    const output = await tool.execute({
      task_ids: [runningTask.id, completedTask.id, "bg-missing"],
      block: false,
    }, {} as never)
    const parsed = parseResult(output)

    // then
    expect(parsed.summary.total).toBe(3)
    expect(parsed.summary.by_status.running).toBe(1)
    expect(parsed.summary.by_status.completed).toBe(1)
    expect(parsed.summary.by_status.not_found).toBe(1)
    expect(parsed.grouped.completed).toContain(completedTask.id)
    expect(parsed.grouped.not_found).toContain("bg-missing")
  })

  test("#given race mode #when block=true and one task reaches terminal #then returns quorum_reached", async () => {
    // given
    const task = createTask({ id: "bg-race", status: "running" })
    let readCount = 0
    const manager: BackgroundOutputManager = {
      getTask: (taskID: string) => {
        if (taskID !== task.id) return undefined
        readCount += 1
        if (readCount >= 2) {
          task.status = "completed"
        }
        return task
      },
    }
    const tool = createBackgroundWait(manager)

    // when
    const output = await tool.execute({
      task_ids: [task.id],
      mode: "any",
      block: true,
      timeout: 500,
      poll_interval: 20,
    }, {} as never)
    const parsed = parseResult(output)

    // then
    expect(parsed.done).toBe(true)
    expect(parsed.reason).toBe("quorum_reached")
    expect(parsed.quorum.target).toBe(1)
    expect(parsed.quorum.reached).toBe(1)
  })

  test("#given unmet quorum #when block=true until timeout #then returns timeout status", async () => {
    // given
    const runningTask = createTask({ id: "bg-still-running", status: "running" })
    const manager: BackgroundOutputManager = {
      getTask: (taskID: string) => (taskID === runningTask.id ? runningTask : undefined),
    }
    const tool = createBackgroundWait(manager)

    // when
    const output = await tool.execute({
      task_ids: [runningTask.id],
      quorum: 1,
      block: true,
      timeout: 120,
      poll_interval: 20,
    }, {} as never)
    const parsed = parseResult(output)

    // then
    expect(parsed.done).toBe(false)
    expect(parsed.reason).toBe("timeout")
    expect(parsed.summary.by_status.running).toBe(1)
    expect(parsed.quorum.reached).toBe(0)
  })
})
