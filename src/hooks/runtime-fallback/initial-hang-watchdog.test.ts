import { afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test"
import type { OhMyOpenCodeConfig, RuntimeFallbackConfig } from "../../config"
import { createRuntimeFallbackHook } from "./hook"
import { createFallbackState } from "./fallback-state"
import * as sharedModule from "../../shared"
import { clearSessionTools, setSessionFlag } from "../../shared/session-tools-store"

describe("runtime-fallback initial hang watchdog", () => {
  let logCalls: Array<{ msg: string; data?: unknown }>
  let logSpy: ReturnType<typeof spyOn>
  const jestTimers = jest as unknown as { advanceTimersByTimeAsync?: (ms: number) => Promise<void> }

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
    clearSessionTools()
  })

  test("opens a fresh same-model handoff when a paid planner session stalls on its first turn", async () => {
    const createCalls: Array<unknown> = []
    const promptCalls: Array<unknown> = []
    const sessionID = "ses-initial-hang"

    const hook = createRuntimeFallbackHook(
      {
        client: {
          tui: {
            showToast: async () => ({}),
          },
          session: {
            create: async (args) => {
              createCalls.push(args)
              return { data: { id: "ses-fresh-timeout-child" } }
            },
            messages: async () => ({
              data: [
                { info: { role: "user" }, parts: [{ type: "text", text: "continue" }] },
                { info: { role: "assistant" }, parts: [] },
              ],
            }),
            promptAsync: async (args) => {
              promptCalls.push(args)
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
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(createCalls).toHaveLength(1)
    expect(
      (createCalls[0] as { body?: { parentID?: string; title?: string } }).body,
    ).toEqual({
      parentID: sessionID,
      title: "[runtime-fallback] Scoped Fallback: claude-opus-4-6",
    })
    expect(promptCalls).toHaveLength(1)
    expect(
      (promptCalls[0] as { path?: { id?: string } }).path?.id,
    ).toBe("ses-fresh-timeout-child")
    expect(
      (promptCalls[0] as { body?: { model?: { providerID?: string; modelID?: string } } }).body?.model,
    ).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-4-6",
    })
    expect(logCalls.some((call) => call.msg.includes("Armed session fallback timeout"))).toBe(true)
  })

  test("opens the same fresh timeout handoff for stalled paid codex/openai planners", async () => {
    const createCalls: Array<unknown> = []
    const promptCalls: Array<unknown> = []
    const sessionID = "ses-initial-hang-openai"

    const hook = createRuntimeFallbackHook(
      {
        client: {
          tui: {
            showToast: async () => ({}),
          },
          session: {
            create: async (args) => {
              createCalls.push(args)
              return { data: { id: "ses-openai-fresh-timeout-child" } }
            },
            messages: async () => ({
              data: [
                { info: { role: "user" }, parts: [{ type: "text", text: "continue" }] },
                { info: { role: "assistant" }, parts: [] },
              ],
            }),
            promptAsync: async (args) => {
              promptCalls.push(args)
              return {}
            },
            abort: async () => ({}),
          },
        },
        directory: "/test/dir",
      },
      {
        config: createMockConfig({ timeout_seconds: 30 }),
        pluginConfig: {
          ...createPluginConfig(),
          agents: {
            ...createPluginConfig().agents,
            prometheus: {
              model: "openai/gpt-5.4",
              fallback_models: [
                "openai/gpt-5.4",
                "anthropic/claude-sonnet-4-6",
                "openai/gpt-5.3-codex-spark",
              ],
            },
          },
        },
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
              providerID: "openai",
              modelID: "gpt-5.4",
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
              providerID: "openai",
              modelID: "gpt-5.4",
            },
          },
        },
      },
    })

    jest.advanceTimersByTime(25)
    await Promise.resolve()

    expect(createCalls).toHaveLength(1)
    expect(
      (promptCalls[0] as { path?: { id?: string } }).path?.id,
    ).toBe("ses-openai-fresh-timeout-child")
    expect(
      (promptCalls[0] as { body?: { model?: { providerID?: string; modelID?: string } } }).body?.model,
    ).toEqual({
      providerID: "openai",
      modelID: "gpt-5.4",
    })
  })

  test("retries a stalled Prometheus final-plan promotion in the same session before spawning a scoped child", async () => {
    const createCalls: Array<unknown> = []
    const promptCalls: Array<unknown> = []
    const abortCalls: string[] = []
    const sessionID = "ses-prometheus-plan-promotion"
    const draftPath = "/test/dir/.sisyphus/drafts/ci-green-final.md"
    const finalPath = "/test/dir/.sisyphus/plans/ci-green-final.md"

    const hook = createRuntimeFallbackHook(
      {
        client: {
          tui: {
            showToast: async () => ({}),
          },
          session: {
            create: async (args) => {
              createCalls.push(args)
              return { data: { id: "ses-unexpected-nested-child" } }
            },
            messages: async () => ({
              data: [
                { info: { role: "user" }, parts: [{ type: "text", text: "update the plan" }] },
                {
                  info: { role: "assistant", finish: "tool-calls" },
                  parts: [
                    {
                      type: "tool",
                      tool: "write",
                      state: {
                        status: "completed",
                        input: { filePath: draftPath },
                      },
                    },
                    {
                      type: "tool",
                      tool: "todowrite",
                      state: { status: "completed" },
                    },
                  ],
                },
                {
                  info: { role: "assistant" },
                  parts: [
                    { type: "step-start" },
                    { type: "text", text: "Now I'll write the complete final plan." },
                    {
                      type: "tool",
                      tool: "write",
                      state: {
                        status: "pending",
                        input: {},
                        raw: "",
                      },
                    },
                  ],
                },
              ],
            }),
            promptAsync: async (args) => {
              promptCalls.push(args)
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
          info: {
            sessionID,
            role: "assistant",
            agent: "Prometheus (Plan Builder)",
            model: {
              providerID: "anthropic",
              modelID: "claude-opus-4-6",
            },
          },
          part: {
            sessionID,
            type: "tool",
            tool: "write",
            state: {
              status: "pending",
              input: {},
              raw: "",
            },
          },
        },
      },
    })

    const state = hook._deps?.sessionStates.get(sessionID)
    if (state) {
      state.resolvedAgent = "Prometheus (Plan Builder)"
      state.lastMeaningfulProgressAt = Date.now() - 10 * 60 * 1000
      state.longRunningProgressUntil = 0
    }

    if (typeof jestTimers.advanceTimersByTimeAsync === "function") {
      await jestTimers.advanceTimersByTimeAsync(81)
    } else {
      jest.advanceTimersByTime(81)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    }

    expect(createCalls).toHaveLength(0)
    expect(promptCalls).toHaveLength(1)
    expect(abortCalls.length).toBeLessThanOrEqual(1)
    expect((promptCalls[0] as { path?: { id?: string } }).path?.id).toBe(sessionID)
    expect(
      (promptCalls[0] as { body?: { model?: { providerID?: string; modelID?: string } } }).body?.model,
    ).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-4-6",
    })
    const retryText = ((promptCalls[0] as {
      body?: { parts?: Array<{ text?: string }> }
    }).body?.parts?.[0]?.text) ?? ""
    expect(retryText).toContain("Plan promotion retry")
    expect(retryText).toContain(draftPath)
    expect(retryText).toContain(finalPath)
    expect(retryText).toContain("Do NOT use write tool")
    expect(retryText).toContain("cp '")
    expect(
      logCalls.some((call) => call.msg.includes("Retrying stalled Prometheus final-plan promotion in the same session")),
    ).toBe(true)
  })

  test("does not loop the same Prometheus final-plan promotion retry forever without new progress", async () => {
    const createCalls: Array<unknown> = []
    const promptCalls: Array<unknown> = []
    const abortCalls: string[] = []
    const sessionID = "ses-prometheus-plan-promotion-bounded"
    const draftPath = "/test/dir/.sisyphus/drafts/ci-green-final.md"
    const finalPath = "/test/dir/.sisyphus/plans/ci-green-final.md"

    const hook = createRuntimeFallbackHook(
      {
        client: {
          tui: {
            showToast: async () => ({}),
          },
          session: {
            create: async (args) => {
              createCalls.push(args)
              return { data: { id: "ses-prometheus-plan-promotion-fresh-child" } }
            },
            messages: async () => ({
              data: [
                { info: { role: "user" }, parts: [{ type: "text", text: "update the plan" }] },
                {
                  info: { role: "assistant", finish: "tool-calls" },
                  parts: [
                    {
                      type: "tool",
                      tool: "write",
                      state: {
                        status: "completed",
                        input: { filePath: draftPath },
                      },
                    },
                  ],
                },
                {
                  info: { role: "assistant" },
                  parts: [
                    { type: "step-start" },
                    { type: "text", text: "Now I'll write the complete final plan." },
                    {
                      type: "tool",
                      tool: "write",
                      state: {
                        status: "pending",
                        input: {},
                        raw: "",
                      },
                    },
                  ],
                },
              ],
            }),
            promptAsync: async (args) => {
              promptCalls.push(args)
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

    await hook.event({
      event: {
        type: "message.part.updated",
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
          part: {
            sessionID,
            type: "tool",
            tool: "write",
            state: {
              status: "pending",
              input: {},
              raw: "",
            },
          },
        },
      },
    })

    const state = hook._deps?.sessionStates.get(sessionID)
    if (state) {
      state.resolvedAgent = "Prometheus (Plan Builder)"
      state.lastMeaningfulProgressAt = Date.now() - 10 * 60 * 1000
      state.longRunningProgressUntil = 0
    }

    if (typeof jestTimers.advanceTimersByTimeAsync === "function") {
      await jestTimers.advanceTimersByTimeAsync(81)
    } else {
      jest.advanceTimersByTime(81)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    }

    expect(createCalls).toHaveLength(0)
    expect(promptCalls).toHaveLength(1)
    expect((promptCalls[0] as { path?: { id?: string } }).path?.id).toBe(sessionID)

    if (typeof jestTimers.advanceTimersByTimeAsync === "function") {
      await jestTimers.advanceTimersByTimeAsync(81)
    } else {
      jest.advanceTimersByTime(81)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    }

    expect(createCalls).toHaveLength(1)
    expect(promptCalls).toHaveLength(2)
    expect((promptCalls[1] as { path?: { id?: string } }).path?.id).toBe("ses-prometheus-plan-promotion-fresh-child")
    expect(abortCalls.length).toBeGreaterThanOrEqual(1)
    expect(
      logCalls.some((call) => call.msg.includes("Skipping repeated Prometheus final-plan promotion retry without new progress")),
    ).toBe(true)
    expect(
      logCalls.filter((call) => call.msg.includes("Retrying stalled Prometheus final-plan promotion in the same session")).length,
    ).toBe(1)
  })

  test("retries a stalled Prometheus final-plan promotion inside a scoped child without nesting another child", async () => {
    const createCalls: Array<unknown> = []
    const promptCalls: Array<unknown> = []
    const abortCalls: string[] = []
    const sessionID = "ses-prometheus-plan-promotion-child"
    const draftPath = "/test/dir/.sisyphus/drafts/ci-green-final.md"
    const finalPath = "/test/dir/.sisyphus/plans/ci-green-final.md"

    const hook = createRuntimeFallbackHook(
      {
        client: {
          tui: {
            showToast: async () => ({}),
          },
          session: {
            create: async (args) => {
              createCalls.push(args)
              return { data: { id: "ses-unexpected-grandchild" } }
            },
            get: async () => ({
              data: {
                directory: "/test/dir",
                parentID: "ses-prometheus-plan-parent",
              },
            }),
            messages: async () => ({
              data: [
                { info: { role: "user" }, parts: [{ type: "text", text: "continue the plan" }] },
                {
                  info: { role: "assistant", finish: "tool-calls" },
                  parts: [
                    {
                      type: "tool",
                      tool: "write",
                      state: {
                        status: "completed",
                        input: { filePath: draftPath },
                      },
                    },
                    {
                      type: "tool",
                      tool: "todowrite",
                      state: { status: "completed" },
                    },
                  ],
                },
                {
                  info: { role: "assistant" },
                  parts: [
                    { type: "step-start" },
                    { type: "text", text: "Promoting the final plan now." },
                    {
                      type: "tool",
                      tool: "write",
                      state: {
                        status: "pending",
                        input: {},
                        raw: "",
                      },
                    },
                  ],
                },
              ],
            }),
            promptAsync: async (args) => {
              promptCalls.push(args)
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
        type: "session.created",
        properties: {
          info: {
            id: sessionID,
            title: "[runtime-fallback] Scoped Fallback: claude-opus-4-6",
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
          info: {
            sessionID,
            role: "assistant",
            agent: "Prometheus (Plan Builder)",
            model: {
              providerID: "anthropic",
              modelID: "claude-opus-4-6",
            },
          },
          part: {
            sessionID,
            type: "tool",
            tool: "write",
            state: {
              status: "pending",
              input: {},
              raw: "",
            },
          },
        },
      },
    })

    const state = hook._deps?.sessionStates.get(sessionID)
    if (state) {
      state.resolvedAgent = "Prometheus (Plan Builder)"
      state.lastMeaningfulProgressAt = Date.now() - 10 * 60 * 1000
      state.longRunningProgressUntil = 0
    }

    if (typeof jestTimers.advanceTimersByTimeAsync === "function") {
      await jestTimers.advanceTimersByTimeAsync(81)
    } else {
      jest.advanceTimersByTime(81)
      await Promise.resolve()
      await Promise.resolve()
    }

    expect(createCalls).toHaveLength(0)
    expect(promptCalls).toHaveLength(1)
    expect(abortCalls.length).toBeLessThanOrEqual(1)
    expect((promptCalls[0] as { path?: { id?: string } }).path?.id).toBe(sessionID)
    const retryText = ((promptCalls[0] as {
      body?: { parts?: Array<{ text?: string }> }
    }).body?.parts?.[0]?.text) ?? ""
    expect(retryText).toContain(draftPath)
    expect(retryText).toContain(finalPath)
    expect(retryText).toContain("Do NOT use write tool")
  })

  test("still opens a fresh same-model handoff when timeout-side session.messages inspection fails", async () => {
    const createCalls: Array<unknown> = []
    const promptCalls: Array<unknown> = []
    const sessionID = "ses-initial-hang-messages-timeout"

    const hook = createRuntimeFallbackHook(
      {
        client: {
          tui: {
            showToast: async () => ({}),
          },
          session: {
            create: async (args) => {
              createCalls.push(args)
              return { data: { id: "ses-fresh-timeout-after-messages-hang" } }
            },
            messages: async () => {
              throw new Error("messages unavailable")
            },
            promptAsync: async (args) => {
              promptCalls.push(args)
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
        session_messages_request_timeout_ms: 5,
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

    jest.advanceTimersByTime(30)
    await Promise.resolve()
    await Promise.resolve()

    expect(createCalls).toHaveLength(1)
    expect(
      (promptCalls[0] as { path?: { id?: string } }).path?.id,
    ).toBe("ses-fresh-timeout-after-messages-hang")
    expect(logCalls.some((call) => call.msg.includes("Failed to fetch session messages"))).toBe(true)
  })

  test("counts the initial timeout wait against the fresh same-model retry budget for stalled paid planners", async () => {
    const createCalls: Array<unknown> = []
    const promptCalls: Array<unknown> = []
    const sessionID = "ses-initial-hang-budget-backdated"

    const hook = createRuntimeFallbackHook(
      {
        client: {
          tui: {
            showToast: async () => ({}),
          },
          session: {
            create: async (args) => {
              createCalls.push(args)
              return { data: { id: "ses-budget-backdated-child" } }
            },
            messages: async () => ({
              data: [
                { info: { role: "user" }, parts: [{ type: "text", text: "continue" }] },
                { info: { role: "assistant" }, parts: [] },
              ],
            }),
            promptAsync: async (args) => {
              promptCalls.push(args)
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
    await Promise.resolve()

    const rootState = hook._deps?.sessionStates.get(sessionID)
    expect(createCalls).toHaveLength(1)
    expect(promptCalls).toHaveLength(1)
    expect(rootState?.freshSameModelRetryCount).toBe(1)
    expect(rootState?.freshSameModelRetryStartedAt).toBeDefined()
    expect(Date.now() - (rootState?.freshSameModelRetryStartedAt ?? Date.now())).toBeGreaterThanOrEqual(80)
  })

  test("restarts a stalled scoped paid child on the same model under the original parent session", async () => {
    const createCalls: Array<unknown> = []
    const callOrder: string[] = []
    const sessionID = "ses-initial-hang-abort-before-retry"
    const rootSessionID = "ses-initial-hang-abort-before-retry-root"

    const hook = createRuntimeFallbackHook(
      {
        client: {
          tui: {
            showToast: async () => ({}),
          },
          session: {
            create: async (args) => {
              createCalls.push(args)
              return { data: { id: "ses-nested-fresh-child" } }
            },
            get: async () => ({
              data: {
                directory: "/test/dir",
                parentID: rootSessionID,
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
        type: "session.created",
        properties: {
          info: {
            id: sessionID,
            title: "[runtime-fallback] Scoped Fallback: claude-opus-4-6",
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

    expect(createCalls).toHaveLength(1)
    expect(
      (createCalls[0] as { body?: { parentID?: string; title?: string } }).body,
    ).toEqual({
      parentID: rootSessionID,
      title: "[runtime-fallback] Scoped Fallback: claude-opus-4-6",
    })
    expect(callOrder[0]).toBe("prompt:anthropic/claude-opus-4-6")
  })

  test("restarts a title-only scoped paid child on the same model under the original parent session", async () => {
    const createCalls: Array<unknown> = []
    const callOrder: string[] = []
    const sessionID = "ses-initial-hang-title-only-scoped-child"
    const rootSessionID = "ses-initial-hang-title-only-scoped-child-root"

    const hook = createRuntimeFallbackHook(
      {
        client: {
          tui: {
            showToast: async () => ({}),
          },
          session: {
            create: async (args) => {
              createCalls.push(args)
              return { data: { id: "ses-should-not-exist" } }
            },
            get: async () => ({
              data: {
                directory: "/test/dir",
                parentID: rootSessionID,
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
        type: "session.created",
        properties: {
          info: {
            id: sessionID,
            title: "[runtime-fallback] Scoped Fallback: claude-opus-4-6",
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

    expect(createCalls).toHaveLength(1)
    expect(
      (createCalls[0] as { body?: { parentID?: string; title?: string } }).body,
    ).toEqual({
      parentID: rootSessionID,
      title: "[runtime-fallback] Scoped Fallback: claude-opus-4-6",
    })
    expect(callOrder[0]).toBe("prompt:anthropic/claude-opus-4-6")
  })

  test("restarts a title-only scoped paid child under the original parent even when session.get loses parentID", async () => {
    const createCalls: Array<unknown> = []
    const callOrder: string[] = []
    const sessionID = "ses-initial-hang-title-only-scoped-child-missing-parent"
    const rootSessionID = "ses-initial-hang-title-only-scoped-child-missing-parent-root"

    const hook = createRuntimeFallbackHook(
      {
        client: {
          tui: {
            showToast: async () => ({}),
          },
          session: {
            create: async (args) => {
              createCalls.push(args)
              return { data: { id: "ses-should-not-exist-missing-parent" } }
            },
            get: async () => ({
              data: {
                directory: "/test/dir",
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
        type: "session.created",
        properties: {
          info: {
            id: sessionID,
            parentID: rootSessionID,
            title: "[runtime-fallback] Scoped Fallback: claude-opus-4-6",
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

    expect(createCalls).toHaveLength(1)
    expect(
      (createCalls[0] as { body?: { parentID?: string; title?: string } }).body,
    ).toEqual({
      parentID: rootSessionID,
      title: "[runtime-fallback] Scoped Fallback: claude-opus-4-6",
    })
    expect(callOrder[0]).toBe("prompt:anthropic/claude-opus-4-6")
  })

  test("advances a title-only scoped paid child to the next paid model once the inherited fresh retry window is exhausted", async () => {
    const createCalls: Array<unknown> = []
    const callOrder: string[] = []
    const sessionID = "ses-initial-hang-title-only-scoped-child-window-exhausted"
    const rootSessionID = "ses-initial-hang-title-only-scoped-child-window-exhausted-root"

    const hook = createRuntimeFallbackHook(
      {
        client: {
          tui: {
            showToast: async () => ({}),
          },
          session: {
            create: async (args) => {
              createCalls.push(args)
              return { data: { id: "ses-should-not-exist-window-exhausted" } }
            },
            get: async () => ({
              data: {
                directory: "/test/dir",
                parentID: rootSessionID,
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

    const rootState = createFallbackState("anthropic/claude-opus-4-6", [
      "openai/gpt-5.4",
      "anthropic/claude-sonnet-4-6",
    ])
    rootState.freshSameModelRetryModelIdentity = "anthropic/claude-opus-4-6"
    rootState.freshSameModelRetryStartedAt = Date.now() - (5 * 60 * 1000) - 1
    rootState.freshSameModelRetryCount = 4
    hook._deps?.sessionStates.set(rootSessionID, rootState)

    await hook.event({
      event: {
        type: "session.created",
        properties: {
          info: {
            id: sessionID,
            title: "[runtime-fallback] Scoped Fallback: claude-opus-4-6",
            parentID: rootSessionID,
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
    await Promise.resolve()

    expect(createCalls).toHaveLength(0)
    expect(callOrder).toEqual([
      `abort:${sessionID}`,
      "prompt:openai/gpt-5.4",
    ])
    expect(hook._deps?.globalModelCooldowns.get("anthropic/claude-opus-4-6")).toBeGreaterThan(Date.now())
  })

  test("restarts a title-only scoped paid codex/openai child on the same model under the original parent session", async () => {
    const createCalls: Array<unknown> = []
    const callOrder: string[] = []
    const sessionID = "ses-initial-hang-title-only-scoped-openai-child"
    const rootSessionID = "ses-initial-hang-title-only-scoped-openai-child-root"

    const hook = createRuntimeFallbackHook(
      {
        client: {
          tui: {
            showToast: async () => ({}),
          },
          session: {
            create: async (args) => {
              createCalls.push(args)
              return { data: { id: "ses-openai-should-not-exist" } }
            },
            get: async () => ({
              data: {
                directory: "/test/dir",
                parentID: rootSessionID,
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
        pluginConfig: {
          ...createPluginConfig(),
          agents: {
            ...createPluginConfig().agents,
            prometheus: {
              model: "openai/gpt-5.4",
              fallback_models: [
                "openai/gpt-5.4",
                "anthropic/claude-sonnet-4-6",
                "openai/gpt-5.3-codex-spark",
              ],
            },
          },
        },
        session_timeout_ms: 20,
      },
    )

    await hook.event({
      event: {
        type: "session.created",
        properties: {
          info: {
            id: sessionID,
            title: "[runtime-fallback] Scoped Fallback: gpt-5.4",
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
            role: "user",
            agent: "Prometheus (Plan Builder)",
            model: {
              providerID: "openai",
              modelID: "gpt-5.4",
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
              providerID: "openai",
              modelID: "gpt-5.4",
            },
          },
        },
      },
    })

    jest.advanceTimersByTime(25)
    await Promise.resolve()

    expect(createCalls).toHaveLength(1)
    expect(
      (createCalls[0] as { body?: { parentID?: string; title?: string } }).body,
    ).toEqual({
      parentID: rootSessionID,
      title: "[runtime-fallback] Scoped Fallback: gpt-5.4",
    })
    expect(callOrder[0]).toBe("prompt:openai/gpt-5.4")
  })

  test("restarts a title-only scoped paid codex/openai child under the original parent even when session.get loses parentID", async () => {
    const createCalls: Array<unknown> = []
    const callOrder: string[] = []
    const sessionID = "ses-initial-hang-title-only-scoped-openai-child-missing-parent"
    const rootSessionID = "ses-initial-hang-title-only-scoped-openai-child-missing-parent-root"

    const hook = createRuntimeFallbackHook(
      {
        client: {
          tui: {
            showToast: async () => ({}),
          },
          session: {
            create: async (args) => {
              createCalls.push(args)
              return { data: { id: "ses-openai-should-not-exist-missing-parent" } }
            },
            get: async () => ({
              data: {
                directory: "/test/dir",
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
        pluginConfig: {
          ...createPluginConfig(),
          agents: {
            ...createPluginConfig().agents,
            prometheus: {
              model: "openai/gpt-5.4",
              fallback_models: [
                "openai/gpt-5.4",
                "anthropic/claude-sonnet-4-6",
                "openai/gpt-5.3-codex-spark",
              ],
            },
          },
        },
        session_timeout_ms: 20,
      },
    )

    await hook.event({
      event: {
        type: "session.created",
        properties: {
          info: {
            id: sessionID,
            parentID: rootSessionID,
            title: "[runtime-fallback] Scoped Fallback: gpt-5.4",
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
            role: "user",
            agent: "Prometheus (Plan Builder)",
            model: {
              providerID: "openai",
              modelID: "gpt-5.4",
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
              providerID: "openai",
              modelID: "gpt-5.4",
            },
          },
        },
      },
    })

    jest.advanceTimersByTime(25)
    await Promise.resolve()

    expect(createCalls).toHaveLength(1)
    expect(
      (createCalls[0] as { body?: { parentID?: string; title?: string } }).body,
    ).toEqual({
      parentID: rootSessionID,
      title: "[runtime-fallback] Scoped Fallback: gpt-5.4",
    })
    expect(callOrder[0]).toBe("prompt:openai/gpt-5.4")
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

  test("defers parent fallback while a scoped child is in timeout recovery even if the child status is temporarily idle", async () => {
    const retriedModels: string[] = []
    const abortCalls: string[] = []
    const sessionID = "ses-flare-child-timeout-parent"
    const childSessionID = "ses-flare-child-timeout-child"

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
                [childSessionID]: { type: "idle" },
              },
            }),
            messages: async () => ({
              data: [
                { info: { id: "msg_201", role: "user" }, parts: [{ type: "text", text: "continue" }] },
                { info: { id: "msg_202", role: "assistant" }, parts: [] },
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

    hook._deps?.sessionTimeoutRecoveryInProgress.add(childSessionID)

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

    expect(abortCalls).toHaveLength(0)
    expect(retriedModels).toHaveLength(0)
    expect(logCalls.some((call) => call.msg.includes("descendant sessions are active"))).toBe(true)
  })

  ;(["task", "call_omo_agent"] as const).forEach((toolName) => {
    test(`grants a short grace window while ${toolName} is still pending in the latest assistant transcript`, async () => {
      const retriedModels: string[] = []
      const abortCalls: string[] = []
      const sessionID = `ses-flare-${toolName}-pending`

      const hook = createRuntimeFallbackHook(
        {
          client: {
            tui: {
              showToast: async () => ({}),
            },
            session: {
              messages: async () => ({
                data: [
                  { info: { id: "msg-user-1", role: "user" }, parts: [{ type: "text", text: "/start-work" }] },
                  {
                    info: { id: "msg-assistant-1", role: "assistant", finish: "tool-calls" },
                    parts: [{ type: "tool", tool: toolName, state: { status: "pending" } }],
                  },
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
              tool: toolName,
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

      jest.advanceTimersByTime(40)
      await Promise.resolve()
      await Promise.resolve()

      expect(abortCalls).toHaveLength(0)
      expect(retriedModels).toHaveLength(0)
      expect(
        logCalls.some((call) =>
          call.msg.includes("Refreshed fallback timeout after assistant progress")
          && (call.data as { toolName?: string; timeoutMsOverride?: number } | undefined)?.toolName === toolName
          && (call.data as { toolName?: string; timeoutMsOverride?: number } | undefined)?.timeoutMsOverride === 80,
        ),
      ).toBe(true)

      jest.advanceTimersByTime(70)
      await Promise.resolve()
      await Promise.resolve()

      expect(abortCalls).toContain(sessionID)
      expect(retriedModels).toContain("openai/gpt-5.4")
    })
  })

  test("does not wait forever on a pending task when only reminder turns remain above it", async () => {
    const retriedModels: string[] = []
    const abortCalls: string[] = []
    const sessionID = "ses-background-reminder-over-pending-task"

    const hook = createRuntimeFallbackHook(
      {
        client: {
          tui: {
            showToast: async () => ({}),
          },
          session: {
            messages: async () => ({
              data: [
                { info: { id: "msg-user-1", role: "user" }, parts: [{ type: "text", text: "/start-work" }] },
                {
                  info: { id: "msg-assistant-1", role: "assistant", finish: "tool-calls" },
                  parts: [{ type: "tool", tool: "task", state: { status: "pending" } }],
                },
                {
                  info: { id: "msg-assistant-2", role: "assistant" },
                  parts: [{
                    type: "text",
                    text: "<system-reminder>\n[BACKGROUND TASK STATUS]\n**Active background tasks:** 1\n**Summary:** 1 pending",
                  }],
                },
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

    jest.advanceTimersByTime(40)
    await Promise.resolve()
    await Promise.resolve()

    expect(abortCalls).toHaveLength(0)
    expect(retriedModels).toHaveLength(0)
    jest.advanceTimersByTime(90)
    await Promise.resolve()
    await Promise.resolve()

    expect(abortCalls).toContain(sessionID)
    expect(retriedModels).toContain("openai/gpt-5.4")
  })

  test("aborts the stalled parent once the latest assistant transcript no longer shows a pending task tool", async () => {
    const retriedModels: string[] = []
    const abortCalls: string[] = []
    const sessionID = "ses-flare-task-pending-cleared"
    let messagesCallCount = 0

    const hook = createRuntimeFallbackHook(
      {
        client: {
          tui: {
            showToast: async () => ({}),
          },
          session: {
            messages: async () => {
              messagesCallCount += 1
              return {
                data: messagesCallCount === 1
                  ? [
                      { info: { id: "msg-user-1", role: "user" }, parts: [{ type: "text", text: "/start-work" }] },
                      {
                        info: { id: "msg-assistant-1", role: "assistant", finish: "tool-calls" },
                        parts: [{ type: "tool", tool: "task", state: { status: "pending" } }],
                      },
                    ]
                  : [
                      { info: { id: "msg-user-1", role: "user" }, parts: [{ type: "text", text: "/start-work" }] },
                      {
                        info: { id: "msg-assistant-1", role: "assistant", finish: "tool-calls" },
                        parts: [],
                      },
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

    jest.advanceTimersByTime(90)
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

  test("does not keep deferring forever on a stale step-start that remains in the latest assistant transcript", async () => {
    const retriedModels: string[] = []
    const abortCalls: string[] = []
    const sessionID = "ses-stale-step-start-transcript"

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
                {
                  info: { role: "assistant" },
                  parts: [
                    { type: "text", text: "Let me continue reading the remaining files:" },
                    { type: "step-start" },
                  ],
                },
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

    jest.advanceTimersByTime(95)
    await Promise.resolve()
    await Promise.resolve()

    expect(abortCalls).toContain(sessionID)
    expect(retriedModels).toContain("openai/gpt-5.4")
    expect(
      logCalls.some((call) =>
        call.msg.includes("Stale assistant blocking progress no longer defers timeout fallback")
        && (call.data as { sessionID?: string; partType?: string } | undefined)?.sessionID === sessionID
        && (call.data as { sessionID?: string; partType?: string } | undefined)?.partType === "step-start",
      ),
    ).toBe(true)
  })

  test("extends the quiet window when a running planner emits visible text before the first write tool call", async () => {
    const retriedModels: string[] = []
    const abortCalls: string[] = []
    const sessionID = "ses-visible-text-before-write-tool"

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
        type: "session.status",
        properties: {
          sessionID,
          agent: "Prometheus (Plan Builder)",
          model: "anthropic/claude-opus-4-6",
          status: {
            type: "running",
            message: "Preparing file write",
          },
        },
      },
    })

    jest.advanceTimersByTime(5)
    await hook.event({
      event: {
        type: "message.part.updated",
        properties: {
          field: "text",
          delta: "Создаю канонический plan-файл",
          part: {
            sessionID,
            type: "text",
            text: "Создаю канонический plan-файл",
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

  test("keeps extending the watchdog while reasoning progress keeps streaming after a step starts", async () => {
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

    for (let index = 0; index < 7; index += 1) {
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

    jest.advanceTimersByTime(60)
    await Promise.resolve()
    await Promise.resolve()

    expect(abortCalls).toHaveLength(0)
    expect(retriedModels).toHaveLength(0)

    jest.advanceTimersByTime(25)
    await Promise.resolve()
    await Promise.resolve()

    expect(abortCalls).toContain(sessionID)
    expect(retriedModels).toContain("openai/gpt-5.4")
  })

  test("keeps extending the watchdog while delta-only text planning keeps streaming after a step starts", async () => {
    const retriedModels: string[] = []
    const abortCalls: string[] = []
    const sessionID = "ses-delta-only-text-churn"

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

    for (let index = 0; index < 7; index += 1) {
      jest.advanceTimersByTime(15)
      await hook.event({
        event: {
          type: "message.part.delta",
          properties: {
            sessionID,
            field: "text",
            delta: `planning token ${index}`,
          },
        },
      })
    }

    expect(abortCalls).toHaveLength(0)
    expect(retriedModels).toHaveLength(0)

    jest.advanceTimersByTime(60)
    await Promise.resolve()
    await Promise.resolve()

    expect(abortCalls).toHaveLength(0)
    expect(retriedModels).toHaveLength(0)

    jest.advanceTimersByTime(25)
    await Promise.resolve()
    await Promise.resolve()

    expect(abortCalls).toContain(sessionID)
    expect(retriedModels).toContain("openai/gpt-5.4")
  })

  test("does not keep extending the watchdog on reasoning-only churn in ci fast-path after dirty-batch inspection", async () => {
    const retriedModels: string[] = []
    const abortCalls: string[] = []
    const sessionID = "ses-ci-reasoning-churn-after-dirty-batch"

    setSessionFlag(sessionID, "ci-fast-path")
    setSessionFlag(sessionID, "ci-dirty-batch-inspected")

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

    for (let index = 0; index < 3; index += 1) {
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

    jest.advanceTimersByTime(40)
    await Promise.resolve()
    await Promise.resolve()

    expect(abortCalls).toContain(sessionID)
    expect(retriedModels).toContain("openai/gpt-5.4")
  })

  test("does not keep extending the watchdog on delta-only planning churn in ci fast-path after dirty-batch inspection", async () => {
    const retriedModels: string[] = []
    const abortCalls: string[] = []
    const sessionID = "ses-ci-delta-churn-after-dirty-batch"

    setSessionFlag(sessionID, "ci-fast-path")
    setSessionFlag(sessionID, "ci-dirty-batch-inspected")

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

    for (let index = 0; index < 3; index += 1) {
      jest.advanceTimersByTime(15)
      await hook.event({
        event: {
          type: "message.part.delta",
          properties: {
            field: "text",
            delta: `planning ${index}`,
            part: {
              sessionID,
              type: "text",
              text: "",
            },
          },
        },
      })
    }

    jest.advanceTimersByTime(40)
    await Promise.resolve()
    await Promise.resolve()

    expect(abortCalls).toContain(sessionID)
    expect(retriedModels).toContain("openai/gpt-5.4")
  })

  test("does not spawn a scoped fallback when live planning deltas arrive right as a stale-transcript timeout fires", async () => {
    const createCalls: Array<unknown> = []
    const promptCalls: Array<unknown> = []
    const abortCalls: string[] = []
    const sessionID = "ses-stale-transcript-live-delta-race"

    const hook = createRuntimeFallbackHook(
      {
        client: {
          tui: {
            showToast: async () => ({}),
          },
          session: {
            create: async (args) => {
              createCalls.push(args)
              return { data: { id: "ses-raced-fallback-child" } }
            },
            messages: async () => ({
              data: [
                { info: { role: "user" }, parts: [{ type: "text", text: "continue" }] },
                { info: { role: "assistant" }, parts: [] },
              ],
            }),
            promptAsync: async (args) => {
              promptCalls.push(args)
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

    jest.advanceTimersByTime(19)

    const deltaEvent = hook.event({
      event: {
        type: "message.part.delta",
        properties: {
          sessionID,
          field: "text",
          delta: "checking Bamboo log and extracting failing shards",
        },
      },
    })

    jest.advanceTimersByTime(2)
    await Promise.resolve()
    await Promise.resolve()
    await deltaEvent
    await Promise.resolve()

    expect(createCalls).toHaveLength(0)
    expect(promptCalls).toHaveLength(0)
    expect(abortCalls).toHaveLength(0)

    jest.advanceTimersByTime(85)
    await Promise.resolve()
    await Promise.resolve()

    expect(createCalls).toHaveLength(1)
    expect(
      (createCalls[0] as { body?: { title?: string } }).body?.title,
    ).toBe("[runtime-fallback] Scoped Fallback: claude-opus-4-6")
  })

  test("suppresses per-delta timeout refresh noise for non-primary child sessions while still keeping the watchdog alive", async () => {
    const sessionID = "ses-non-primary-delta-noise"

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
            promptAsync: async () => ({}),
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
            role: "assistant",
            agent: "Sisyphus Junior (Focused Executor)",
            model: {
              providerID: "openai",
              modelID: "gpt-5.4",
            },
          },
        },
      },
    })

    logCalls = []

    for (let index = 0; index < 3; index += 1) {
      await hook.event({
        event: {
          type: "message.part.delta",
          properties: {
            sessionID,
            field: "text",
            delta: `executor token ${index}`,
          },
        },
      })
    }

    expect(
      logCalls.some((call) => call.msg.includes("Refreshed session fallback timeout")),
    ).toBe(false)
    expect(
      logCalls.some((call) => call.msg.includes("Skipping external watchdog for non-primary or unresolved agent")),
    ).toBe(false)
    expect(
      logCalls.some((call) => call.msg.includes("Refreshed fallback timeout after assistant progress")),
    ).toBe(false)
  })

  test("gives a fresh visible Prometheus planning turn one longer quiet window before timing out", async () => {
    const retriedModels: string[] = []
    const abortCalls: string[] = []
    const sessionID = "ses-visible-planner-text-regroup"

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
                {
                  info: {
                    role: "assistant",
                    agent: "Prometheus (Plan Builder)",
                    model: {
                      providerID: "anthropic",
                      modelID: "claude-opus-4-6",
                    },
                  },
                  parts: [
                    {
                      type: "text",
                      text: "I have everything I need. Let me write the final plan now.",
                    },
                  ],
                },
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
            type: "text",
            text: "I have everything I need. Let me write the final plan now.",
          },
        },
      },
    })

    jest.advanceTimersByTime(25)
    await Promise.resolve()
    await Promise.resolve()

    expect(abortCalls).toHaveLength(0)
    expect(retriedModels).toHaveLength(0)

    jest.advanceTimersByTime(145)
    await Promise.resolve()
    await Promise.resolve()

    expect(abortCalls).toContain(sessionID)
    expect(retriedModels).toContain("openai/gpt-5.4")
  })

  test("gives a fresh live text-delta planning turn one longer quiet window before timing out even when transcript has not persisted visible text yet", async () => {
    const retriedModels: string[] = []
    const abortCalls: string[] = []
    const sessionID = "ses-live-delta-planner-text-regroup"

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
                {
                  info: {
                    role: "assistant",
                    agent: "Prometheus (Plan Builder)",
                    model: {
                      providerID: "anthropic",
                      modelID: "claude-opus-4-6",
                    },
                  },
                  parts: [
                    { type: "step-start" },
                    { type: "patch" },
                  ],
                },
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
        type: "message.part.delta",
        properties: {
          sessionID,
          field: "text",
          delta: "Now I'll build the complete draft.",
        },
      },
    })

    jest.advanceTimersByTime(25)
    await Promise.resolve()
    await Promise.resolve()

    expect(abortCalls).toHaveLength(0)
    expect(retriedModels).toHaveLength(0)
    expect(hook._deps?.sessionStates.get(sessionID)?.lastMeaningfulProgressAt).toBeDefined()
  })

  test("treats a live planning text delta without an explicit field as visible progress", async () => {
    const retriedModels: string[] = []
    const abortCalls: string[] = []
    const sessionID = "ses-visible-progress-delta-without-field"

    const hook = createRuntimeFallbackHook(
      {
        client: {
          tui: {
            showToast: async () => ({}),
          },
          session: {
            abort: async ({ path }: { path: { id: string } }) => {
              abortCalls.push(path.id)
            },
            messages: async () => ({
              data: [
                {
                  info: { role: "user" },
                  parts: [{ type: "text", text: "Finish the planning draft." }],
                },
              ],
            }),
            promptAsync: async (args: {
              body?: { model?: { providerID?: string; modelID?: string } }
            }) => {
              const model = args.body?.model
              if (model?.providerID && model?.modelID) {
                retriedModels.push(`${model.providerID}/${model.modelID}`)
              }
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
        type: "message.part.delta",
        properties: {
          sessionID,
          delta: "I am still synthesizing the draft from the latest evidence.",
        },
      },
    })

    jest.advanceTimersByTime(25)
    await Promise.resolve()
    await Promise.resolve()

    expect(abortCalls).toHaveLength(0)
    expect(retriedModels).toHaveLength(0)
    expect(hook._deps?.sessionStates.get(sessionID)?.lastMeaningfulProgressAt).toBeDefined()
  })

  test("keeps a live planning stream alive when delta events only carry partID after an earlier part update", async () => {
    const retriedModels: string[] = []
    const abortCalls: string[] = []
    const sessionID = "ses-visible-progress-delta-part-id-only"

    const hook = createRuntimeFallbackHook(
      {
        client: {
          tui: {
            showToast: async () => ({}),
          },
          session: {
            messages: async () => ({
              data: [
                {
                  info: { role: "user" },
                  parts: [{ type: "text", text: "Finish the planning draft." }],
                },
              ],
            }),
            abort: async ({ path }: { path: { id: string } }) => {
              abortCalls.push(path.id)
            },
            promptAsync: async (args: {
              body?: { model?: { providerID?: string; modelID?: string } }
            }) => {
              const model = args.body?.model
              if (model?.providerID && model?.modelID) {
                retriedModels.push(`${model.providerID}/${model.modelID}`)
              }
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

    await hook.event({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part-plan-stream-1",
            sessionID,
            messageID: "msg-plan-stream-1",
            type: "reasoning",
            text: "",
          },
        },
      },
    })

    jest.advanceTimersByTime(10)
    await hook.event({
      event: {
        type: "message.part.delta",
        properties: {
          partID: "part-plan-stream-1",
          field: "text",
          delta: "I am still assembling the final CI plan from the latest evidence.",
        },
      },
    })

    jest.advanceTimersByTime(25)
    await Promise.resolve()
    await Promise.resolve()

    expect(abortCalls).toHaveLength(0)
    expect(retriedModels).toHaveLength(0)
    expect(hook._deps?.sessionStates.get(sessionID)?.lastMeaningfulProgressAt).toBeDefined()
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
    test(`treats a pre-execution ${toolName} tool part as blocking progress`, async () => {
      const retriedModels: string[] = []
      const abortCalls: string[] = []
      const sessionID = `ses-preexecution-tool-${toolName}`

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
                  {
                    info: {
                      role: "assistant",
                      agent: "Prometheus (Plan Builder)",
                      model: {
                        providerID: "anthropic",
                        modelID: "claude-opus-4-6",
                      },
                    },
                    parts: [
                      { type: "tool", tool: toolName },
                    ],
                  },
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
            },
          },
        },
      })

      jest.advanceTimersByTime(25)
      await Promise.resolve()
      await Promise.resolve()

      expect(abortCalls).toHaveLength(0)
      expect(retriedModels).toHaveLength(0)

      jest.advanceTimersByTime(80)
      await Promise.resolve()
      await Promise.resolve()

      expect(abortCalls).toContain(sessionID)
      expect(retriedModels).toContain("openai/gpt-5.4")
    })
  }

  test("does not shrink a pre-execution write quiet window back to the base timeout when later text bookkeeping arrives", async () => {
    const retriedModels: string[] = []
    const abortCalls: string[] = []
    const sessionID = "ses-preexecution-write-window-not-shrunk"

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
                {
                  info: {
                    role: "assistant",
                    agent: "Prometheus (Plan Builder)",
                    model: {
                      providerID: "anthropic",
                      modelID: "claude-opus-4-6",
                    },
                  },
                  parts: [
                    { type: "tool", tool: "write" },
                  ],
                },
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
            tool: "write",
          },
        },
      },
    })

    jest.advanceTimersByTime(5)
    await hook.event({
      event: {
        type: "message.part.delta",
        properties: {
          sessionID,
          field: "text",
          delta: "Now I'll write the complete final plan.",
          part: {
            sessionID,
            type: "text",
          },
        },
      },
    })

    jest.advanceTimersByTime(25)
    await Promise.resolve()
    await Promise.resolve()

    expect(abortCalls).toHaveLength(0)
    expect(retriedModels).toHaveLength(0)

    jest.advanceTimersByTime(80)
    await Promise.resolve()
    await Promise.resolve()

    expect(abortCalls).toContain(sessionID)
    expect(retriedModels).toContain("openai/gpt-5.4")
  })

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

  test("keeps the explicit planner agent when timeout fallback switches Prometheus off its primary model", async () => {
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
      agent: "Prometheus (Plan Builder)",
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
