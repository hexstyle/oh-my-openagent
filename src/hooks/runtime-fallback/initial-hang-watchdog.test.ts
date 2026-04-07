import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test"
import type { OhMyOpenCodeConfig, RuntimeFallbackConfig } from "../../config"
import { createRuntimeFallbackHook } from "./hook"
import * as sharedModule from "../../shared"

describe("runtime-fallback initial hang watchdog", () => {
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
      git_master: {
        commit_footer: true,
        include_co_authored_by: true,
        git_env_prefix: "GIT_MASTER=1",
      },
      agents: {
        prometheus: {
          model: "anthropic/claude-opus-4-6",
          fallback_models: [
            "anthropic/claude-opus-4-6",
            "openai/gpt-5.4",
            "anthropic/claude-sonnet-4-6",
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

  test("falls back when a resumed session creates an empty assistant turn and then stalls", async () => {
    const retriedModels: string[] = []
    const abortCalls: string[] = []
    const sessionID = "ses-initial-hang"

    const hook = createRuntimeFallbackHook(
      {
        client: {
          tui: {
            showToast: async () => ({}),
          },
          session: {
            messages: async () => ({
              data: [
                { info: { role: "user" }, parts: [{ type: "text", text: "continue" }] },
                { info: { role: "assistant" }, parts: [] },
              ],
            }),
            promptAsync: async (args: {
              body?: { model?: { providerID?: string; modelID?: string } }
            }) => {
              const model = args.body?.model
              if (model?.providerID && model?.modelID) {
                retriedModels.push(`${model.providerID}/${model.modelID}`)
              }
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

    jest.advanceTimersByTime(25)
    await Promise.resolve()

    expect(abortCalls).toContain(sessionID)
    expect(retriedModels).toContain("openai/gpt-5.4")
    expect(logCalls.some((call) => call.msg.includes("Armed session fallback timeout"))).toBe(true)
    expect(logCalls.some((call) => call.msg.includes("Session fallback timeout reached"))).toBe(true)
  })

  test("refreshes the watchdog on assistant part progress and delays timeout", async () => {
    const retriedModels: string[] = []
    const abortCalls: string[] = []
    const sessionID = "ses-progress-refresh"

    const hook = createRuntimeFallbackHook(
      {
        client: {
          tui: {
            showToast: async () => ({}),
          },
          session: {
            messages: async () => ({
              data: [
                { info: { role: "user" }, parts: [{ type: "text", text: "continue" }] },
              ],
            }),
            promptAsync: async (args: {
              body?: { model?: { providerID?: string; modelID?: string } }
            }) => {
              const model = args.body?.model
              if (model?.providerID && model?.modelID) {
                retriedModels.push(`${model.providerID}/${model.modelID}`)
              }
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

    jest.advanceTimersByTime(10)
    await hook.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            sessionID,
            type: "tool",
            state: {
              status: "running",
            },
          },
        },
      },
    })

    jest.advanceTimersByTime(25)
    await Promise.resolve()

    expect(abortCalls).toHaveLength(0)
    expect(retriedModels).toHaveLength(0)
    expect(logCalls.some((call) => call.msg.includes("Cleared fallback timeout after assistant progress"))).toBe(true)
  })
})
