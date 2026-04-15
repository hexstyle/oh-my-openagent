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

  test("re-arms the watchdog when data_catalog makes mid-stream progress and then stalls", async () => {
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
            tool: "data_catalog",
            state: {
              status: "running",
            },
          },
        },
      },
    })

    jest.advanceTimersByTime(15)
    await Promise.resolve()

    expect(abortCalls).toHaveLength(0)
    expect(retriedModels).toHaveLength(0)

    jest.advanceTimersByTime(70)
    await Promise.resolve()

    expect(abortCalls).toContain(sessionID)
    expect(retriedModels).toContain("openai/gpt-5.4")
    expect(logCalls.some((call) => call.msg.includes("Refreshed session fallback timeout"))).toBe(true)
  })

  test("defers fallback while data_catalog background tasks are still active", async () => {
    const retriedModels: string[] = []
    const abortCalls: string[] = []
    const sessionID = "ses-background-tasks-active"
    let activeTaskStatuses: Array<"pending" | "running"> = ["running"]

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
        backgroundManager: {
          getTasksByParentSession: () => activeTaskStatuses.map((status, index) => ({
            id: `bg-${index}`,
            parentSessionID: sessionID,
            parentMessageID: "msg-1",
            description: "background work",
            prompt: "background work",
            agent: "Sisyphus Junior (Focused Executor)",
            status,
          })),
        },
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

    jest.advanceTimersByTime(70)
    await Promise.resolve()
    await Promise.resolve()

    expect(abortCalls).toHaveLength(0)
    expect(retriedModels).toHaveLength(0)

    activeTaskStatuses = []
    jest.advanceTimersByTime(40)
    await Promise.resolve()
    await Promise.resolve()

    expect(abortCalls).toContain(sessionID)
    expect(retriedModels).toContain("openai/gpt-5.4")
  })

  test("extends the quiet window when the session is still running but Anthropic has not produced a first token yet", async () => {
    const retriedModels: string[] = []
    const abortCalls: string[] = []
    const sessionID = "ses-active-without-first-token"

    const hook = createRuntimeFallbackHook(
      {
        client: {
          tui: {
            showToast: async () => ({}),
          },
          session: {
            messages: async () => ({
              data: [
                { info: { role: "user" }, parts: [{ type: "text", text: "Reply with OK only." }] },
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
        type: "session.status",
        properties: {
          sessionID,
          agent: "Prometheus (Plan Builder)",
          model: "anthropic/claude-opus-4-6",
          status: {
            type: "running",
            message: "Still working",
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

    expect(abortCalls).toHaveLength(0)
    expect(retriedModels).toHaveLength(0)

    jest.advanceTimersByTime(60)
    await Promise.resolve()

    expect(abortCalls).toContain(sessionID)
    expect(retriedModels).toContain("openai/gpt-5.4")
  })

  test("extends the quiet window on a second empty assistant update before the first token arrives", async () => {
    const retriedModels: string[] = []
    const abortCalls: string[] = []
    const sessionID = "ses-second-empty-assistant-update"

    const hook = createRuntimeFallbackHook(
      {
        client: {
          tui: {
            showToast: async () => ({}),
          },
          session: {
            messages: async () => ({
              data: [
                { info: { role: "user" }, parts: [{ type: "text", text: "Reply with OK only." }] },
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

    expect(abortCalls).toHaveLength(0)
    expect(retriedModels).toHaveLength(0)

    jest.advanceTimersByTime(60)
    await Promise.resolve()

    expect(abortCalls).toContain(sessionID)
    expect(retriedModels).toContain("openai/gpt-5.4")
  })

  test("does not keep extending the watchdog on repeated active session.status pulses without new assistant progress", async () => {
    const retriedModels: string[] = []
    const abortCalls: string[] = []
    const sessionID = "ses-repeated-active-status-without-progress"

    const hook = createRuntimeFallbackHook(
      {
        client: {
          tui: {
            showToast: async () => ({}),
          },
          session: {
            messages: async () => ({
              data: [
                { info: { role: "user" }, parts: [{ type: "text", text: "Reply with OK only." }] },
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
        type: "session.status",
        properties: {
          sessionID,
          agent: "Prometheus (Plan Builder)",
          model: "anthropic/claude-opus-4-6",
          status: {
            type: "running",
            message: "Still working",
          },
        },
      },
    })

    jest.advanceTimersByTime(30)
    await hook.event({
      event: {
        type: "session.status",
        properties: {
          sessionID,
          agent: "Prometheus (Plan Builder)",
          model: "anthropic/claude-opus-4-6",
          status: {
            type: "running",
            message: "Still working",
          },
        },
      },
    })

    jest.advanceTimersByTime(45)
    await Promise.resolve()

    expect(abortCalls).toHaveLength(0)
    expect(retriedModels).toHaveLength(0)

    jest.advanceTimersByTime(10)
    await Promise.resolve()

    expect(abortCalls).toContain(sessionID)
    expect(retriedModels).toContain("openai/gpt-5.4")
  })

  test("treats compaction as meaningful progress and gives it a longer quiet window", async () => {
    const retriedModels: string[] = []
    const abortCalls: string[] = []
    const sessionID = "ses-compaction-progress"

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
            type: "compaction",
          },
        },
      },
    })

    jest.advanceTimersByTime(15)
    await Promise.resolve()

    expect(abortCalls).toHaveLength(0)
    expect(retriedModels).toHaveLength(0)

    jest.advanceTimersByTime(70)
    await Promise.resolve()

    expect(abortCalls).toContain(sessionID)
    expect(retriedModels).toContain("openai/gpt-5.4")
  })

  for (const toolName of ["write", "apply_patch"]) {
    test(`extends the quiet window for a long-running ${toolName} tool call`, async () => {
      const retriedModels: string[] = []
      const abortCalls: string[] = []
      const sessionID = `ses-long-tool-${toolName}`

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
              tool: toolName,
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

      jest.advanceTimersByTime(60)
      await Promise.resolve()

      expect(abortCalls).toContain(sessionID)
      expect(retriedModels).toContain("openai/gpt-5.4")
    })
  }

  for (const toolName of ["write", "apply_patch", "todowrite"]) {
    test(`extends the quiet window after ${toolName} errors and the model needs time to regroup`, async () => {
      const retriedModels: string[] = []
      const abortCalls: string[] = []
      const sessionID = `ses-tool-regroup-${toolName}`

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
              tool: toolName,
              state: {
                status: "error",
              },
            },
          },
        },
      })

      jest.advanceTimersByTime(70)
      await Promise.resolve()
      await Promise.resolve()

      expect(abortCalls).toHaveLength(0)
      expect(retriedModels).toHaveLength(0)

      jest.advanceTimersByTime(40)
      await Promise.resolve()
      await Promise.resolve()

      expect(abortCalls).toContain(sessionID)
      expect(retriedModels).toContain("openai/gpt-5.4")
    })
  }

  for (const toolName of ["read", "write", "apply_patch"]) {
    test(`extends the quiet window when ${toolName} starts through tool.execute.before`, async () => {
      const retriedModels: string[] = []
      const abortCalls: string[] = []
      const sessionID = `ses-tool-before-${toolName}`

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
          type: "tool.execute.before",
          properties: {
            sessionID,
            tool: toolName,
            agent: "Prometheus (Plan Builder)",
          },
        },
      })

      jest.advanceTimersByTime(25)
      await Promise.resolve()

      expect(abortCalls).toHaveLength(0)
      expect(retriedModels).toHaveLength(0)

      jest.advanceTimersByTime(60)
      await Promise.resolve()

      expect(abortCalls).toContain(sessionID)
      expect(retriedModels).toContain("openai/gpt-5.4")
    })
  }

  test("queues the timeout fallback retry before aborting the stalled request", async () => {
    const retryModels: string[] = []
    const abortCalls: string[] = []
    const sessionID = "ses-timeout-queue-before-abort"
    let abortCompleted = false

    const hook = createRuntimeFallbackHook(
      {
        client: {
          tui: {
            showToast: async () => ({}),
          },
          session: {
            messages: async () => ({
              data: [
                { info: { role: "user" }, parts: [{ type: "text", text: "Reply with OK only." }] },
              ],
            }),
            promptAsync: async (args: {
              body?: { model?: { providerID?: string; modelID?: string } }
            }) => {
              if (abortCompleted) {
                throw new Error("follow-up retry was scheduled after abort completed")
              }
              const model = args.body?.model
              if (model?.providerID && model?.modelID) {
                retryModels.push(`${model.providerID}/${model.modelID}`)
              }
              return {}
            },
            abort: async (args: { path: { id: string } }) => {
              abortCalls.push(args.path.id)
              abortCompleted = true
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
    expect(retryModels).toContain("openai/gpt-5.4")
  })

  test("gives a fallback-resumed session a long pre-first-token window before timing out again", async () => {
    const retryModels: string[] = []
    const abortCalls: string[] = []
    const sessionID = "ses-fallback-resume-pre-first-token"

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
                retryModels.push(`${model.providerID}/${model.modelID}`)
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
        type: "session.error",
        properties: {
          sessionID,
          agent: "Prometheus (Plan Builder)",
          model: {
            providerID: "anthropic",
            modelID: "claude-opus-4-6",
          },
          error: {
            name: "ProviderRateLimitError",
            message: "429 too many requests",
          },
        },
      },
    })

    expect(retryModels).toEqual(["openai/gpt-5.4"])

    jest.advanceTimersByTime(25)
    await Promise.resolve()

    expect(abortCalls).toHaveLength(0)
    expect(retryModels).toEqual(["openai/gpt-5.4"])

    jest.advanceTimersByTime(60)
    await Promise.resolve()

    expect(abortCalls).toContain(sessionID)
    expect(retryModels.length).toBeGreaterThan(1)
  })
})
