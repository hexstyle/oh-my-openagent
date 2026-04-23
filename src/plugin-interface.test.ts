import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { createPluginInterface } from "./plugin-interface"
import { createAutoSlashCommandHook } from "./hooks/auto-slash-command"
import { createStartWorkHook } from "./hooks/start-work"
import { readBoulderState } from "./features/boulder-state"
import {
  _resetForTesting,
  getSessionAgent,
  registerAgentName,
  updateSessionAgent,
} from "./features/claude-code-session-state"

describe("createPluginInterface - command.execute.before", () => {
  let testDir = ""

  beforeEach(() => {
    testDir = join(tmpdir(), `plugin-interface-start-work-${randomUUID()}`)
    mkdirSync(join(testDir, ".sisyphus", "plans"), { recursive: true })
    writeFileSync(
      join(testDir, ".sisyphus", "plans", "worker-plan.md"),
      "# Plan\n\n## TODOs\n- [ ] 1. Task 1\n",
    )
    _resetForTesting()
    registerAgentName("prometheus")
    registerAgentName("sisyphus")
  })

  afterEach(() => {
    _resetForTesting()
    rmSync(testDir, { recursive: true, force: true })
  })

  test("exposes and routes native start-work command execution through the plugin interface", async () => {
    const startWorkCommandHook = mock(async () => {})
    const isStopped = mock(() => true)
    const clear = mock(() => {})

    const pluginInterface = createPluginInterface({
      ctx: {
        directory: testDir,
        client: {},
      } as never,
      pluginConfig: {} as never,
      firstMessageVariantGate: {
        shouldOverride: () => false,
        markApplied: () => {},
        markSessionCreated: () => {},
        clear: () => {},
      },
      managers: {
        configHandler: async () => {},
      } as never,
      hooks: {
        startWork: {
          "command.execute.before": startWorkCommandHook,
        },
        stopContinuationGuard: {
          isStopped,
          clear,
        },
      } as never,
      tools: {},
    })

    expect(typeof pluginInterface["command.execute.before"]).toBe("function")

    await pluginInterface["command.execute.before"]?.(
      {
        command: "start-work",
        sessionID: "ses-live-start-work",
        arguments: "worker-plan",
      },
      {
        parts: [],
      } as never,
    )

    expect(startWorkCommandHook).toHaveBeenCalledTimes(1)
    expect(isStopped).toHaveBeenCalledWith("ses-live-start-work")
    expect(clear).toHaveBeenCalledWith("ses-live-start-work")
  })

  test("executes start-work side effects for native command execution", async () => {
    updateSessionAgent("ses-command-before", "prometheus")
    const pluginInterface = createPluginInterface({
      ctx: {
        directory: testDir,
        client: { tui: { showToast: async () => {} } },
      } as never,
      pluginConfig: {} as never,
      firstMessageVariantGate: {
        shouldOverride: () => false,
        markApplied: () => {},
        markSessionCreated: () => {},
        clear: () => {},
      },
      managers: {} as never,
      hooks: {
        autoSlashCommand: createAutoSlashCommandHook({ skills: [] }),
        startWork: createStartWorkHook({
          directory: testDir,
          client: { tui: { showToast: async () => {} } },
        } as never),
      } as never,
      tools: {},
    })
    const output = {
      parts: [{ type: "text", text: "original" }],
    }

    await pluginInterface["command.execute.before"]?.(
      {
        command: "start-work",
        sessionID: "ses-command-before",
        arguments: "worker-plan",
      },
      output as never,
    )

    expect(pluginInterface["command.execute.before"]).toBeDefined()
    expect(output.parts[0]?.text).toContain("Auto-Selected Plan")
    expect(output.parts[0]?.text).toContain("boulder.json has been created")
    expect(getSessionAgent("ses-command-before")).toBe("Prometheus (Plan Builder)")
    expect(readBoulderState(testDir)?.agent).toBe("Prometheus (Plan Builder)")
  })

  test("does not run start-work side effects for other native commands with session context", async () => {
    updateSessionAgent("ses-handoff", "prometheus")
    const pluginInterface = createPluginInterface({
      ctx: {
        directory: testDir,
        client: { tui: { showToast: async () => {} } },
      } as never,
      pluginConfig: {} as never,
      firstMessageVariantGate: {
        shouldOverride: () => false,
        markApplied: () => {},
        markSessionCreated: () => {},
        clear: () => {},
      },
      managers: {} as never,
      hooks: {
        autoSlashCommand: createAutoSlashCommandHook({ skills: [] }),
        startWork: createStartWorkHook({
          directory: testDir,
          client: { tui: { showToast: async () => {} } },
        } as never),
      } as never,
      tools: {},
    })
    const output = {
      parts: [{ type: "text", text: "original" }],
    }

    await pluginInterface["command.execute.before"]?.(
      {
        command: "handoff",
        sessionID: "ses-handoff",
        arguments: "",
      },
      output as never,
    )

    expect(output.parts[0]?.text).toContain("HANDOFF CONTEXT")
    expect(readBoulderState(testDir)).toBeNull()
    expect(getSessionAgent("ses-handoff")).toBe("Prometheus (Plan Builder)")
  })

  test("switches native start-work to Atlas when Atlas is registered in config", async () => {
    registerAgentName("atlas")
    updateSessionAgent("ses-command-atlas", "prometheus")
    const pluginInterface = createPluginInterface({
      ctx: {
        directory: testDir,
        client: { tui: { showToast: async () => {} } },
      } as never,
      pluginConfig: {} as never,
      firstMessageVariantGate: {
        shouldOverride: () => false,
        markApplied: () => {},
        markSessionCreated: () => {},
        clear: () => {},
      },
      managers: {} as never,
      hooks: {
        autoSlashCommand: createAutoSlashCommandHook({ skills: [] }),
        startWork: createStartWorkHook({
          directory: testDir,
          client: { tui: { showToast: async () => {} } },
        } as never),
      } as never,
      tools: {},
    })
    const output = {
      message: {} as Record<string, unknown>,
      parts: [{ type: "text", text: "/start-work" }],
    }

    await pluginInterface["chat.message"]?.(
      {
        sessionID: "ses-command-atlas",
        agent: "prometheus",
      } as never,
      output as never,
    )

    expect(output.message.agent).toBe("Atlas (Plan Executor)")
    expect(getSessionAgent("ses-command-atlas")).toBe("Atlas (Plan Executor)")
    expect(readBoulderState(testDir)?.agent).toBe("atlas")
  })
})

