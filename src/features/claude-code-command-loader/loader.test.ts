/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadOpencodeGlobalCommands, loadOpencodeProjectCommands } from "./loader"

const testRoots: string[] = []

function createTempRoot(): string {
  const root = join(tmpdir(), `command-loader-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(root, { recursive: true })
  testRoots.push(root)
  return root
}

function writeCommand(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${name}.md`),
    "---\ndescription: command from test\n---\nUse this command"
  )
}

afterEach(() => {
  for (const root of testRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  delete process.env.OPENCODE_CONFIG_DIR
})

describe("claude-code-command-loader OpenCode paths", () => {
  it("loads commands from global OpenCode commands directory", async () => {
    // given
    const root = createTempRoot()
    const opencodeConfigDir = join(root, "config")
    writeCommand(join(opencodeConfigDir, "commands"), "global-opencode")
    process.env.OPENCODE_CONFIG_DIR = opencodeConfigDir

    // when
    const commands = await loadOpencodeGlobalCommands()

    // then
    expect(commands["global-opencode"]).toBeDefined()
  })

  it("loads commands from project OpenCode commands directory", async () => {
    // given
    const root = createTempRoot()
    writeCommand(join(root, ".opencode", "commands"), "project-opencode")

    // when
    const commands = await loadOpencodeProjectCommands(root)

    // then
    expect(commands["project-opencode"]).toBeDefined()
  })
})
