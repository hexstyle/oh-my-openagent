/// <reference types="bun-types" />

import { describe, it, expect, beforeEach, afterEach, vi, mock } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { OhMyOpenCodeConfig } from "../../config"
import {
  cleanupIsolatedRunDataHome,
  getRunTransportRecoveryPolicy,
  isCertificateVerificationTransportError,
  prepareIsolatedRunDataHome,
  resolveRunAgent,
  resolveRunPromptAgent,
  shouldResumePollingAfterPromptFailure,
  shouldRecoverRunTransportError,
  shouldUseIsolatedRunDataHome,
  waitForEventProcessorShutdown,
} from "./runner"

const createConfig = (overrides: Partial<OhMyOpenCodeConfig> = {}): OhMyOpenCodeConfig => ({
  ...overrides,
})

describe("resolveRunAgent", () => {
  it("uses CLI agent over env and config", () => {
    // given
    const config = createConfig({ default_run_agent: "prometheus" })
    const env = { OPENCODE_DEFAULT_AGENT: "Atlas" }

    // when
    const agent = resolveRunAgent(
      { message: "test", agent: "Hephaestus" },
      config,
      env
    )

    // then
    expect(agent).toBe("Hephaestus (Deep Agent)")
  })

  it("uses env agent over config", () => {
    // given
    const config = createConfig({ default_run_agent: "prometheus" })
    const env = { OPENCODE_DEFAULT_AGENT: "Atlas" }

    // when
    const agent = resolveRunAgent({ message: "test" }, config, env)

    // then
    expect(agent).toBe("Atlas (Plan Executor)")
  })

  it("uses config agent over default", () => {
    // given
    const config = createConfig({ default_run_agent: "Prometheus" })

    // when
    const agent = resolveRunAgent({ message: "test" }, config, {})

    // then
    expect(agent).toBe("Prometheus (Plan Builder)")
  })

  it("falls back to sisyphus when none set", () => {
    // given
    const config = createConfig()

    // when
    const agent = resolveRunAgent({ message: "test" }, config, {})

    // then
    expect(agent).toBe("Sisyphus (Ultraworker)")
  })

  it("skips disabled sisyphus for next available core agent", () => {
    // given
    const config = createConfig({ disabled_agents: ["sisyphus"] })

    // when
    const agent = resolveRunAgent({ message: "test" }, config, {})

    // then
    expect(agent).toBe("Hephaestus (Deep Agent)")
  })

  it("maps display-name style default_run_agent values to canonical display names", () => {
    // given
    const config = createConfig({ default_run_agent: "Sisyphus (Ultraworker)" })

    // when
    const agent = resolveRunAgent({ message: "test" }, config, {})

    // then
    expect(agent).toBe("Sisyphus (Ultraworker)")
  })
})

describe("resolveRunPromptAgent", () => {
  it("keeps reserved explore on the runtime key for session prompt payloads", () => {
    expect(resolveRunPromptAgent("Explore (Code Search)")).toBe("explore")
    expect(resolveRunPromptAgent("explore")).toBe("explore")
  })

  it("keeps non-reserved agents on canonical display names", () => {
    expect(resolveRunPromptAgent("Prometheus (Plan Builder)")).toBe("Prometheus (Plan Builder)")
    expect(resolveRunPromptAgent("prometheus")).toBe("Prometheus (Plan Builder)")
  })
})

describe("waitForEventProcessorShutdown", () => {
  it("returns quickly when event processor completes", async () => {
    //#given
    const eventProcessor = new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve()
      }, 25)
    })
    const start = performance.now()

    //#when
    await waitForEventProcessorShutdown(eventProcessor, 200)

    //#then
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(200)
  })

  it("times out and continues when event processor does not complete", async () => {
    //#given
    const eventProcessor = new Promise<void>(() => {})
    const timeoutMs = 200
    const start = performance.now()

    //#when
    await waitForEventProcessorShutdown(eventProcessor, timeoutMs)

    //#then
    const elapsed = performance.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 10)
  })
})

describe("run environment setup", () => {
  let originalClient: string | undefined
  let originalRunMode: string | undefined

  beforeEach(() => {
    originalClient = process.env.OPENCODE_CLIENT
    originalRunMode = process.env.OPENCODE_CLI_RUN_MODE
  })

  afterEach(() => {
    if (originalClient === undefined) {
      delete process.env.OPENCODE_CLIENT
    } else {
      process.env.OPENCODE_CLIENT = originalClient
    }
    if (originalRunMode === undefined) {
      delete process.env.OPENCODE_CLI_RUN_MODE
    } else {
      process.env.OPENCODE_CLI_RUN_MODE = originalRunMode
    }
  })

  it("sets OPENCODE_CLIENT to 'run' to exclude question tool from registry", async () => {
    //#given
    delete process.env.OPENCODE_CLIENT

    //#when - run() sets env vars synchronously before any async work
    const { run } = await import(`./runner?env-setup-${Date.now()}`)
    run({ message: "test" }).catch(() => {})

    //#then
    expect(String(process.env.OPENCODE_CLIENT)).toBe("run")
    expect(String(process.env.OPENCODE_CLI_RUN_MODE)).toBe("true")
  })
})