describe("createPluginInterface - ulw-loop native command smoke", () => {
  let testDir = ""

  beforeEach(() => {
    testDir = join(tmpdir(), `plugin-interface-ulw-loop-${randomUUID()}`)
    mkdirSync(testDir, { recursive: true })
    _resetForTesting()
    registerAgentName("sisyphus")
  })

  afterEach(() => {
    _resetForTesting()
    rmSync(testDir, { recursive: true, force: true })
  })

  test("starts the ultrawork loop from the native command flow with parsed arguments intact", async () => {
    const startLoopCalls: Array<{
      sessionID: string
      prompt: string
      options: Record<string, unknown>
    }> = []
    const pluginInterface = createPluginInterface({
      ctx: {
        directory: testDir,
        client: { tui: { showToast: async () => {} } },
      } as never,
      pluginConfig: {} as never,
      firstMessageVariantGate: {
        shouldOverride: () => false,
        markApplied: () => {},
        markSessionCreated: () => {},
        clear: () => {},
      },
      managers: {} as never,
      hooks: {
        autoSlashCommand: createAutoSlashCommandHook({ skills: [] }),
        ralphLoop: {
          startLoop: (sessionID: string, prompt: string, options?: Record<string, unknown>) => {
            startLoopCalls.push({ sessionID, prompt, options: options ?? {} })
            return true
          },
          cancelLoop: () => true,
          getState: () => null,
        },
      } as never,
      tools: {},
    })
    const output = {
      message: {} as Record<string, unknown>,
      parts: [{ type: "text", text: "original" }],
    }

    await pluginInterface["command.execute.before"]?.(
      {
        command: "ulw-loop",
        sessionID: "ses-ulw-native",
        arguments: "\"Ship feature\" --strategy=continue",
      },
      output as never,
    )
    await pluginInterface["chat.message"]?.(
      {
        sessionID: "ses-ulw-native",
        agent: "sisyphus",
      } as never,
      output as never,
    )

    expect(output.parts[0]?.text).toContain("/ulw-loop Command")
    expect(startLoopCalls).toEqual([
      {
        sessionID: "ses-ulw-native",
        prompt: "Ship feature",
        options: {
          ultrawork: true,
          maxIterations: undefined,
          completionPromise: undefined,
          strategy: "continue",
        },
      },
    ])
  })
})
