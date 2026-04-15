import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { tmpdir } from "node:os"

import { BackgroundManager } from "./manager"
import type { BackgroundTask } from "./types"

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function createTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "task-1",
    sessionID: "ses-task-1",
    parentSessionID: "parent-session",
    parentMessageID: "parent-message",
    description: "inspect files",
    prompt: "inspect files",
    agent: "explore",
    status: "error",
    startedAt: new Date(Date.now() - 1_000),
    completedAt: new Date(),
    error: "Unknown error",
    ...overrides,
  }
}

function createManagerWithPromptSpy() {
  const promptAsync = mock(async () => ({}))
  const client = {
    session: {
      promptAsync,
      messages: async () => ({ data: [] }),
      abort: async () => ({}),
      status: async () => ({ data: {} }),
      todo: async () => ({ data: [] }),
    },
  }

  const manager = new BackgroundManager({ client, directory: tmpdir() } as unknown as PluginInput)

  return {
    manager,
    promptAsync,
  }
}

describe("BackgroundManager failure notifications", () => {
  let dateNowSpy: ReturnType<typeof spyOn> | undefined
  let now = 100_000

  beforeEach(() => {
    now = 100_000
    dateNowSpy = spyOn(Date, "now").mockImplementation(() => now)
  })

  afterEach(() => {
    dateNowSpy?.mockRestore()
  })

  it("reports active background tasks in chat with counts, statuses, and durations", async () => {
    const { manager, promptAsync } = createManagerWithPromptSpy()
    const runningTask = createTask({
      id: "task-running",
      status: "running",
      startedAt: new Date(Date.now() - 5_000),
      completedAt: undefined,
      error: undefined,
    })
    const pendingTask = createTask({
      id: "task-pending",
      status: "pending",
      queuedAt: new Date(Date.now() - 2_000),
      startedAt: undefined,
      completedAt: undefined,
      error: undefined,
    })

    const taskMap = (manager as unknown as { tasks: Map<string, BackgroundTask> }).tasks
    taskMap.set(runningTask.id, runningTask)
    taskMap.set(pendingTask.id, pendingTask)

    await (manager as unknown as { maybeNotifyParentActiveTasks: (parentSessionID: string, force?: boolean) => Promise<void> })
      .maybeNotifyParentActiveTasks(runningTask.parentSessionID, true)

    expect(promptAsync).toHaveBeenCalledTimes(1)

    const firstCall = (promptAsync.mock.calls as Array<Array<{ body: { noReply: boolean; parts: Array<{ text: string }> } }>>)[0]
    expect(firstCall).toBeDefined()
    const promptBody = firstCall![0].body
    expect(promptBody.noReply).toBe(true)
    expect(promptBody.parts[0].text).toContain("[BACKGROUND TASK STATUS]")
    expect(promptBody.parts[0].text).toContain("**Active background tasks:** 2")
    expect(promptBody.parts[0].text).toContain("**Summary:** 1 running, 1 pending")
    expect(promptBody.parts[0].text).toContain("task-running")
    expect(promptBody.parts[0].text).toContain("task-pending")
    expect(promptBody.parts[0].text).toContain("running")
    expect(promptBody.parts[0].text).toContain("queued")

    await manager.shutdown()
  })

  it("suppresses duplicate active-task chat updates within the throttle window", async () => {
    const { manager, promptAsync } = createManagerWithPromptSpy()
    const runningTask = createTask({
      id: "task-running",
      status: "running",
      startedAt: new Date(Date.now() - 5_000),
      completedAt: undefined,
      error: undefined,
    })

    const taskMap = (manager as unknown as { tasks: Map<string, BackgroundTask> }).tasks
    taskMap.set(runningTask.id, runningTask)

    const maybeNotify = (manager as unknown as {
      maybeNotifyParentActiveTasks: (parentSessionID: string, force?: boolean) => Promise<void>
    }).maybeNotifyParentActiveTasks

    await maybeNotify.call(manager, runningTask.parentSessionID, true)
    await maybeNotify.call(manager, runningTask.parentSessionID)

    expect(promptAsync).toHaveBeenCalledTimes(1)

    await manager.shutdown()
  })

  it("keeps duplicate active-task chat updates suppressed until a full minute has passed", async () => {
    const { manager, promptAsync } = createManagerWithPromptSpy()
    const runningTask = createTask({
      id: "task-running-minute-throttle",
      status: "running",
      startedAt: new Date(now - 5_000),
      completedAt: undefined,
      error: undefined,
    })

    const taskMap = (manager as unknown as { tasks: Map<string, BackgroundTask> }).tasks
    taskMap.set(runningTask.id, runningTask)

    const maybeNotify = (manager as unknown as {
      maybeNotifyParentActiveTasks: (parentSessionID: string, force?: boolean) => Promise<void>
    }).maybeNotifyParentActiveTasks

    await maybeNotify.call(manager, runningTask.parentSessionID, true)
    now += 20_000
    await maybeNotify.call(manager, runningTask.parentSessionID)
    now += 39_000
    await maybeNotify.call(manager, runningTask.parentSessionID)

    expect(promptAsync).toHaveBeenCalledTimes(1)

    now += 1_000
    await maybeNotify.call(manager, runningTask.parentSessionID)

    expect(promptAsync).toHaveBeenCalledTimes(2)

    await manager.shutdown()
  })

  it("coalesces burst active-task status updates into a single follow-up snapshot", async () => {
    const { manager, promptAsync } = createManagerWithPromptSpy()
    const firstTask = createTask({
      id: "task-one",
      status: "running",
      startedAt: new Date(now - 5_000),
      completedAt: undefined,
      error: undefined,
    })
    const secondTask = createTask({
      id: "task-two",
      sessionID: "ses-task-2",
      status: "pending",
      queuedAt: new Date(now),
      startedAt: undefined,
      completedAt: undefined,
      error: undefined,
    })
    const thirdTask = createTask({
      id: "task-three",
      sessionID: "ses-task-3",
      status: "pending",
      queuedAt: new Date(now),
      startedAt: undefined,
      completedAt: undefined,
      error: undefined,
    })

    const taskMap = (manager as unknown as { tasks: Map<string, BackgroundTask> }).tasks
    taskMap.set(firstTask.id, firstTask)

    const maybeNotify = (manager as unknown as {
      maybeNotifyParentActiveTasks: (parentSessionID: string, force?: boolean) => Promise<void>
    }).maybeNotifyParentActiveTasks

    await maybeNotify.call(manager, firstTask.parentSessionID, true)
    expect(promptAsync).toHaveBeenCalledTimes(1)

    taskMap.set(secondTask.id, secondTask)
    await maybeNotify.call(manager, firstTask.parentSessionID, true)
    secondTask.status = "running"
    secondTask.startedAt = new Date(now)
    await maybeNotify.call(manager, firstTask.parentSessionID, true)
    taskMap.set(thirdTask.id, thirdTask)
    await maybeNotify.call(manager, firstTask.parentSessionID, true)

    expect(promptAsync).toHaveBeenCalledTimes(1)

    await wait(650)

    expect(promptAsync).toHaveBeenCalledTimes(2)

    const secondCall = (promptAsync.mock.calls as Array<Array<{ body: { parts: Array<{ text: string }> } }>>)[1]
    expect(secondCall).toBeDefined()
    const promptText = secondCall![0].body.parts[0].text
    expect(promptText).toContain("**Active background tasks:** 3")
    expect(promptText).toContain("**Summary:** 2 running, 1 pending")

    await manager.shutdown()
  })

  it("wakes the parent with an autonomous failure handoff when a background task fails before all siblings finish", async () => {
    const { manager, promptAsync } = createManagerWithPromptSpy()
    const failedTask = createTask({ id: "task-failed" })
    const runningSibling = createTask({ id: "task-running", sessionID: "ses-task-2", status: "running", completedAt: undefined, error: undefined })

    const taskMap = (manager as unknown as { tasks: Map<string, BackgroundTask> }).tasks
    taskMap.set(failedTask.id, failedTask)
    taskMap.set(runningSibling.id, runningSibling)

    const pendingByParent = (manager as unknown as { pendingByParent: Map<string, Set<string>> }).pendingByParent
    pendingByParent.set(failedTask.parentSessionID, new Set([failedTask.id, runningSibling.id]))

    await (manager as unknown as { notifyParentSession: (task: BackgroundTask) => Promise<void> }).notifyParentSession(failedTask)

    expect(promptAsync).toHaveBeenCalledTimes(1)

    const firstCall = (promptAsync.mock.calls as Array<Array<{ body: { noReply: boolean; parts: Array<{ text: string }> } }>>)[0]
    expect(firstCall).toBeDefined()
    const promptBody = firstCall![0].body
    expect(promptBody.noReply).toBe(false)
    expect(promptBody.parts[0].text).toContain("AUTONOMOUS FAILURE HANDOFF")
    expect(promptBody.parts[0].text).toContain("Analyze the failure details below, adapt the plan or retry strategy, and continue autonomously.")
    expect(promptBody.parts[0].text).toContain("There is still 1 other background task in progress.")
    expect(promptBody.parts[0].text).toContain("task-failed")
    expect(promptBody.parts[0].text).toContain("Unknown error")

    await manager.shutdown()
  })

  it("includes loop-terminal failure context in the parent handoff for interrupted sessions", async () => {
    const { manager, promptAsync } = createManagerWithPromptSpy()
    const failedTask = createTask({
      id: "task-loop-terminal",
      sessionID: "ses-loop-terminal",
      error: "Terminal internal continuation loop detected by runtime-fallback",
    })

    const taskMap = (manager as unknown as { tasks: Map<string, BackgroundTask> }).tasks
    taskMap.set(failedTask.id, failedTask)

    const pendingByParent = (manager as unknown as { pendingByParent: Map<string, Set<string>> }).pendingByParent
    pendingByParent.set(failedTask.parentSessionID, new Set([failedTask.id]))

    await (manager as unknown as { notifyParentSession: (task: BackgroundTask) => Promise<void> }).notifyParentSession(failedTask)

    expect(promptAsync).toHaveBeenCalledTimes(1)

    const firstCall = (promptAsync.mock.calls as Array<Array<{ body: { noReply: boolean; parts: Array<{ text: string }> } }>>)[0]
    expect(firstCall).toBeDefined()
    const promptBody = firstCall![0].body
    expect(promptBody.noReply).toBe(false)
    expect(promptBody.parts[0].text).toContain("AUTONOMOUS FAILURE HANDOFF")
    expect(promptBody.parts[0].text).toContain("task-loop-terminal")
    expect(promptBody.parts[0].text).toContain("Terminal internal continuation loop detected by runtime-fallback")

    await manager.shutdown()
  })
})
