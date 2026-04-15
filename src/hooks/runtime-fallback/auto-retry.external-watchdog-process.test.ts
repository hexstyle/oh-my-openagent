import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { createFallbackState } from "./fallback-state"
import { createLoopDetector } from "./internal-continuation-loop-detector"
import type { HookDeps } from "./types"
import { FALLBACK_CONTINUATION_PROMPT } from "./constants"
import { OMO_INTERNAL_INITIATOR_MARKER } from "../../shared/internal-initiator-marker"

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
        _client: {
          getConfig: () => ({ baseUrl: "http://127.0.0.1:44682" }),
        },
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

  it("does not arm an external watchdog while parent background tasks are active", async () => {
    const { createAutoRetryHelpers } = await import(`./auto-retry?external-watchdog-background-${Date.now()}-${Math.random()}`)
    const sessionID = "ses_external_watchdog_background"

    const deps = createDeps()
    deps.options = {
      ...deps.options,
      backgroundManager: {
        getTasksByParentSession: () => [{
          id: "bg-1",
          parentSessionID: sessionID,
          parentMessageID: "msg-1",
          description: "background work",
          prompt: "background work",
          agent: "Sisyphus Junior (Focused Executor)",
          status: "running",
        }],
      },
    }
    deps.sessionStates.set(sessionID, createFallbackState("openai/gpt-5.4"))

    createAutoRetryHelpers(deps).scheduleSessionFallbackTimeout(sessionID, {
      resolvedAgent: "Atlas (Plan Executor)",
      source: "message.part.updated.progress",
    })

    expect(spawnCalls).toHaveLength(0)
  })

  it("spawns the external watchdog with an internal continuation prompt instead of the raw watchdog text", async () => {
    const { createAutoRetryHelpers } = await import(`./auto-retry?external-watchdog-internal-prompt-${Date.now()}-${Math.random()}`)
    const sessionID = "ses_external_watchdog_internal_prompt"

    const deps = createDeps()
    deps.sessionStates.set(sessionID, createFallbackState("openai/gpt-5.4"))

    createAutoRetryHelpers(deps).scheduleSessionFallbackTimeout(sessionID, {
      resolvedAgent: "Atlas (Plan Executor)",
      source: "session.error",
    })

    expect(spawnCalls).toHaveLength(1)

    const command = spawnCalls[0]?.args[0]
    const childArgs = spawnCalls[0]?.args[1] as string[] | undefined
    const promptArg = childArgs?.[10] ?? ""

    expect(command).toBe("bun")
    expect(childArgs?.[0]).toContain("script/runtime-fallback-external-watchdog.ts")
    expect(childArgs?.[6]).toBe("http://127.0.0.1:44682")
    expect(promptArg).toContain(FALLBACK_CONTINUATION_PROMPT)
    expect(promptArg).toContain(OMO_INTERNAL_INITIATOR_MARKER)
    expect(promptArg).not.toContain("Continue the current task from where you left off.")
  })

  it("spawns the external watchdog on the next distinct fallback model for a stalled primary Anthropic turn", async () => {
    const { createAutoRetryHelpers } = await import(`./auto-retry?external-watchdog-next-fallback-${Date.now()}-${Math.random()}`)
    const sessionID = "ses_external_watchdog_next_fallback"

    const deps = createDeps()
    deps.pluginConfig = {
      agents: {
        prometheus: {
          model: "anthropic/claude-opus-4-6",
          fallback_models: [
            "anthropic/claude-opus-4-6",
            "openai/gpt-5.4",
            "openai/gpt-5.3-codex-spark",
          ],
        },
      },
    } as HookDeps["pluginConfig"]
    deps.sessionStates.set(sessionID, createFallbackState("anthropic/claude-opus-4-6"))

    createAutoRetryHelpers(deps).scheduleSessionFallbackTimeout(sessionID, {
      resolvedAgent: "prometheus",
      source: "message.updated.user",
    })

    expect(spawnCalls).toHaveLength(1)

    const command = spawnCalls[0]?.args[0]
    const childArgs = spawnCalls[0]?.args[1] as string[] | undefined
    expect(command).toBe("bun")
    expect(childArgs?.[7]).toBe("openai/gpt-5.4")
    expect(childArgs?.[9]).toBe("")
  })
})
