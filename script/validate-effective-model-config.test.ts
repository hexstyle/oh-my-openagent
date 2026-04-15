import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { resolve } from "node:path"

import { getOpenCodeConfigDir } from "../src/shared/opencode-config-dir"
import {
  refreshModelCatalog,
  resolveModelCatalogRefreshCwd,
} from "./validate-effective-model-config"

describe("validate-effective-model-config model catalog refresh", () => {
  test("prefers the global OpenCode config dir instead of a project cwd", () => {
    const configDir = getOpenCodeConfigDir({ binary: "opencode" })
    const repoRoot = resolve(import.meta.dir, "..")

    expect(resolveModelCatalogRefreshCwd(configDir, homedir())).toBe(configDir)
    expect(resolveModelCatalogRefreshCwd(configDir, homedir())).not.toBe(repoRoot)
  })

  test("falls back to the home dir when no config dir is available", () => {
    expect(resolveModelCatalogRefreshCwd("", "/tmp/test-home")).toBe("/tmp/test-home")
  })

  test("runs both refresh commands from the neutral config cwd", () => {
    const configDir = getOpenCodeConfigDir({ binary: "opencode" })
    const calls: Array<{ command: string[]; cwd: string }> = []

    const result = refreshModelCatalog({
      spawnSync: (command, options) => {
        calls.push({ command, cwd: options.cwd })
        return {
          exitCode: 0,
          stdout: { toString: () => "" },
          stderr: { toString: () => "" },
        }
      },
    })

    expect(result).toEqual({ refreshed: true })
    expect(calls).toHaveLength(2)
    expect(calls.map((call) => call.command.join(" "))).toEqual([
      "opencode models --refresh",
      "opencode models opencode --refresh",
    ])
    expect(calls.every((call) => call.cwd === configDir)).toBe(true)
  })
})
