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
        atlas: {
          model: "anthropic/claude-opus-4-6",
          fallback_models: [
            "anthropic/claude-opus-4-6",
            "openai/gpt-5.4",
            "anthropic/claude-sonnet-4-6",
          ],
        },
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

  test("aborts the stale initial request before dispatching a timeout-driven same-session fallback", async () => {
    const callOrder: string[] = []
    const sessionID = "ses-initial-hang-abort-before-retry"

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
                callOrder.push(`prompt:${model.providerID}/${model.modelID}`)
              }
              return {}
            },
            abort: async (args: { path: { id: string } }) => {
              callOrder.push(`abort:${args.path.id}`)
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

    expect(callOrder).toEqual([
      `abort:${sessionID}`,
      "prompt:openai/gpt-5.4",
    ])
  })

  test("extends the initial quiet window for an Anthropic user turn before the first token arrives", async () => {
    const retriedModels: string[] = []
    const abortCalls: string[] = []
    const sessionID = "ses-initial-anthropic-no-first-token"

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

    jest.advanceTimersByTime(70)
    await Promise.resolve()
    await Promise.resolve()

    expect(abortCalls).toHaveLength(0)
    expect(retriedModels).toHaveLength(0)

    jest.advanceTimersByTime(20)
    await Promise.resolve()
    await Promise.resolve()

    expect(abortCalls).toContain(sessionID)
    expect(retriedModels).toContain("openai/gpt-5.4")
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

  test("defers fallback while Flare child sessions are still busy even without active background task records", async () => {
    const retriedModels: string[] = []
    const abortCalls: string[] = []
    const sessionID = "ses-flare-active-child-session"
    const childSessionID = "ses-flare-child-session"
    let childStatus: "busy" | "idle" = "busy"

    const hook = createRuntimeFallbackHook(
      {
        client: {
          tui: {
            showToast: async () => ({}),
          },
          session: {
            children: async (args: { path: { id: string } }) =>
              args.path.id === sessionID
                ? { data: [{ id: childSessionID }] }
                : { data: [] },
            status: async () => ({
              data: {
                [sessionID]: { type: "idle" },
                [childSessionID]: { type: childStatus },
              },
            }),
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
            agent: "Atlas (Plan Executor)",
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
            agent: "Atlas (Plan Executor)",
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
    await Promise.resolve()

    expect(abortCalls).toHaveLength(0)
    expect(retriedModels).toHaveLength(0)
    expect(logCalls.some((call) => call.msg.includes("descendant sessions are active"))).toBe(true)

    childStatus = "idle"
    jest.advanceTimersByTime(90)
    await Promise.resolve()
    await Promise.resolve()

    expect(abortCalls).toContain(sessionID)
    expect(retriedModels).toContain("openai/gpt-5.4")
  })

  test("does not keep deferring fallback when a child status is stale busy but the child already completed", async () => {
    const retriedModels: string[] = []
    const abortCalls: string[] = []
    const sessionID = "ses-flare-stale-child-parent"
    const childSessionID = "ses-flare-stale-child"

    const hook = createRuntimeFallbackHook(
      {
        client: {
          tui: {
            showToast: async () => ({}),
          },
          session: {
            children: async (args: { path: { id: string } }) =>
              args.path.id === sessionID
                ? { data: [{ id: childSessionID }] }
                : { data: [] },
            status: async () => ({
              data: {
                [sessionID]: { type: "idle" },
                [childSessionID]: { type: "running" },
              },
            }),
            messages: async (args?: { path?: { id: string } }) => {
              if (args?.path?.id === childSessionID) {
                return {
                  data: [
                    { info: { id: "msg_001", role: "user" }, parts: [{ type: "text", text: "do work" }] },
                    { info: { id: "msg_002", role: "assistant", finish: "stop" }, parts: [{ type: "text", text: "done" }] },
                  ],
                }
              }

              return {
                data: [
                  { info: { id: "msg_101", role: "user" }, parts: [{ type: "text", text: "continue" }] },
                  { info: { id: "msg_102", role: "assistant" }, parts: [] },
                ],
              }
            },
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
            agent: "Atlas (Plan Executor)",
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
            agent: "Atlas (Plan Executor)",
            model: {
              providerID: "anthropic",
              modelID: "claude-opus-4-6",
            },
          },
        },
      },
    })

    jest.advanceTimersByTime(40)
    await Promise.resolve()
    await Promise.resolve()

    expect(abortCalls).toContain(sessionID)
    expect(retriedModels).toContain("openai/gpt-5.4")
    expect(logCalls.some((call) => call.msg.includes("descendant sessions are active"))).toBe(false)
  })

  test("does not abort Flare delegation while task tool is still pending", async () => {
    const retriedModels: string[] = []
    const abortCalls: string[] = []
    const sessionID = "ses-flare-task-pending"

    const hook = createRuntimeFallbackHook(
      {
        client: {
          tui: {
            showToast: async () => ({}),
          },
          session: {
            messages: async () => ({
              data: [
                { info: { role: "user" }, parts: [{ type: "text", text: "/start-work" }] },
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
            agent: "Atlas (Plan Executor)",
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
        type: "message.part.updated",
        properties: {
          info: {
            sessionID,
            role: "assistant",
            agent: "Atlas (Plan Executor)",
            model: {
              providerID: "anthropic",
              modelID: "claude-opus-4-6",
            },
          },
          part: {
            sessionID,
            type: "tool",
            tool: "task",
            state: { status: "pending" },
          },
        },
      },
    })

    jest.advanceTimersByTime(25)
    await Promise.resolve()
    await Promise.resolve()

    expect(abortCalls).toHaveLength(0)
    expect(retriedModels).toHaveLength(0)

    jest.advanceTimersByTime(60)
    await Promise.resolve()
    await Promise.resolve()

    expect(abortCalls).toContain(sessionID)
    expect(retriedModels).toContain("openai/gpt-5.4")
    expect(
      logCalls.some((call) =>
        call.msg.includes("Refreshed fallback timeout after assistant progress")
        && (call.data as { toolName?: string; timeoutMsOverride?: number } | undefined)?.toolName === "task"
        && (call.data as { toolName?: string; timeoutMsOverride?: number } | undefined)?.timeoutMsOverride === 80,
      ),
    ).toBe(true)
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

  test("keeps the watchdog armed when a visible assistant update arrives while the session is still running", async () => {
    const retriedModels: string[] = []
    const abortCalls: string[] = []
    const sessionID = "ses-visible-assistant-while-running"

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
            message: "Streaming partial output",
          },
        },
      },
    })

    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg-visible-progress",
            sessionID,
            role: "assistant",
            message: "I found the first issue and am still working through the rest.",
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

  test("extends the quiet window when a new assistant step starts before the next token arrives", async () => {
    const retriedModels: string[] = []
    const abortCalls: string[] = []
    const sessionID = "ses-step-start-progress"

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
            type: "step-start",
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

  test("does not keep extending the watchdog on repeated reasoning-only churn after a step starts", async () => {
    const retriedModels: string[] = []
    const abortCalls: string[] = []
    const sessionID = "ses-reasoning-churn-after-step-start"

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
            type: "step-start",
          },
        },
      },
    })

    for (let index = 0; index < 5; index += 1) {
      jest.advanceTimersByTime(15)
      await hook.event({
        event: {
          type: "message.part.updated",
          properties: {
            part: {
              sessionID,
              type: "reasoning",
              text: `still thinking ${index}`,
            },
          },
        },
      })
    }

    expect(abortCalls).toHaveLength(0)
    expect(retriedModels).toHaveLength(0)

    jest.advanceTimersByTime(15)
    await Promise.resolve()
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

  test("dispatches the timeout fallback retry after aborting the stalled request", async () => {
    const callOrder: string[] = []
    const sessionID = "ses-timeout-queue-before-abort"

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
                callOrder.push(`prompt:${model.providerID}/${model.modelID}`)
              }
              return {}
            },
            abort: async (args: { path: { id: string } }) => {
              callOrder.push(`abort:${args.path.id}`)
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

    expect(callOrder).toEqual([
      `abort:${sessionID}`,
      "prompt:openai/gpt-5.4",
    ])
  })

  test("omits the agent when timeout fallback switches Prometheus off its primary model", async () => {
    const retryCalls: Array<{ model?: string; agent?: string }> = []
    const sessionID = "ses-timeout-omit-agent-on-distinct-fallback"

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
              body?: {
                agent?: string
                model?: { providerID?: string; modelID?: string }
              }
            }) => {
              const model = args.body?.model
              retryCalls.push({
                model: model?.providerID && model?.modelID
                  ? `${model.providerID}/${model.modelID}`
                  : undefined,
                agent: args.body?.agent,
              })
              return {}
            },
            abort: async () => ({}),
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

    expect(retryCalls).toContainEqual({
      model: "openai/gpt-5.4",
      agent: undefined,
    })
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
