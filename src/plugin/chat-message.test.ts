import { afterEach, beforeEach, describe, test, expect } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"

import { createChatMessageHandler } from "./chat-message"
import { _resetForTesting, setMainSession, subagentSessions } from "../features/claude-code-session-state"
import { clearSessionModel, getSessionModel, setSessionModel } from "../shared/session-model-state"
import { createAutoSlashCommandHook } from "../hooks/auto-slash-command/hook"
import { createStartWorkHook } from "../hooks/start-work"
import { readBoulderState } from "../features/boulder-state"
import { registerAgentName } from "../features/claude-code-session-state"
import { clearSessionTools, getSessionTools, hasSessionFlag } from "../shared/session-tools-store"

type ChatMessagePart = { type: string; text?: string; [key: string]: unknown }
type ChatMessageHandlerOutput = { message: Record<string, unknown>; parts: ChatMessagePart[] }

function createMockHandlerArgs(overrides?: {
  pluginConfig?: Record<string, unknown>
  shouldOverride?: boolean
}) {
  const appliedSessions: string[] = []
  return {
    ctx: { client: { tui: { showToast: async () => {} } } } as any,
    pluginConfig: (overrides?.pluginConfig ?? {}) as any,
    firstMessageVariantGate: {
      shouldOverride: () => overrides?.shouldOverride ?? false,
      markApplied: (sessionID: string) => { appliedSessions.push(sessionID) },
    },
    hooks: {
      stopContinuationGuard: null,
      backgroundNotificationHook: null,
      keywordDetector: null,
      claudeCodeHooks: null,
      autoSlashCommand: null,
      startWork: null,
      ralphLoop: null,
    } as any,
    _appliedSessions: appliedSessions,
  }
}

afterEach(() => {
  _resetForTesting()
  clearSessionModel("test-session")
  clearSessionModel("main-session")
  clearSessionModel("subagent-session")
  clearSessionTools()
})

