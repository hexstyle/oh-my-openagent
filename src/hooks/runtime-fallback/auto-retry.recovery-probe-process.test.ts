import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import * as originalChildProcess from "node:child_process"
import * as originalOs from "node:os"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { createFallbackState } from "./fallback-state"
import type { HookDeps } from "./types"

const TEST_TMP_DIR = join(tmpdir(), `runtime-fallback-recovery-probe-process-${Date.now()}`)

function createDeps(): HookDeps {
  return {
    ctx: {
      directory: "/Users/redff00xx/proj/flare",
      client: {
        session: {
          abort: async () => undefined,
          messages: async () => ({
            data: [
              {
                info: { role: "user" },
                parts: [{ type: "text", text: "Continue the task." }],
              },
            ],
          }),
          promptAsync: async () => undefined,
        },
        tui: {
          showToast: async () => undefined,
        },
      },
    },
    config: {
      enabled: true,
      retry_on_errors: [402, 429, 500, 502, 503, 504],
      max_fallback_attempts: 12,
      max_full_chain_cycles: 5,
      cooldown_seconds: 300,
      timeout_seconds: 0,
      transient_retry_window_seconds: 900,
      transient_retry_initial_delay_seconds: 10,
      transient_retry_max_delay_seconds: 300,
      notify_on_fallback: true,
    },
    options: {},
    pluginConfig: {} as HookDeps["pluginConfig"],
    loopDetector: undefined,
    sessionStates: new Map(),
    sessionLastAccess: new Map(),
    sessionLastUserMessageIDs: new Map(),
    sessionRecentCompletionUntil: new Map(),
    sessionRetryInFlight: new Set(),
    sessionAwaitingFallbackResult: new Set(),
    sessionFallbackTimeouts: new Map(),
    sessionTransientRetryTimeouts: new Map(),
    sessionStatusRetryKeys: new Map(),
  }
}

describe("runtime fallback recovery probe process isolation", () => {
  let spawnCalls: Array<{ args: unknown[]; options: Record<string, unknown> | undefined }>

  beforeEach(() => {
    rmSync(TEST_TMP_DIR, { recursive: true, force: true })
    mkdirSync(TEST_TMP_DIR, { recursive: true })
    spawnCalls = []

    mock.module("node:os", () => ({
      ...originalOs,
      tmpdir: () => TEST_TMP_DIR,
    }))
    mock.module("node:child_process", () => ({
      ...originalChildProcess,
      spawn: (...args: unknown[]) => {
        const options = (args[2] ?? undefined) as Record<string, unknown> | undefined
        spawnCalls.push({ args, options })
        return {
          stdout: {
            on: (event: string, callback: (chunk: string) => void) => {
              if (event === "data") {
                setTimeout(() => callback("OK\n"), 0)
              }
            },
          },
          stderr: {
            on: () => undefined,
          },
          on: (event: string, callback: (code?: number) => void) => {
            if (event === "close") {
              setTimeout(() => callback(0), 0)
            }
          },
          kill: () => true,
        }
      },
    }))
  })

  afterEach(() => {
    mock.restore()
    rmSync(TEST_TMP_DIR, { recursive: true, force: true })
  })

  it("runs flare/data_catalog recovery probes outside the project and with runtime fallback disabled", async () => {
    const { createAutoRetryHelpers } = await import(`./auto-retry?recovery-probe-process-${Date.now()}-${Math.random()}`)
    const sessionID = "ses_recovery_probe_process"
    const deps = createDeps()
    const state = createFallbackState("anthropic/claude-opus-4-6", [
      "openai/gpt-5.3-codex-spark",
      "opencode/big-pickle",
    ])

    state.currentModel = "opencode/big-pickle"
    state.fallbackIndex = 1
    state.failedModels.set("anthropic/claude-opus-4-6", Date.now())
    state.failedModels.set("openai/gpt-5.3-codex-spark", Date.now())
    deps.sessionStates.set(sessionID, state)

    const helpers = createAutoRetryHelpers(deps)
    await helpers.recoverPreferredModels()

    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0]?.args[0]).toBe("opencode")

    const cliArgs = spawnCalls[0]?.args[1] as string[]
    const probeDir = cliArgs[cliArgs.indexOf("--dir") + 1]
    expect(probeDir).not.toBe(deps.ctx.directory)
    expect(probeDir.startsWith(TEST_TMP_DIR)).toBe(true)

    const env = spawnCalls[0]?.options?.env as Record<string, string | undefined> | undefined
    expect(env?.OH_MY_OPENCODE_DISABLE_RUNTIME_FALLBACK).toBe("1")
  })
})
