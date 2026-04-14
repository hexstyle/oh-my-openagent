import { describe, test, expect } from "bun:test"
import { tmpdir } from "node:os"
import type { PluginInput } from "@opencode-ai/plugin"
import { BackgroundManager } from "./manager"
import type { BackgroundTask } from "./types"

function createManagerWithStatus(statusImpl: () => Promise<{ data: Record<string, { type: string }> }>): BackgroundManager {
  const client = {
    session: {
      status: statusImpl,
      prompt: async () => ({}),
      promptAsync: async () => ({}),
      abort: async () => ({}),
      todo: async () => ({ data: [] }),
      messages: async () => ({ data: [] }),
    },
  }

  return new BackgroundManager({ client, directory: tmpdir() } as unknown as PluginInput)
}

describe("BackgroundManager polling overlap", () => {
  test("skips overlapping pollRunningTasks executions", async () => {
    //#given
    let activeCalls = 0
    let maxActiveCalls = 0
    let statusCallCount = 0
    let releaseStatus: (() => void) | undefined
    const statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve
    })

    const manager = createManagerWithStatus(async () => {
      statusCallCount += 1
      activeCalls += 1
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls)
      await statusGate
      activeCalls -= 1
      return { data: {} }
    })

    //#when
    const firstPoll = (manager as unknown as { pollRunningTasks: () => Promise<void> }).pollRunningTasks()
    await Promise.resolve()
    const secondPoll = (manager as unknown as { pollRunningTasks: () => Promise<void> }).pollRunningTasks()
    releaseStatus?.()
    await Promise.all([firstPoll, secondPoll])
    manager.shutdown()

    //#then
    expect(maxActiveCalls).toBe(1)
    expect(statusCallCount).toBe(1)
  })
})


function createRunningTask(sessionID: string): BackgroundTask {
  return {
    id: `bg_test_${sessionID}`,
    sessionID,
    parentSessionID: "parent-session",
    parentMessageID: "parent-msg",
    description: "test task",
    prompt: "test",
    agent: "explore",
    status: "running",
    startedAt: new Date(),
    progress: { toolCalls: 0, lastUpdate: new Date() },
  }
}

function injectTask(manager: BackgroundManager, task: BackgroundTask): void {
  const tasks = (manager as unknown as { tasks: Map<string, BackgroundTask> }).tasks
  tasks.set(task.id, task)
}

function createManagerWithClient(clientOverrides: Record<string, unknown> = {}): BackgroundManager {
  const client = {
    session: {
      status: async () => ({ data: {} }),
      get: async () => ({ data: { id: "existing-session" } }),
      prompt: async () => ({}),
      promptAsync: async () => ({}),
      abort: async () => ({}),
      todo: async () => ({ data: [] }),
      messages: async () => ({
        data: [{
          info: { role: "assistant", finish: "end_turn", id: "msg-2" },
          parts: [{ type: "text", text: "done" }],
        }, {
          info: { role: "user", id: "msg-1" },
          parts: [{ type: "text", text: "go" }],
        }],
      }),
      ...clientOverrides,
    },
  }
  return new BackgroundManager({ client, directory: tmpdir() } as unknown as PluginInput)
}

