import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { createFallbackState } from "./fallback-state"
import { createLoopDetector } from "./internal-continuation-loop-detector"
import type { HookDeps } from "./types"

type SpawnCall = {
  pid: number
  args: unknown[]
}

const TEST_TMP_DIR = join(tmpdir(), `runtime-fallback-watchdog-${Date.now()}`)

function createDeps(): HookDeps {
  return {
    ctx: {
      directory: "/Users/redff00xx/proj/runtime-fallback-watchdog-repro",
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
      retry_on_errors: [408, 500, 502, 503, 504],
      max_fallback_attempts: 12,
      max_full_chain_cycles: 5,
      cooldown_seconds: 300,
      timeout_seconds: 60,
      transient_retry_window_seconds: 900,
      transient_retry_initial_delay_seconds: 10,
      transient_retry_max_delay_seconds: 300,
      notify_on_fallback: true,
    },
    options: {
      session_timeout_ms: 60_000,
    },
    pluginConfig: {
      fallback_models: ["openai/gpt-5.3-codex-spark"],
    } as HookDeps["pluginConfig"],
    loopDetector: createLoopDetector(),
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

describe("runtime fallback external watchdog process lifecycle", () => {
  let spawnCalls: SpawnCall[]
  let livePids: Set<number>
  let killSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    rmSync(TEST_TMP_DIR, { recursive: true, force: true })
    mkdirSync(TEST_TMP_DIR, { recursive: true })

    spawnCalls = []
    livePids = new Set()

    let nextPid = 40_000
    mock.module("node:os", () => ({
      tmpdir: () => TEST_TMP_DIR,
    }))
    mock.module("node:child_process", () => ({
      spawn: (...args: unknown[]) => {
        const pid = nextPid++
        livePids.add(pid)
        spawnCalls.push({ pid, args })
        return {
          pid,
          on: () => undefined,
          unref: () => undefined,
        }
      },
    }))

    killSpy = spyOn(process, "kill").mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (!livePids.has(pid)) {
        const error = new Error(`No such process: ${pid}`) as NodeJS.ErrnoException
        error.code = "ESRCH"
        throw error
      }

      if (signal === 0 || signal === undefined) {
        return true
      }

      livePids.delete(pid)
      return true
    }) as typeof process.kill)
  })

  afterEach(() => {
    killSpy.mockRestore()
    mock.restore()
    rmSync(TEST_TMP_DIR, { recursive: true, force: true })
  })

  it("kills the previous detached watchdog before re-arming after helper restart", async () => {
    const { createAutoRetryHelpers } = await import(`./auto-retry?external-watchdog-rearm-${Date.now()}-${Math.random()}`)
    const sessionID = "ses_external_watchdog_rearm"

    const deps = createDeps()
    deps.sessionStates.set(sessionID, createFallbackState("openai/gpt-5.4"))
    createAutoRetryHelpers(deps).scheduleSessionFallbackTimeout(sessionID, {
      resolvedAgent: "Atlas (Plan Executor)",
      source: "session.error",
    })

    expect(spawnCalls).toHaveLength(1)

    const depsAfterRestart = createDeps()
    depsAfterRestart.sessionStates.set(sessionID, createFallbackState("openai/gpt-5.4"))
    createAutoRetryHelpers(depsAfterRestart).scheduleSessionFallbackTimeout(sessionID, {
      resolvedAgent: "Atlas (Plan Executor)",
      source: "session.error.restart",
    })

    expect(spawnCalls).toHaveLength(2)
    expect(killSpy).toHaveBeenCalledWith(spawnCalls[0]?.pid, "SIGKILL")
    expect(livePids.has(spawnCalls[0]!.pid)).toBe(false)
    expect(livePids.has(spawnCalls[1]!.pid)).toBe(true)
  })

  it("clears the detached watchdog process immediately when the session timeout is cleared", async () => {
    const { createAutoRetryHelpers } = await import(`./auto-retry?external-watchdog-clear-${Date.now()}-${Math.random()}`)
    const sessionID = "ses_external_watchdog_clear"
    const pidFilePath = join(TEST_TMP_DIR, "oh-my-opencode-watchdogs", `${sessionID}.pid`)

    const deps = createDeps()
    deps.sessionStates.set(sessionID, createFallbackState("openai/gpt-5.4"))
    const helpers = createAutoRetryHelpers(deps)

    helpers.scheduleSessionFallbackTimeout(sessionID, {
      resolvedAgent: "Atlas (Plan Executor)",
      source: "session.error",
    })

    expect(spawnCalls).toHaveLength(1)
    expect(existsSync(pidFilePath)).toBe(true)
    expect(readFileSync(pidFilePath, "utf-8").trim()).toBe(String(spawnCalls[0]?.pid))

    helpers.clearSessionFallbackTimeout(sessionID)

    expect(killSpy).toHaveBeenCalledWith(spawnCalls[0]?.pid, "SIGKILL")
    expect(livePids.has(spawnCalls[0]!.pid)).toBe(false)
    expect(existsSync(pidFilePath)).toBe(false)
  })
})
