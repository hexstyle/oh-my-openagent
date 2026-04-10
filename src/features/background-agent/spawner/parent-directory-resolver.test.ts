import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { resolveParentDirectory } from "./parent-directory-resolver"

describe("background-agent parent-directory-resolver", () => {
  const originalPlatform = process.platform

  test("uses current working directory on Windows when parent session directory is AppData", async () => {
    //#given
    Object.defineProperty(process, "platform", { value: "win32" })
    try {
      const client = {
        session: {
          get: async () => ({
            data: { directory: "C:\\Users\\test\\AppData\\Local\\ai.opencode.desktop" },
          }),
        },
      }

      //#when
      const result = await resolveParentDirectory({
        client: client as Parameters<typeof resolveParentDirectory>[0]["client"],
        parentSessionID: "ses_parent",
        defaultDirectory: "C:\\Users\\test\\AppData\\Roaming\\opencode",
      })

      //#then
      expect(result).toBe(process.cwd())
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform })
    }
  })

  test("prefers active boulder worktree over parent session directory", async () => {
    //#given
    const repoDirectory = join(tmpdir(), `parent-dir-worktree-${crypto.randomUUID()}`)
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

    const client = {
      session: {
        get: async () => ({
          data: { directory: repoDirectory },
        }),
      },
    }

    //#when
    const result = await resolveParentDirectory({
      client: client as Parameters<typeof resolveParentDirectory>[0]["client"],
      parentSessionID: "ses_parent",
      defaultDirectory: repoDirectory,
    })

    //#then
    expect(result).toBe(worktreeDirectory)
  })
})
