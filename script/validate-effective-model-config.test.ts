import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { resolve } from "node:path"

import { getOpenCodeConfigDir } from "../src/shared/opencode-config-dir"
import {
  MODEL_REFRESH_PROCESS_LIST_COMMAND,
  isOpencodeModelRefreshCommand,
  parsePsProcessSnapshot,
  reapLingeringModelRefreshProcesses,
  refreshModelCatalog,
  resolveModelCatalogRefreshCwd,
} from "./validate-effective-model-config"

describe("validate-effective-model-config model catalog refresh", () => {
  test("uses wide ps output to avoid truncating refresh command suffixes", () => {
    expect(MODEL_REFRESH_PROCESS_LIST_COMMAND).toEqual([
      "/bin/ps",
      "-axww",
      "-o",
      "pid=,command=",
    ])
  })

  test("matches only model refresh commands when reaping stale processes", () => {
    expect(isOpencodeModelRefreshCommand("/opt/homebrew/bin/opencode models --refresh")).toBe(true)
    expect(isOpencodeModelRefreshCommand("/opt/homebrew/bin/opencode models opencode --refresh")).toBe(true)
    expect(isOpencodeModelRefreshCommand("/opt/homebrew/bin/opencode")).toBe(false)
    expect(isOpencodeModelRefreshCommand("/opt/homebrew/bin/opencode session list")).toBe(false)
  })

  test("parses ps output and kills only lingering model refresh commands", () => {
    const psOutput = [
      "123 /opt/homebrew/bin/opencode models --refresh",
      "456 /opt/homebrew/bin/opencode models opencode --refresh",
      "789 /opt/homebrew/bin/opencode",
      "999 bun run script/validate-effective-model-config.ts",
    ].join("\n")

    expect(parsePsProcessSnapshot(psOutput)).toEqual([
      { pid: 123, command: "/opt/homebrew/bin/opencode models --refresh" },
      { pid: 456, command: "/opt/homebrew/bin/opencode models opencode --refresh" },
      { pid: 789, command: "/opt/homebrew/bin/opencode" },
      { pid: 999, command: "bun run script/validate-effective-model-config.ts" },
    ])

    const killed: number[] = []
    const result = reapLingeringModelRefreshProcesses({
      currentPid: 999,
      listProcesses: () => psOutput,
      killPid: (pid) => {
        killed.push(pid)
      },
    })

    expect(result).toEqual([123, 456])
    expect(killed).toEqual([123, 456])
  })

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
    const calls: Array<{ command: string[]; cwd: string; timeout: number }> = []
    let reapCalls = 0

    const result = refreshModelCatalog({
      reapLingeringProcesses: () => {
        reapCalls += 1
        return []
      },
      spawnSync: (command, options) => {
        calls.push({ command, cwd: options.cwd, timeout: options.timeout })
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
    expect(calls.every((call) => call.timeout === 15000)).toBe(true)
    expect(reapCalls).toBe(1)
  })

  test("returns a warning instead of hanging forever when refresh times out", () => {
    let reapCalls = 0
    const result = refreshModelCatalog({
      timeoutMs: 1234,
      reapLingeringProcesses: () => {
        reapCalls += 1
        return []
      },
      spawnSync: (_command, _options) => ({
        exitCode: null,
        stdout: { toString: () => "" },
        stderr: { toString: () => "" },
        signal: "SIGTERM",
        error: Object.assign(new Error("spawnSync opencode ETIMEDOUT"), { code: "ETIMEDOUT" }),
      }),
    })

    expect(result.refreshed).toBe(false)
    if (result.refreshed) {
      throw new Error("Expected refresh warning")
    }
    expect(result.warning).toContain("timed out after 1234ms")
    expect(reapCalls).toBe(2)
  })
})