describe("BackgroundManager pollRunningTasks", () => {
  describe("#given a running task whose session is no longer in status response", () => {
    test("#when pollRunningTasks runs #then completes the task instead of leaving it running", async () => {
      //#given
      const manager = createManagerWithClient()
      const task = createRunningTask("ses-gone")
      injectTask(manager, task)

      //#when
      const poll = (manager as unknown as { pollRunningTasks: () => Promise<void> }).pollRunningTasks
      await poll.call(manager)
      manager.shutdown()

      //#then
      expect(task.status).toBe("completed")
      expect(task.completedAt).toBeDefined()
    })

    test("#when the missing session has no valid output and no longer exists #then fails it through the crashed-session path", async () => {
      //#given
      const manager = createManagerWithClient({
        get: async () => ({ data: undefined }),
        messages: async () => ({
          data: [{
            info: { role: "user", id: "msg-1" },
            parts: [{ type: "text", text: "go" }],
          }],
        }),
      })
      const task = createRunningTask("ses-crashed")
      injectTask(manager, task)

      //#when
      const poll = (manager as unknown as { pollRunningTasks: () => Promise<void> }).pollRunningTasks
      await poll.call(manager)
      manager.shutdown()

      //#then
      expect(task.status).toBe("error")
      expect(task.error).toBe("Subagent session no longer exists (process likely crashed). The session disappeared without producing any output.")
      expect(task.completedAt).toBeDefined()
    })
  })

  describe("#given a running task whose session status is idle", () => {
    test("#when pollRunningTasks runs #then completes the task", async () => {
      //#given
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-idle": { type: "idle" } } }),
      })
      const task = createRunningTask("ses-idle")
      injectTask(manager, task)

      //#when
      const poll = (manager as unknown as { pollRunningTasks: () => Promise<void> }).pollRunningTasks
      await poll.call(manager)
      manager.shutdown()

      //#then
      expect(task.status).toBe("completed")
    })

    test("#when idle session keeps incomplete todos after an error #then fails the task instead of waiting forever", async () => {
      //#given
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-idle-error": { type: "idle" } } }),
        todo: async () => ({ data: [{ id: "todo-1", content: "still pending", status: "pending", priority: "high" }] }),
      })
      const task = createRunningTask("ses-idle-error")
      task.error = "Unknown error"
      injectTask(manager, task)

      //#when
      const poll = (manager as unknown as { pollRunningTasks: () => Promise<void> }).pollRunningTasks
      await poll.call(manager)
      manager.shutdown()

      //#then
      expect(task.status).toBe("error")
      expect(task.error).toContain("Background task stopped with incomplete todos after an error")
      expect(task.completedAt).toBeDefined()
    })
  })

  describe("#given a running task whose session status is busy", () => {
    test("#when pollRunningTasks runs #then keeps the task running", async () => {
      //#given
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-busy": { type: "busy" } } }),
      })
      const task = createRunningTask("ses-busy")
      injectTask(manager, task)

      //#when
      const poll = (manager as unknown as { pollRunningTasks: () => Promise<void> }).pollRunningTasks
      await poll.call(manager)
      manager.shutdown()

      //#then
      expect(task.status).toBe("running")
    })
  })

  describe("#given a running task whose session has terminal non-idle status", () => {
    test('#when session status is "interrupted" #then completes the task', async () => {
      //#given
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-interrupted": { type: "interrupted" } } }),
      })
      const task = createRunningTask("ses-interrupted")
      injectTask(manager, task)

      //#when
      const poll = (manager as unknown as { pollRunningTasks: () => Promise<void> }).pollRunningTasks
      await poll.call(manager)
      manager.shutdown()

      //#then
      expect(task.status).toBe("completed")
      expect(task.completedAt).toBeDefined()
    })

    test('#when session status is "interrupted" after a loop-terminal error #then fails the task instead of completing it', async () => {
      //#given
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-loop-interrupted": { type: "interrupted" } } }),
      })
      const task = createRunningTask("ses-loop-interrupted")
      task.error = "Terminal internal continuation loop detected by runtime-fallback"
      injectTask(manager, task)

      //#when
      const poll = (manager as unknown as { pollRunningTasks: () => Promise<void> }).pollRunningTasks
      await poll.call(manager)
      manager.shutdown()

      //#then
      expect(task.status).toBe("error")
      expect(task.error).toContain("Terminal internal continuation loop")
      expect(task.completedAt).toBeDefined()
    })

    test('#when session status is an unknown type #then completes the task', async () => {
      //#given
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-unknown": { type: "some-weird-status" } } }),
      })
      const task = createRunningTask("ses-unknown")
      injectTask(manager, task)

      //#when
      const poll = (manager as unknown as { pollRunningTasks: () => Promise<void> }).pollRunningTasks
      await poll.call(manager)
      manager.shutdown()

      //#then
      expect(task.status).toBe("completed")
      expect(task.completedAt).toBeDefined()
    })
  })

  describe("#given a running task whose idle session never clears incomplete todos", () => {
    test("#when polling sees the same idle stall repeatedly #then fails after the fallback threshold", async () => {
      //#given
      const manager = createManagerWithClient({
        status: async () => ({ data: { "ses-idle-stall": { type: "idle" } } }),
        todo: async () => ({ data: [{ id: "todo-1", content: "still pending", status: "pending", priority: "high" }] }),
      })
      const task = createRunningTask("ses-idle-stall")
      injectTask(manager, task)

      //#when
      const poll = (manager as unknown as { pollRunningTasks: () => Promise<void> }).pollRunningTasks
      await poll.call(manager)
      expect(task.status).toBe("running")
      await poll.call(manager)
      expect(task.status).toBe("running")
      await poll.call(manager)
      manager.shutdown()

      //#then
      expect(task.status).toBe("error")
      expect(task.error).toBe("Background task stayed idle with incomplete todos and never resumed. Treating it as failed to avoid indefinite waiting.")
      expect(task.completedAt).toBeDefined()
    })
  })
})
