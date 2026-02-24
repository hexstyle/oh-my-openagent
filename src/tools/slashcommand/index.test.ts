/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as slashcommand from "./index"

const testRoots: string[] = []

function createTempRoot(): string {
  const root = join(tmpdir(), `slashcommand-discovery-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(root, { recursive: true })
  testRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of testRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  delete process.env.OPENCODE_CONFIG_DIR
})

describe("slashcommand module exports", () => {
  it("exports discovery API only", () => {
    // given
    const moduleExports = slashcommand as Record<string, unknown>

    // when
    const exportNames = Object.keys(moduleExports)

    // then
    expect(exportNames).toContain("discoverCommandsSync")
    expect(exportNames).not.toContain("createSlashcommandTool")
    expect(exportNames).not.toContain("slashcommand")
  })

  it("discovers commands from OpenCode plural command directories", () => {
    // given
    const root = createTempRoot()
    const opencodeConfigDir = join(root, "config")
    const globalCommandsDir = join(opencodeConfigDir, "commands")
    const projectCommandsDir = join(root, ".opencode", "commands")

    mkdirSync(globalCommandsDir, { recursive: true })
    mkdirSync(projectCommandsDir, { recursive: true })

    writeFileSync(
      join(globalCommandsDir, "global-cmd.md"),
      "---\ndescription: global command\n---\nGlobal command body"
    )
    writeFileSync(
      join(projectCommandsDir, "project-cmd.md"),
      "---\ndescription: project command\n---\nProject command body"
    )
    process.env.OPENCODE_CONFIG_DIR = opencodeConfigDir

    // when
    const commands = slashcommand.discoverCommandsSync(root)

    // then
    expect(commands.some((cmd) => cmd.name === "global-cmd" && cmd.scope === "opencode")).toBe(true)
    expect(commands.some((cmd) => cmd.name === "project-cmd" && cmd.scope === "opencode-project")).toBe(true)
  })
})
