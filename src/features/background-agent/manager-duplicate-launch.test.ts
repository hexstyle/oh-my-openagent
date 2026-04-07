/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { tmpdir } from "node:os"
import type { BackgroundTaskConfig } from "../../config/schema"
import { BackgroundManager } from "./manager"

function createManager(config?: BackgroundTaskConfig): BackgroundManager {
  let sessionCounter = 0

  const client = {
    session: {
      get: async () => ({ data: { directory: tmpdir() } }),
      create: async () => ({ data: { id: `ses_launch_${++sessionCounter}` } }),
      promptAsync: async () => ({}),
      prompt: async () => ({}),
      abort: async () => ({}),
      status: async () => ({ data: {} }),
    },
  }

  return new BackgroundManager({ client, directory: tmpdir() } as unknown as PluginInput, config)
}

describe("BackgroundManager duplicate launch guard", () => {
  test("blocks identical sibling launches under the same parent session", async () => {
    const manager = createManager()
    const input = {
      description: "Explore project structure",
      prompt: "Project structure: REPORT deviations only",
      agent: "explore",
      parentSessionID: "parent-1",
      parentMessageID: "msg-1",
    }

    await manager.launch(input)

    await expect(manager.launch(input)).rejects.toThrow(
      'already has 1 active identical task(s) for agent "explore" with description "Explore project structure"'
    )
  })

  test("allows sibling launches when the prompt meaningfully differs", async () => {
    const manager = createManager()

    const first = await manager.launch({
      description: "Explore project structure",
      prompt: "Project structure: REPORT deviations only",
      agent: "explore",
      parentSessionID: "parent-1",
      parentMessageID: "msg-1",
    })

    const second = await manager.launch({
      description: "Explore project structure",
      prompt: "Project structure: FIND monorepo boundaries and package ownership",
      agent: "explore",
      parentSessionID: "parent-1",
      parentMessageID: "msg-1",
    })

    expect(second.id).not.toBe(first.id)
  })
})
