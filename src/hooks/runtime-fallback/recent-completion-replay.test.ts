import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test"
import type { OhMyOpenCodeConfig, RuntimeFallbackConfig } from "../../config"
import { createRuntimeFallbackHook } from "./hook"
import * as sharedModule from "../../shared"

describe("runtime-fallback recent completion replay guard", () => {
  let logCalls: Array<{ msg: string; data?: unknown }>
  let logSpy: ReturnType<typeof spyOn>

  function createMockConfig(overrides?: Partial<RuntimeFallbackConfig>): RuntimeFallbackConfig {
    return {
      enabled: true,
      retry_on_errors: [429, 503, 529],
      max_fallback_attempts: 3,
      cooldown_seconds: 60,
      notify_on_fallback: false,
      timeout_seconds: 30,
      ...overrides,
    }
  }

  function createPluginConfig(): OhMyOpenCodeConfig {
    return {
      categories: {
        test: {
          fallback_models: [
            "anthropic/claude-opus-4-6",
            "openai/gpt-5.4",
          ],
        },
      },
      agents: {
        prometheus: {
          model: "anthropic/claude-opus-4-6",
          fallback_models: [
            "anthropic/claude-opus-4-6",
            "openai/gpt-5.4",
          ],
        },
      },
    }
  }

  beforeEach(() => {
    jest.useFakeTimers()
    logCalls = []
    logSpy = spyOn(sharedModule, "log").mockImplementation((msg: string, data?: unknown) => {
      logCalls.push({ msg, data })
    })
  })

  afterEach(() => {
    jest.clearAllTimers()
    jest.useRealTimers()
    logSpy?.mockRestore()
  })

  test("suppresses stale replay events that arrive after a completed planning turn", async () => {
    const sessionID = "ses-recent-completion-replay"
    const abortCalls: string[] = []
    const promptAsyncCalls: Array<{ sessionID: string; agent?: string }> = []
    let messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "plan the work" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "Plan is complete." }] },
    ]

    const hook = createRuntimeFallbackHook(
      {
        client: {
          tui: {
            showToast: async () => ({}),
          },
          session: {
            messages: async () => ({ data: messages }),
            promptAsync: async (args: {
              path?: { id: string }
              body?: { agent?: string }
            }) => {
              promptAsyncCalls.push({
                sessionID: args.path?.id ?? "",
                agent: args.body?.agent,
              })
              return {}
            },
            abort: async (args: { path: { id: string } }) => {
              abortCalls.push(args.path.id)
              return {}
            },
          },
        },
        directory: "/test/dir",
      },
      {
        config: createMockConfig({ timeout_seconds: 30 }),
        pluginConfig: createPluginConfig(),
        session_timeout_ms: 20,
      },
    )

    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "user-1",
            sessionID,
            role: "user",
            agent: "Prometheus (Plan Builder)",
            model: {
              providerID: "anthropic",
              modelID: "claude-opus-4-6",
            },
          },
        },
      },
    })

    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "assistant-1",
            sessionID,
            role: "assistant",
            agent: "Prometheus (Plan Builder)",
            model: {
              providerID: "anthropic",
              modelID: "claude-opus-4-6",
            },
            message: "Plan is complete.",
          },
        },
      },
    })

    await hook.event({
      event: {
        type: "session.idle",
        properties: { sessionID },
      },
    })

    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "user-1",
            sessionID,
            role: "user",
            agent: "Prometheus (Plan Builder)",
            model: {
              providerID: "anthropic",
              modelID: "claude-opus-4-6",
            },
          },
        },
      },
    })

    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "assistant-1",
            sessionID,
            role: "assistant",
            agent: "Prometheus (Plan Builder)",
            model: {
              providerID: "anthropic",
              modelID: "claude-opus-4-6",
            },
          },
        },
      },
    })

    await hook.event({
      event: {
        type: "session.status",
        properties: {
          sessionID,
          status: {
            type: "running",
            message: "Finishing up",
          },
        },
      },
    })

    jest.advanceTimersByTime(25)
    await Promise.resolve()

    expect(abortCalls).toEqual([])
    expect(promptAsyncCalls).toEqual([])
    expect(
      logCalls.filter((call) => call.msg.includes("Suppressed stale runtime-fallback re-arm after recent session completion")),
    ).toHaveLength(3)
  })

  test("allows a fresh user turn inside the suppression window when the message id changes", async () => {
    const sessionID = "ses-recent-completion-new-turn"
    const abortCalls: string[] = []
    const promptAsyncCalls: Array<{ sessionID: string; agent?: string }> = []
    let messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "plan the work" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "Plan is complete." }] },
    ]

    const hook = createRuntimeFallbackHook(
      {
        client: {
          tui: {
            showToast: async () => ({}),
          },
          session: {
            messages: async () => ({ data: messages }),
            promptAsync: async (args: {
              path?: { id: string }
              body?: { agent?: string }
            }) => {
              promptAsyncCalls.push({
                sessionID: args.path?.id ?? "",
                agent: args.body?.agent,
              })
              return {}
            },
            abort: async (args: { path: { id: string } }) => {
              abortCalls.push(args.path.id)
              return {}
            },
          },
        },
        directory: "/test/dir",
      },
      {
        config: createMockConfig({ timeout_seconds: 30 }),
        pluginConfig: createPluginConfig(),
        session_timeout_ms: 20,
      },
    )

    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "user-1",
            sessionID,
            role: "user",
            agent: "Prometheus (Plan Builder)",
            model: {
              providerID: "anthropic",
              modelID: "claude-opus-4-6",
            },
          },
        },
      },
    })

    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "assistant-1",
            sessionID,
            role: "assistant",
            agent: "Prometheus (Plan Builder)",
            model: {
              providerID: "anthropic",
              modelID: "claude-opus-4-6",
            },
            message: "Plan is complete.",
          },
        },
      },
    })

    await hook.event({
      event: {
        type: "session.idle",
        properties: { sessionID },
      },
    })

    messages = [
      { info: { role: "user" }, parts: [{ type: "text", text: "plan the work" }] },
      { info: { role: "assistant" }, parts: [{ type: "text", text: "Plan is complete." }] },
      { info: { role: "user" }, parts: [{ type: "text", text: "now continue with implementation" }] },
    ]

    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "user-2",
            sessionID,
            role: "user",
            agent: "Prometheus (Plan Builder)",
            model: {
              providerID: "anthropic",
              modelID: "claude-opus-4-6",
            },
          },
        },
      },
    })

    jest.advanceTimersByTime(70)
    await Promise.resolve()
    await Promise.resolve()

    expect(abortCalls).toEqual([])
    expect(promptAsyncCalls).toHaveLength(0)

    jest.advanceTimersByTime(20)
    await Promise.resolve()
    await Promise.resolve()

    expect(abortCalls).toEqual([sessionID])
    expect(promptAsyncCalls).toHaveLength(1)
    expect(promptAsyncCalls[0]).toEqual({
      sessionID,
      agent: "Prometheus (Plan Builder)",
    })
  })
})
