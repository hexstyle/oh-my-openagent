import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createOrGetSession } from "./session-creator"
import { _resetForTesting, subagentSessions } from "../../features/claude-code-session-state"

describe("call-omo-agent createOrGetSession", () => {
  test("creates child session without overriding permission and tracks it as subagent session", async () => {
    // given
    _resetForTesting()

    const createCalls: Array<unknown> = []
    const ctx = {
      directory: "/project",
      client: {
        session: {
          get: async () => ({ data: { directory: "/parent" } }),
          create: async (args: unknown) => {
            createCalls.push(args)
            return { data: { id: "ses_child" } }
          },
        },
      },
    }

    const toolContext = {
      sessionID: "ses_parent",
      messageID: "msg_parent",
      agent: "sisyphus",
      abort: new AbortController().signal,
    }

    const args = {
      description: "test",
      prompt: "hello",
      subagent_type: "explore",
      run_in_background: true,
    }

    // when
    const result = await createOrGetSession(args as any, toolContext as any, ctx as any)

    // then
    expect(result).toEqual({ sessionID: "ses_child", isNew: true })
    expect(createCalls).toHaveLength(1)
    const createBody = (createCalls[0] as any)?.body
    expect(createBody?.parentID).toBe("ses_parent")
    expect(createBody?.title).toBe("test (@Explore (Code Search) subagent)")
    expect(createBody?.permission).toBeUndefined()
    expect(subagentSessions.has("ses_child")).toBe(true)
  })

  test("creates child session in active boulder worktree", async () => {
    _resetForTesting()

    const repoDirectory = join(tmpdir(), `call-omo-session-${crypto.randomUUID()}`)
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
    const ctx = {
      directory: repoDirectory,
      client: {
        session: {
          get: async () => ({ data: { directory: repoDirectory } }),
          create: async (args: Record<string, unknown>) => {
            createCalls.push(args)
            return { data: { id: "ses_child" } }
          },
        },
      },
    }

    const toolContext = {
      sessionID: "ses_parent",
      messageID: "msg_parent",
      agent: "sisyphus",
      abort: new AbortController().signal,
    }

    const args = {
      description: "test",
      prompt: "hello",
      subagent_type: "explore",
      run_in_background: true,
    }

    await createOrGetSession(args as any, toolContext as any, ctx as any)

    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]?.query).toEqual({ directory: worktreeDirectory })
  })
})