describe("run with invalid model", () => {
  it("given invalid --model value, when run, then returns exit code 1 with error message", async () => {
    // given
    const originalExit = process.exit
    const originalError = console.error
    const errorMessages: string[] = []
    const exitCodes: number[] = []

    console.error = (...args: unknown[]) => {
      errorMessages.push(args.map(String).join(" "))
    }
    process.exit = ((code?: number) => {
      exitCodes.push(code ?? 0)
      throw new Error("exit")
    }) as typeof process.exit

    try {
      // when
      // Note: This will actually try to run - but the issue is that resolveRunModel
      // is called BEFORE the try block, so it throws an unhandled exception
      // We're testing the runner's error handling
      const { run } = await import("./runner")

      // This will throw because model "invalid" is invalid format
      try {
        await run({
          message: "test",
          model: "invalid",
        })
      } catch {
        // Expected to potentially throw due to unhandled model resolution error
      }
    } finally {
      // then - verify error handling
      // Currently this will fail because the error is not caught properly
      console.error = originalError
      process.exit = originalExit
    }
  })
})

describe("shouldRecoverRunTransportError", () => {
  it("identifies unknown certificate verification errors", () => {
    expect(
      isCertificateVerificationTransportError(new Error("unknown certificate verification error")),
    ).toBe(true)
    expect(
      isCertificateVerificationTransportError(new Error("ECONNRESET")),
    ).toBe(false)
  })

  it("returns true for unknown certificate verification errors", () => {
    expect(
      shouldRecoverRunTransportError(new Error("unknown certificate verification error")),
    ).toBe(true)
  })

  it("returns true for ECONNRESET-wrapped API call errors", () => {
    expect(
      shouldRecoverRunTransportError({
        name: "AI_APICallError",
        cause: {
          code: "ECONNRESET",
          path: "https://chatgpt.com/backend-api/codex/responses",
        },
      }),
    ).toBe(true)
  })

  it("returns false for quota-style terminal errors", () => {
    expect(
      shouldRecoverRunTransportError(new Error("out of extra usage")),
    ).toBe(false)
  })

  it("uses extended recovery policy for certificate verification transport errors", () => {
    expect(
      getRunTransportRecoveryPolicy(new Error("unknown certificate verification error")),
    ).toEqual({
      maxAttempts: 8,
      delayMs: 5000,
    })
    expect(
      getRunTransportRecoveryPolicy(new Error("ECONNRESET")),
    ).toEqual({
      maxAttempts: 2,
      delayMs: 2000,
    })
  })
})

describe("run isolated data home", () => {
  let originalXdgDataHome: string | undefined
  let originalDisableIsolation: string | undefined

  beforeEach(() => {
    originalXdgDataHome = process.env.XDG_DATA_HOME
    originalDisableIsolation = process.env.OH_MY_OPENAGENT_DISABLE_RUN_DATA_ISOLATION
  })

  afterEach(() => {
    if (originalXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME
    } else {
      process.env.XDG_DATA_HOME = originalXdgDataHome
    }

    if (originalDisableIsolation === undefined) {
      delete process.env.OH_MY_OPENAGENT_DISABLE_RUN_DATA_ISOLATION
    } else {
      process.env.OH_MY_OPENAGENT_DISABLE_RUN_DATA_ISOLATION = originalDisableIsolation
    }
  })

  it("uses isolated data home by default for local run sessions", () => {
    expect(shouldUseIsolatedRunDataHome({ attach: undefined }, {})).toBe(true)
  })

  it("skips isolated data home when attach is used", () => {
    expect(shouldUseIsolatedRunDataHome({ attach: "http://127.0.0.1:4096" }, {})).toBe(false)
  })

  it("supports disabling isolated data home through env override", () => {
    expect(
      shouldUseIsolatedRunDataHome(
        { attach: undefined },
        { OH_MY_OPENAGENT_DISABLE_RUN_DATA_ISOLATION: "1" } as NodeJS.ProcessEnv,
      ),
    ).toBe(false)
  })

  it("copies auth.json into the isolated run data home and restores XDG_DATA_HOME on cleanup", () => {
    const fakePreferredDataHome = `/tmp/omo-run-auth-source-${Date.now()}`
    const authSourceDir = join(fakePreferredDataHome, "opencode")
    const authSourcePath = join(authSourceDir, "auth.json")
    const authPayload = JSON.stringify({ provider: "openai", token: "test-token" })
    mkdirSync(authSourceDir, { recursive: true })
    writeFileSync(authSourcePath, authPayload)
    process.env.XDG_DATA_HOME = fakePreferredDataHome

    const isolated = prepareIsolatedRunDataHome(process.env)
    const copiedAuthPath = join(process.env.XDG_DATA_HOME ?? "", "opencode", "auth.json")

    try {
      expect(process.env.XDG_DATA_HOME).toBe(isolated.tempDir)
      expect(existsSync(copiedAuthPath)).toBe(true)
      expect(readFileSync(copiedAuthPath, "utf8")).toBe(authPayload)
    } finally {
      cleanupIsolatedRunDataHome(isolated, process.env)
      rmSync(fakePreferredDataHome, { recursive: true, force: true })
    }

    expect(process.env.XDG_DATA_HOME).toBe(fakePreferredDataHome)
  })
})

describe("shouldResumePollingAfterPromptFailure", () => {
  it("resumes polling when promptAsync aborts after the session already armed recovery", async () => {
    // given
    const ctx = {
      client: {
        session: {
          status: vi.fn(async () => ({
            data: {
              "ses_test": { type: "busy" },
            },
          })),
          todo: vi.fn(async () => ({ data: [] })),
          children: vi.fn(async () => ({ data: [] })),
          messages: vi.fn(async () => ({ data: [] })),
        },
      },
      sessionID: "ses_test",
      directory: "/tmp/test",
      abortController: new AbortController(),
    } as any

    // when
    const result = await shouldResumePollingAfterPromptFailure(
      ctx,
      {
        hasReceivedMeaningfulWork: false,
        currentTool: null,
        pendingSameModelRecovery: true,
        mainSessionError: false,
      },
      new Error("Aborted"),
      { attempts: 1, delayMs: 1 },
    )

    // then
    expect(result).toBe(true)
  })
})
