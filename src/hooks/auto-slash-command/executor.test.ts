/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executeSlashCommand } from "./executor"

const testRoots: string[] = []

function createTempRoot(): string {
  const root = join(tmpdir(), `auto-slash-executor-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(root, { recursive: true })
  testRoots.push(root)
  return root
}

function writeCommand(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${name}.md`),
    "---\ndescription: command from test\n---\nRun from OpenCode command directory"
  )
}

afterEach(() => {
  for (const root of testRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  delete process.env.OPENCODE_CONFIG_DIR
})

describe("auto-slash-command executor OpenCode paths", () => {
  it("resolves commands from OpenCode global and project plural directories", async () => {
    // given
    const root = createTempRoot()
    const opencodeConfigDir = join(root, "config")
    writeCommand(join(opencodeConfigDir, "commands"), "global-cmd")
    writeCommand(join(root, ".opencode", "commands"), "project-cmd")
    process.env.OPENCODE_CONFIG_DIR = opencodeConfigDir

    const originalCwd = process.cwd()
    process.chdir(root)

    try {
      // when
      const globalResult = await executeSlashCommand(
        { command: "global-cmd", args: "", raw: "/global-cmd" },
        { skills: [] }
      )
      const projectResult = await executeSlashCommand(
        { command: "project-cmd", args: "", raw: "/project-cmd" },
        { skills: [] }
      )

      // then
      expect(globalResult.success).toBe(true)
      expect(projectResult.success).toBe(true)
    } finally {
      process.chdir(originalCwd)
    }
  })
})
