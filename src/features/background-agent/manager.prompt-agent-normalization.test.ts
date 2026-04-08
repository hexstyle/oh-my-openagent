import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import type { PluginInput } from "@opencode-ai/plugin"

import { BackgroundManager } from "./manager"
import type { BackgroundTask } from "./types"

describe("BackgroundManager prompt agent normalization", () => {
  test("uses the explore runtime key when notifying a parent session", async () => {
    let capturedBody: Record<string, unknown> | undefined

    const client = {
      session: {
        prompt: async () => ({}),
        promptAsync: async (args: { body: Record<string, unknown> }) => {
          capturedBody = args.body
          return {}
        },
        abort: async () => ({}),
        messages: async () => ({ data: [] }),
      },
    }

    const manager = new BackgroundManager({ client, directory: tmpdir() } as unknown as PluginInput)
    const task: BackgroundTask = {
      id: "task-explore-parent",
      sessionID: "session-child",
      parentSessionID: "session-parent",
      parentMessageID: "msg-parent",
      description: "task explore parent",
      prompt: "test",
      agent: "sisyphus-junior",
      status: "completed",
      startedAt: new Date(),
      completedAt: new Date(),
      parentAgent: "Explore (Code Search)",
    }

    ;(manager as unknown as {
      pendingByParent: Map<string, Set<string>>
    }).pendingByParent.set("session-parent", new Set([task.id]))

    await (manager as unknown as {
      notifyParentSession: (value: BackgroundTask) => Promise<void>
    }).notifyParentSession(task)

    expect(capturedBody?.agent).toBe("explore")

    manager.shutdown()
  })
})
