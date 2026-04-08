import { describe, test, expect } from "bun:test"
import { tmpdir } from "node:os"
import type { PluginInput } from "@opencode-ai/plugin"
import { BackgroundManager } from "./manager"
import type { BackgroundTask, LaunchInput } from "./types"

describe("BackgroundManager execution agent normalization", () => {
  test("startTask uses the runtime key for the reserved explore display name", async () => {
    //#given
    let promptCall: { path: { id: string }; body: Record<string, unknown> } | undefined
    const client = {
      session: {
        get: async () => ({ data: { directory: "/test/dir" } }),
        create: async () => ({ data: { id: "session-1" } }),
        promptAsync: async (args: { path: { id: string }; body: Record<string, unknown> }) => {
          promptCall = args
          return {}
        },
      },
    }
    const manager = new BackgroundManager({ client, directory: tmpdir() } as unknown as PluginInput)
    const task: BackgroundTask = {
      id: "task-1",
      status: "pending",
      queuedAt: new Date(),
      description: "test task",
      prompt: "test prompt",
      agent: "Explore (Code Search)",
      parentSessionID: "parent-session",
      parentMessageID: "parent-message",
    }
    const input: LaunchInput = {
      description: task.description,
      prompt: task.prompt,
      agent: task.agent,
      parentSessionID: task.parentSessionID,
      parentMessageID: task.parentMessageID,
    }

    //#when
    await (manager as unknown as {
      startTask: (item: { task: BackgroundTask; input: LaunchInput }) => Promise<void>
    }).startTask({ task, input })

    //#then
    expect(promptCall?.body.agent).toBe("explore")
    expect((promptCall?.body.tools as Record<string, unknown>)?.call_omo_agent).toBe(false)
    expect((promptCall?.body.tools as Record<string, unknown>)?.task).toBe(false)
    expect((promptCall?.body.tools as Record<string, unknown>)?.write).toBe(false)
    expect((promptCall?.body.tools as Record<string, unknown>)?.edit).toBe(false)

    manager.shutdown()
  })

  test("resume uses the runtime key for the reserved explore display name", async () => {
    //#given
    let promptCall: { path: { id: string }; body: Record<string, unknown> } | undefined
    const client = {
      session: {
        promptAsync: async (args: { path: { id: string }; body: Record<string, unknown> }) => {
          promptCall = args
          return {}
        },
        abort: async () => ({}),
      },
    }
    const manager = new BackgroundManager({ client, directory: tmpdir() } as unknown as PluginInput)
    const task: BackgroundTask = {
      id: "task-2",
      sessionID: "session-2",
      parentSessionID: "parent-session",
      parentMessageID: "parent-message",
      description: "resume task",
      prompt: "resume prompt",
      agent: "Explore (Code Search)",
      status: "completed",
      startedAt: new Date(),
      completedAt: new Date(),
    }
    ;((manager as unknown as { tasks: Map<string, BackgroundTask> }).tasks).set(task.id, task)

    //#when
    await manager.resume({
      sessionId: "session-2",
      prompt: "continue",
      parentSessionID: "parent-session",
      parentMessageID: "parent-message",
    })

    //#then
    expect(promptCall?.body.agent).toBe("explore")
    expect((promptCall?.body.tools as Record<string, unknown>)?.call_omo_agent).toBe(false)
    expect((promptCall?.body.tools as Record<string, unknown>)?.task).toBe(false)
    expect((promptCall?.body.tools as Record<string, unknown>)?.write).toBe(false)
    expect((promptCall?.body.tools as Record<string, unknown>)?.edit).toBe(false)

    manager.shutdown()
  })
})
