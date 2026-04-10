import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { PluginInput } from "@opencode-ai/plugin"

import { BackgroundManager } from "./manager"

describe("BackgroundManager session permission", () => {
  test("passes explicit session permission rules to child session creation", async () => {
    // given
    const createCalls: Array<Record<string, unknown>> = []
    const client = {
      session: {
        get: async () => ({ data: { directory: "/parent" } }),
        create: async (input: Record<string, unknown>) => {
          createCalls.push(input)
          return { data: { id: "ses_child" } }
        },
        promptAsync: async () => ({}),
        abort: async () => ({}),
      },
    }
    const manager = new BackgroundManager({ client, directory: tmpdir() } as unknown as PluginInput)

    // when
    await manager.launch({
      description: "Test task",
      prompt: "Do something",
      agent: "explore",
      parentSessionID: "ses_parent",
      parentMessageID: "msg_parent",
      sessionPermission: [
        { permission: "question", action: "deny", pattern: "*" },
      ],
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    manager.shutdown()

    // then
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]?.body).toEqual({
      parentID: "ses_parent",
      title: "Test task (@Explore (Code Search) subagent)",
      permission: [
        { permission: "question", action: "deny", pattern: "*" },
      ],
    })
  })

  test("creates child session inside active boulder worktree instead of parent checkout", async () => {
    // given
    const repoDirectory = join(tmpdir(), `bg-manager-worktree-${crypto.randomUUID()}`)
    const worktreeDirectory = join(repoDirectory, "hotfix-worktree")
    mkdirSync(join(repoDirectory, ".sisyphus"), { recursive: true })
    mkdirSync(worktreeDirectory, { recursive: true })
    writeFileSync(join(repoDirectory, ".sisyphus", "boulder.json"), JSON.stringify({
      active_plan: join(worktreeDirectory, ".sisyphus", "plans", "feature.md"),
      started_at: "2026-04-10T00:00:00.000Z",
      session_ids: ["ses_parent"],
      plan_name: "feature",
      worktree_path: worktreeDirectory,
    }))

    const createCalls: Array<Record<string, unknown>> = []
    const client = {
      session: {
        get: async () => ({ data: { directory: repoDirectory } }),
        create: async (input: Record<string, unknown>) => {
          createCalls.push(input)
          return { data: { id: "ses_child" } }
        },
        promptAsync: async () => ({}),
        abort: async () => ({}),
      },
    }
    const manager = new BackgroundManager({ client, directory: repoDirectory } as unknown as PluginInput)

    // when
    await manager.launch({
      description: "Test task",
      prompt: "Do something",
      agent: "explore",
      parentSessionID: "ses_parent",
      parentMessageID: "msg_parent",
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    manager.shutdown()

    // then
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]?.query).toEqual({ directory: worktreeDirectory })
  })
})