describe("createChatMessageHandler - start-work integration", () => {
  let testDir: string

  beforeEach(() => {
    _resetForTesting()
    testDir = join(tmpdir(), `chat-message-start-work-${randomUUID()}`)
    mkdirSync(join(testDir, ".sisyphus", "plans"), { recursive: true })
    writeFileSync(
      join(testDir, ".sisyphus", "plans", "ci-green-final.md"),
      `# Plan

## TODOs
- [ ] 0.1. Real executable task

## Final Verification Wave
- [ ] F1. Final verification
`,
    )
    registerAgentName("atlas")
    registerAgentName("sisyphus")
  })

  afterEach(() => {
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  test("routes raw /start-work through auto-slash and start-work hooks in opencode run style sessions", async () => {
    //#given
    const autoSlashCommand = createAutoSlashCommandHook({
      pluginsEnabled: true,
      enabledPluginsOverride: {},
    })
    const startWork = createStartWorkHook({
      directory: testDir,
      client: { tui: { showToast: async () => {} } },
    } as any)
    const handler = createChatMessageHandler({
      ctx: { client: { tui: { showToast: async () => {} } } } as any,
      pluginConfig: {} as any,
      firstMessageVariantGate: {
        shouldOverride: () => false,
        markApplied: () => {},
      },
      hooks: {
        stopContinuationGuard: null,
        backgroundNotificationHook: null,
        runtimeFallback: null,
        keywordDetector: null,
        thinkMode: null,
        claudeCodeHooks: null,
        autoSlashCommand,
        noSisyphusGpt: null,
        noHephaestusNonGpt: null,
        startWork,
        ralphLoop: null,
      } as any,
    })
    const output = {
      message: {},
      parts: [{ type: "text", text: "/start-work ci-green-final" }],
    }

    //#when
    await handler(
      {
        sessionID: "session-start-work",
        agent: "prometheus",
      },
      output,
    )

    //#then
    expect(String(output.message["agent"])).toBe("Atlas (Plan Executor)")
    expect(output.parts[0].text).toContain("Auto-Selected Plan")
    expect(output.parts[0].text).toContain("ci-green-final")

    const state = readBoulderState(testDir)
    expect(state?.active_plan).toBe(join(testDir, ".sisyphus", "plans", "ci-green-final.md"))
    expect(state?.session_ids).toContain("session-start-work")
    expect(state?.agent).toBe("atlas")
  })

  test("persists ci fast-path tool restrictions into the session tool store", async () => {
    const evidenceDir = join(testDir, ".sisyphus", "evidence")
    mkdirSync(evidenceDir, { recursive: true })
    writeFileSync(join(evidenceDir, "build-315-analysis.md"), "# Build 315\n")
    writeFileSync(join(evidenceDir, "ci-loop-checkpoint.md"), "# checkpoint\n")
    writeFileSync(join(evidenceDir, "repair-log.md"), "# repair log\n")
    writeFileSync(
      join(testDir, ".sisyphus", "plans", "ci-green-final.md"),
      `# Plan

**Skills**: \`ci-green-loop\`, \`bamboo-ci\`, \`dotnet-playwright\`

## TODOs
- [x] 1. **T1 — Diagnosis**
- [ ] 2. **T2 — Fix ALL failures**
`,
    )

    const autoSlashCommand = createAutoSlashCommandHook({
      pluginsEnabled: true,
      enabledPluginsOverride: {},
    })
    const startWork = createStartWorkHook({
      directory: testDir,
      client: { tui: { showToast: async () => {} } },
    } as any)
    const handler = createChatMessageHandler({
      ctx: { client: { tui: { showToast: async () => {} } } } as any,
      pluginConfig: {} as any,
      firstMessageVariantGate: {
        shouldOverride: () => false,
        markApplied: () => {},
      },
      hooks: {
        stopContinuationGuard: null,
        backgroundNotificationHook: null,
        runtimeFallback: null,
        keywordDetector: null,
        thinkMode: null,
        claudeCodeHooks: null,
        autoSlashCommand,
        noSisyphusGpt: null,
        noHephaestusNonGpt: null,
        startWork,
        ralphLoop: null,
      } as any,
    })
    const output = {
      message: {},
      parts: [{ type: "text", text: "/start-work ci-green-final" }],
    }

    await handler(
      {
        sessionID: "session-ci-tools",
        agent: "prometheus",
      },
      output,
    )

    expect(getSessionTools("session-ci-tools")).toEqual({
      task: false,
      "task_*": false,
      skill: false,
      skill_mcp: false,
      teammate: false,
      call_omo_agent: false,
      session_search: false,
      todowrite: false,
      todoread: false,
      webfetch: false,
    })
  })

  test("direct evidence-gated ci prompts inherit ci fast-path restrictions without /start-work", async () => {
    const handler = createChatMessageHandler(createMockHandlerArgs())
    const output = {
      message: {},
      parts: [{
        type: "text",
        text: "Resume an evidence-gated CI fix loop. Use canonical .sisyphus/evidence/repair-log.md and .sisyphus/evidence/ci-loop-checkpoint.md. Cover the current failing set, use bounded Playwright reruns, and run Claude review before push.",
      }],
    }

    await handler(
      {
        sessionID: "session-direct-ci-evidence",
        agent: "sisyphus",
      },
      output,
    )

    expect(hasSessionFlag("session-direct-ci-evidence", "ci-fast-path")).toBe(true)
    expect(getSessionTools("session-direct-ci-evidence")).toEqual({
      skill: false,
      skill_mcp: false,
      teammate: false,
      call_omo_agent: false,
      session_search: false,
      todowrite: false,
      todoread: false,
      webfetch: false,
    })
  })

  test("routes quoted raw /start-work through auto-slash and start-work hooks in opencode run style sessions", async () => {
    const autoSlashCommand = createAutoSlashCommandHook({
      pluginsEnabled: true,
      enabledPluginsOverride: {},
    })
    const startWork = createStartWorkHook({
      directory: testDir,
      client: { tui: { showToast: async () => {} } },
    } as any)
    const handler = createChatMessageHandler({
      ctx: { client: { tui: { showToast: async () => {} } } } as any,
      pluginConfig: {} as any,
      firstMessageVariantGate: {
        shouldOverride: () => false,
        markApplied: () => {},
      },
      hooks: {
        stopContinuationGuard: null,
        backgroundNotificationHook: null,
        runtimeFallback: null,
        keywordDetector: null,
        thinkMode: null,
        claudeCodeHooks: null,
        autoSlashCommand,
        noSisyphusGpt: null,
        noHephaestusNonGpt: null,
        startWork,
        ralphLoop: null,
      } as any,
    })
    const output = {
      message: {},
      parts: [{ type: "text", text: "\"/start-work ci-green-final\"\n" }],
    }

    await handler(
      {
        sessionID: "session-quoted-start-work",
        agent: "prometheus",
      },
      output,
    )

    expect(String(output.message["agent"])).toBe("Atlas (Plan Executor)")
    expect(output.parts[0].text).toContain("Auto-Selected Plan")
    expect(output.parts[0].text).toContain("ci-green-final")

    const state = readBoulderState(testDir)
    expect(state?.active_plan).toBe(join(testDir, ".sisyphus", "plans", "ci-green-final.md"))
    expect(state?.session_ids).toContain("session-quoted-start-work")
    expect(state?.agent).toBe("atlas")
  })

  test("routes double-wrapped quoted raw /start-work through auto-slash and start-work hooks in live opencode run style sessions", async () => {
    const autoSlashCommand = createAutoSlashCommandHook({
      pluginsEnabled: true,
      enabledPluginsOverride: {},
    })
    const startWork = createStartWorkHook({
      directory: testDir,
      client: { tui: { showToast: async () => {} } },
    } as any)
    const handler = createChatMessageHandler({
      ctx: { client: { tui: { showToast: async () => {} } } } as any,
      pluginConfig: {} as any,
      firstMessageVariantGate: {
        shouldOverride: () => false,
        markApplied: () => {},
      },
      hooks: {
        stopContinuationGuard: null,
        backgroundNotificationHook: null,
        runtimeFallback: null,
        keywordDetector: null,
        thinkMode: null,
        claudeCodeHooks: null,
        autoSlashCommand,
        noSisyphusGpt: null,
        noHephaestusNonGpt: null,
        startWork,
        ralphLoop: null,
      } as any,
    })
    const output = {
      message: {},
      parts: [{ type: "text", text: "\"\\\"/start-work ci-green-final\\\"\"" }],
    }

    await handler(
      {
        sessionID: "session-double-quoted-start-work",
        agent: "prometheus",
      },
      output,
    )

    expect(String(output.message["agent"])).toBe("Atlas (Plan Executor)")
    expect(output.parts[0].text).toContain("Auto-Selected Plan")
    expect(output.parts[0].text).toContain("ci-green-final")

    const state = readBoulderState(testDir)
    expect(state?.active_plan).toBe(join(testDir, ".sisyphus", "plans", "ci-green-final.md"))
    expect(state?.session_ids).toContain("session-double-quoted-start-work")
    expect(state?.agent).toBe("atlas")
  })

  test("runs auto-slash before keyword detection for raw /start-work sessions", async () => {
    const autoSlashCommand = createAutoSlashCommandHook({
      pluginsEnabled: true,
      enabledPluginsOverride: {},
    })
    const startWork = createStartWorkHook({
      directory: testDir,
      client: { tui: { showToast: async () => {} } },
    } as any)
    const keywordDetector = {
      "chat.message": async (
        _input: { sessionID: string },
        output: { parts: Array<{ type: string; text?: string }> },
      ): Promise<void> => {
        const textPart = output.parts.find((part) => part.type === "text" && typeof part.text === "string")
        if (textPart?.text?.startsWith("/start-work")) {
          textPart.text = `[analyze-mode]\n\n${textPart.text}`
        }
      },
    }
    const handler = createChatMessageHandler({
      ctx: { client: { tui: { showToast: async () => {} } } } as any,
      pluginConfig: {} as any,
      firstMessageVariantGate: {
        shouldOverride: () => false,
        markApplied: () => {},
      },
      hooks: {
        stopContinuationGuard: null,
        backgroundNotificationHook: null,
        runtimeFallback: null,
        keywordDetector,
        thinkMode: null,
        claudeCodeHooks: null,
        autoSlashCommand,
        noSisyphusGpt: null,
        noHephaestusNonGpt: null,
        startWork,
        ralphLoop: null,
      } as any,
    })
    const output = {
      message: {},
      parts: [{ type: "text", text: "/start-work ci-green-final" }],
    }

    await handler(
      {
        sessionID: "session-order-start-work",
        agent: "prometheus",
      },
      output,
    )

    expect(String(output.message["agent"])).toBe("Atlas (Plan Executor)")
    expect(output.parts[0].text).toContain("Auto-Selected Plan")
    expect(output.parts[0].text).not.toContain("[analyze-mode]")
  })

  test("routes doubly-escaped quoted raw /start-work through auto-slash and start-work hooks in live opencode run style sessions", async () => {
    const autoSlashCommand = createAutoSlashCommandHook({
      pluginsEnabled: true,
      enabledPluginsOverride: {},
    })
    const startWork = createStartWorkHook({
      directory: testDir,
      client: { tui: { showToast: async () => {} } },
    } as any)
    const handler = createChatMessageHandler({
      ctx: { client: { tui: { showToast: async () => {} } } } as any,
      pluginConfig: {} as any,
      firstMessageVariantGate: {
        shouldOverride: () => false,
        markApplied: () => {},
      },
      hooks: {
        stopContinuationGuard: null,
        backgroundNotificationHook: null,
        runtimeFallback: null,
        keywordDetector: null,
        thinkMode: null,
        claudeCodeHooks: null,
        autoSlashCommand,
        noSisyphusGpt: null,
        noHephaestusNonGpt: null,
        startWork,
        ralphLoop: null,
      } as any,
    })
    const output = {
      message: {},
      parts: [{ type: "text", text: "\"\\\\\\\"/start-work ci-green-final\\\\\\\"\"" }],
    }

    await handler(
      {
        sessionID: "session-double-escaped-start-work",
        agent: "prometheus",
      },
      output,
    )

    expect(String(output.message["agent"])).toBe("Atlas (Plan Executor)")
    expect(output.parts[0].text).toContain("Auto-Selected Plan")
    expect(output.parts[0].text).toContain("ci-green-final")

    const state = readBoulderState(testDir)
    expect(state?.active_plan).toBe(join(testDir, ".sisyphus", "plans", "ci-green-final.md"))
    expect(state?.session_ids).toContain("session-double-escaped-start-work")
    expect(state?.agent).toBe("atlas")
  })
})

function createMockInput(agent?: string, model?: { providerID: string; modelID: string }) {
  return {
    sessionID: "test-session",
    agent,
    model,
  }
}

function createMockOutput(variant?: string): ChatMessageHandlerOutput {
  const message: Record<string, unknown> = {}
  if (variant !== undefined) {
    message["variant"] = variant
  }
  return { message, parts: [] }
}

describe("createChatMessageHandler - TUI variant passthrough", () => {
  test("first message: does not override TUI variant when user has no selection", async () => {
    //#given - first message, no user-selected variant
    const args = createMockHandlerArgs({ shouldOverride: true })
    const handler = createChatMessageHandler(args)
    const input = createMockInput("hephaestus", { providerID: "openai", modelID: "gpt-5.3-codex" })
    const output = createMockOutput() // no variant set

    //#when
    await handler(input, output)

    //#then - TUI sent undefined, should stay undefined (no config override)
    expect(output.message["variant"]).toBeUndefined()
  })

  test("first message: preserves user-selected variant when already set", async () => {
    //#given - first message, user already selected "xhigh" variant in OpenCode UI
    const args = createMockHandlerArgs({ shouldOverride: true })
    const handler = createChatMessageHandler(args)
    const input = createMockInput("hephaestus", { providerID: "openai", modelID: "gpt-5.3-codex" })
    const output = createMockOutput("xhigh") // user selected xhigh

    //#when
    await handler(input, output)

    //#then - user's xhigh must be preserved
    expect(output.message["variant"]).toBe("xhigh")
  })

  test("subsequent message: preserves TUI variant", async () => {
    //#given - not first message, variant already set
    const args = createMockHandlerArgs({ shouldOverride: false })
    const handler = createChatMessageHandler(args)
    const input = createMockInput("hephaestus", { providerID: "openai", modelID: "gpt-5.3-codex" })
    const output = createMockOutput("xhigh")

    //#when
    await handler(input, output)

    //#then
    expect(output.message["variant"]).toBe("xhigh")
  })

  test("subsequent message: does not inject variant when TUI sends none", async () => {
    //#given - not first message, no variant from TUI
    const args = createMockHandlerArgs({ shouldOverride: false })
    const handler = createChatMessageHandler(args)
    const input = createMockInput("hephaestus", { providerID: "openai", modelID: "gpt-5.3-codex" })
    const output = createMockOutput() // no variant

    //#when
    await handler(input, output)

    //#then - should stay undefined, not auto-resolved from config
    expect(output.message["variant"]).toBeUndefined()
  })

  test("first message: marks gate as applied regardless of variant presence", async () => {
    //#given - first message with user-selected variant
    const args = createMockHandlerArgs({ shouldOverride: true })
    const handler = createChatMessageHandler(args)
    const input = createMockInput("hephaestus", { providerID: "openai", modelID: "gpt-5.3-codex" })
    const output = createMockOutput("xhigh")

    //#when
    await handler(input, output)

    //#then - gate should still be marked as applied
    expect(args._appliedSessions).toContain("test-session")
  })

  test("injects queued background notifications through chat.message hook", async () => {
    //#given
    const args = createMockHandlerArgs()
    args.hooks.backgroundNotificationHook = {
      "chat.message": async (
        _input: { sessionID: string },
        output: ChatMessageHandlerOutput,
      ): Promise<void> => {
        output.parts.push({
          type: "text",
          text: "<system-reminder>[BACKGROUND TASK COMPLETED]</system-reminder>",
        })
      },
    }
    const handler = createChatMessageHandler(args)
    const input = createMockInput("hephaestus", { providerID: "openai", modelID: "gpt-5.3-codex" })
    const output = createMockOutput()

    //#when
    await handler(input, output)

    //#then
    expect(output.parts).toHaveLength(1)
    expect(output.parts[0].text).toContain("[BACKGROUND TASK COMPLETED]")
  })

  test("reuses the stored model for subsequent messages in the main session when the UI sends none", async () => {
    //#given
    setMainSession("test-session")
    setSessionModel("test-session", { providerID: "openai", modelID: "gpt-5.4" })
    const args = createMockHandlerArgs({ shouldOverride: false })
    const handler = createChatMessageHandler(args)
    const input = createMockInput("sisyphus")
    const output = createMockOutput()

    //#when
    await handler(input, output)

    //#then
    expect(output.message["model"]).toEqual({ providerID: "openai", modelID: "gpt-5.4" })
    expect(getSessionModel("test-session")).toEqual({ providerID: "openai", modelID: "gpt-5.4" })
  })

  test("does not reuse a stored model for the first message of a session", async () => {
    //#given
    setMainSession("test-session")
    setSessionModel("test-session", { providerID: "openai", modelID: "gpt-5.4" })
    const args = createMockHandlerArgs({ shouldOverride: true })
    const handler = createChatMessageHandler(args)
    const input = createMockInput("sisyphus")
    const output = createMockOutput()

    //#when
    await handler(input, output)

    //#then
    expect(output.message["model"]).toBeUndefined()
  })

  test("does not reuse the main-session model for subagent sessions", async () => {
    //#given
    setMainSession("main-session")
    setSessionModel("main-session", { providerID: "openai", modelID: "gpt-5.4" })
    subagentSessions.add("subagent-session")
    const args = createMockHandlerArgs({ shouldOverride: false })
    const handler = createChatMessageHandler(args)
    const input = {
      sessionID: "subagent-session",
      agent: "oracle",
    }
    const output = createMockOutput()

    //#when
    await handler(input, output)

    //#then
    expect(output.message["model"]).toBeUndefined()
    expect(getSessionModel("subagent-session")).toBeUndefined()
  })

  test("does not override explicit agent model overrides with stored session model", async () => {
    //#given
    setMainSession("test-session")
    setSessionModel("test-session", { providerID: "openai", modelID: "gpt-5.4" })
    const args = createMockHandlerArgs({
      shouldOverride: false,
      pluginConfig: {
        agents: {
          sisyphus: { model: "anthropic/claude-opus-4-6" },
        },
      },
    })
    const handler = createChatMessageHandler(args)
    const input = createMockInput("sisyphus")
    const output = createMockOutput()

    //#when
    await handler(input, output)

    //#then
    expect(output.message["model"]).toBeUndefined()
    expect(getSessionModel("test-session")).toEqual({ providerID: "openai", modelID: "gpt-5.4" })
  })

  test("respects a mid-conversation model switch instead of reusing the previous stored model", async () => {
    //#given
    setMainSession("test-session")
    setSessionModel("test-session", { providerID: "anthropic", modelID: "claude-opus-4-6" })
    const args = createMockHandlerArgs({ shouldOverride: false })
    const handler = createChatMessageHandler(args)
    const nextModel = { providerID: "openai", modelID: "gpt-5.4" }
    const input = createMockInput("sisyphus", nextModel)
    const output = createMockOutput()

    //#when
    await handler(input, output)

    //#then
    expect(output.message["model"]).toBeUndefined()
    expect(getSessionModel("test-session")).toEqual(nextModel)
  })
})
