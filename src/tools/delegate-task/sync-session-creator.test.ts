import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSyncSession } from "./sync-session-creator"

describe("createSyncSession", () => {
  test("creates child session with question permission denied", async () => {
    // given
    const createCalls: Array<Record<string, unknown>> = []
    const client = {
      session: {
        get: async () => ({ data: { directory: "/parent" } }),
        create: async (input: Record<string, unknown>) => {
          createCalls.push(input)
          return { data: { id: "ses_child" } }
        },
      },
    }

    // when
    const result = await createSyncSession(client as never, {
      parentSessionID: "ses_parent",
      agentToUse: "explore",
      description: "test task",
      defaultDirectory: "/fallback",
    })

    // then
    expect(result).toEqual({ ok: true, sessionID: "ses_child", parentDirectory: "/parent" })
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]?.body).toEqual({
      parentID: "ses_parent",
      title: "test task (@Explore (Code Search) subagent)",
      permission: [
        { permission: "question", action: "deny", pattern: "*" },
      ],
    })
  })

  test("uses active boulder worktree for sync child session creation", async () => {
    const repoDirectory = join(tmpdir(), `sync-session-worktree-${crypto.randomUUID()}`)
    const worktreeDirectory = join(repoDirectory, "feature-worktree")
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
      },
    }

    const result = await createSyncSession(client as never, {
      parentSessionID: "ses_parent",
      agentToUse: "explore",
      description: "test task",
      defaultDirectory: repoDirectory,
    })

    expect(result).toEqual({ ok: true, sessionID: "ses_child", parentDirectory: worktreeDirectory })
    expect(createCalls[0]?.query).toEqual({ directory: worktreeDirectory })
  })
})
