import { describe, expect, it } from "bun:test"

import { TlsCertificateRetryPlugin as tlsPluginUntyped } from "../../assets/custom-opencode/plugins/tls-certificate-retry.js"

type RetryHook = (...args: any[]) => Promise<void>

type RetrySignal =
  | {
      state: "retrying"
      attempt: number
      message: string
      next: number
    }
  | {
      state: "failed"
      error: unknown
      hardProviderBlock: boolean
    }

type RetryRuntime = {
  hooks: Record<string, RetryHook>
  getSessionRetryState: (sessionID: string) => any
  getBlockedModels: () => Array<{ model: string; until: number }>
}

type ScheduledTimer = {
  id: number
  delay: number
  callback: () => unknown
}

type ConfigLoader = () => Record<string, unknown>

const createTlsCertificateRetryRuntime = tlsPluginUntyped.createRuntime as (options: Record<string, unknown>) => RetryRuntime
const RETRY_DELAY_MS = tlsPluginUntyped.RETRY_DELAY_MS as number
const MODEL_RECOVERY_CHECK_MS = tlsPluginUntyped.MODEL_RECOVERY_CHECK_MS as number

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })

  return {
    promise,
    resolve,
    reject,
  }
}

function createTimerController() {
  let nextID = 1
  const activeTimers = new Map<number, ScheduledTimer>()
  const getActiveTimers = () => Array.from(activeTimers.values())

  return {
    setTimeoutFn(callback: () => unknown, delay: number) {
      const timer = {
        id: nextID++,
        delay,
        callback,
      }

      activeTimers.set(timer.id, timer)
      return timer.id as unknown as ReturnType<typeof setTimeout>
    },

    clearTimeoutFn(timerID: ReturnType<typeof setTimeout>) {
      activeTimers.delete(timerID as unknown as number)
    },

    getActiveTimers,

    runNext() {
      const timer = getActiveTimers()[0]

      if (!timer) {
        throw new Error("No active timer to run")
      }

      activeTimers.delete(timer.id)
      return Promise.resolve(timer.callback())
    },
  }
}

function createIntervalController() {
  let nextID = 1
  const activeIntervals = new Map<number, ScheduledTimer>()

  return {
    setIntervalFn(callback: () => unknown, delay: number) {
      const timer = {
        id: nextID++,
        delay,
        callback,
      }

      activeIntervals.set(timer.id, timer)
      return timer.id as unknown as ReturnType<typeof setInterval>
    },

    clearIntervalFn(timerID: ReturnType<typeof setInterval>) {
      activeIntervals.delete(timerID as unknown as number)
    },

    runAll() {
      return Promise.all(Array.from(activeIntervals.values()).map((timer) => Promise.resolve(timer.callback())))
    },
  }
}

function createMockClient({
  promptAsyncImpl,
  sessionMessages,
}: {
  promptAsyncImpl?: (payload: Record<string, unknown>) => Promise<unknown>
  sessionMessages?: unknown[]
} = {}) {
  const toasts: Array<Record<string, unknown>> = []
  const logs: Array<Record<string, unknown>> = []
  const promptCalls: Array<Record<string, unknown>> = []
  const abortCalls: Array<Record<string, unknown>> = []

  return {
    client: {
      tui: {
        showToast: async ({ body }: { body: Record<string, unknown> }) => {
          toasts.push(body)
          return true
        },
      },
      app: {
        log: async ({ body }: { body: Record<string, unknown> }) => {
          logs.push(body)
          return true
        },
      },
      session: {
        messages: async () => ({
          data: sessionMessages ?? [],
        }),
        promptAsync: async (payload: Record<string, unknown>) => {
          promptCalls.push(payload)

          if (promptAsyncImpl) {
            return promptAsyncImpl(payload)
          }

          return true
        },
        abort: async (payload: Record<string, unknown>) => {
          abortCalls.push(payload)
          return true
        },
      },
    },
    abortCalls,
    logs,
    promptCalls,
    toasts,
  }
}

function createRuntime(options: {
  now?: () => number
  onStateChange?: (sessionID: string, signal: RetrySignal) => Promise<void>
  promptAsyncImpl?: (payload: Record<string, unknown>) => Promise<unknown>
  sessionMessages?: unknown[]
  configLoader?: ConfigLoader
} = {}) {
  const timers = createTimerController()
  const intervals = createIntervalController()
  const mock = createMockClient({
    promptAsyncImpl: options.promptAsyncImpl,
    sessionMessages: options.sessionMessages,
  })

  const runtime = createTlsCertificateRetryRuntime({
    client: mock.client,
    directory: "E:/projects/ohmyopencode/oh-my-openagent",
    now: options.now ?? (() => 10_000),
    onStateChange: options.onStateChange,
    configLoader: options.configLoader,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    setIntervalFn: intervals.setIntervalFn,
    clearIntervalFn: intervals.clearIntervalFn,
  })

  return {
    ...mock,
    hooks: runtime.hooks,
    runtime,
    timers,
    intervals,
  }
}

describe("tls certificate retry plugin", () => {
  it("schedules one retry for retryable TLS failures and re-dispatches the last user payload", async () => {
    const signals: RetrySignal[] = []
    const { hooks, promptCalls, runtime, timers } = createRuntime({
      onStateChange: async (_sessionID, signal) => {
        signals.push(signal)
      },
    })

    await hooks["chat.message"]?.(
      {
        sessionID: "ses_tls",
        agent: "atlas",
        variant: "xhigh",
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
      },
      {
        message: {
          role: "user",
          system: "Focus on retry behavior.",
          tools: [{ id: "read" }],
        },
        parts: [{ type: "text", text: "Retry this request if TLS fails." }],
      },
    )

    await hooks.event?.({
      event: {
        type: "session.error",
        properties: {
          sessionID: "ses_tls",
          error: {
            message: "unknown certificate verification error",
          },
        },
      },
    })

    expect(timers.getActiveTimers()).toHaveLength(1)
    expect(timers.getActiveTimers()[0]?.delay).toBe(RETRY_DELAY_MS)
    expect(runtime.getSessionRetryState("ses_tls")).toMatchObject({
      state: "retrying",
      attempt: 1,
      scheduled: true,
      payloadCached: true,
    })
    expect(signals).toEqual([
      {
        state: "retrying",
        attempt: 1,
        message: "unknown certificate verification error",
        next: 10_000 + RETRY_DELAY_MS,
      },
    ])

    await timers.runNext()

    expect(promptCalls).toHaveLength(1)
    expect(promptCalls[0]).toMatchObject({
      path: { id: "ses_tls" },
      query: { directory: "E:/projects/ohmyopencode/oh-my-openagent" },
      body: {
        agent: "atlas",
        variant: "xhigh",
        system: "Focus on retry behavior.",
        tools: [{ id: "read" }],
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
        parts: [{ type: "text", text: "Retry this request if TLS fails." }],
      },
    })
  })

  it("prevents duplicate timer scheduling and duplicate dispatch on repeated connectivity errors", async () => {
    const signals: RetrySignal[] = []
    const dispatchDeferred = createDeferred<unknown>()
    const promptInvoked = createDeferred<void>()
    const { hooks, promptCalls, timers } = createRuntime({
      onStateChange: async (_sessionID, signal) => {
        signals.push(signal)
      },
      promptAsyncImpl: async () => {
        promptInvoked.resolve()
        return dispatchDeferred.promise
      },
    })

    await hooks["chat.message"]?.(
      {
        sessionID: "ses_dedupe",
        agent: "sisyphus",
      },
      {
        message: { role: "user" },
        parts: [{ type: "text", text: "Keep my last payload cached." }],
      },
    )

    const retryableErrorEvent = {
      event: {
        type: "session.error",
        properties: {
          sessionID: "ses_dedupe",
          error: {
            message: "socket hang up",
          },
        },
      },
    }

    await hooks.event?.(retryableErrorEvent)
    await hooks.event?.(retryableErrorEvent)

    expect(timers.getActiveTimers()).toHaveLength(1)
    expect(signals.filter((signal) => signal.state === "retrying")).toHaveLength(1)

    const retryDispatch = timers.runNext()

    await promptInvoked.promise

    expect(promptCalls).toHaveLength(1)

    await hooks.event?.(retryableErrorEvent)

    expect(timers.getActiveTimers()).toHaveLength(0)
    expect(promptCalls).toHaveLength(1)

    dispatchDeferred.resolve(true)
    await retryDispatch

    expect(promptCalls).toHaveLength(1)
  })

  it("switches to fallback model on provider gateway/account blocks instead of getting stuck", async () => {
    const signals: RetrySignal[] = []
    const { hooks, promptCalls, runtime, timers } = createRuntime({
      onStateChange: async (_sessionID, signal) => {
        signals.push(signal)
      },
      configLoader: () => ({
        agents: {
          prometheus: {
            model: "openai/gpt-5.4",
            fallback_models: [
              "openai/gpt-5.3-codex-spark",
            ],
          },
        },
        runtime_fallback: {
          enabled: true,
          max_fallback_attempts: 6,
          max_full_chain_cycles: 5,
          cooldown_seconds: 600,
        },
      }),
    })

    await hooks["chat.message"]?.(
      {
        sessionID: "ses_blocked",
        agent: "prometheus",
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
      },
      {
        message: {
          role: "user",
          model: {
            providerID: "openai",
            modelID: "gpt-5.4",
          },
        },
        parts: [{ type: "text", text: "Retry only if the network is flaky." }],
      },
    )

    await hooks.event?.({
      event: {
        type: "session.error",
        properties: {
          sessionID: "ses_blocked",
          error: {
            message: "network error: unable to connect",
          },
        },
      },
    })

    expect(timers.getActiveTimers()).toHaveLength(1)

    await hooks.event?.({
      event: {
        type: "session.error",
        properties: {
          sessionID: "ses_blocked",
          error: {
            statusCode: 403,
            message: "Blocked by a gateway or proxy. Check your account and provider settings.",
          },
        },
      },
    })

    expect(timers.getActiveTimers()).toHaveLength(0)
    expect(promptCalls).toHaveLength(1)
    expect(promptCalls[0]).toMatchObject({
      body: {
        model: {
          providerID: "openai",
          modelID: "gpt-5.3-codex-spark",
        },
      },
    })
    expect(runtime.getSessionRetryState("ses_blocked")).toMatchObject({
      state: "running",
      currentModel: "openai/gpt-5.3-codex-spark",
      hardProviderBlock: false,
      scheduled: false,
    })
    expect(signals.some((signal) => signal.state === "failed")).toBe(false)
  })

  it("falls back to the next configured model on rate limit and restores the preferred model after cooldown", async () => {
    let currentTime = 50_000
    const { hooks, promptCalls, runtime, intervals } = createRuntime({
      now: () => currentTime,
      configLoader: () => ({
        agents: {
          atlas: {
            model: "anthropic/claude-opus-4-6",
            fallback_models: [
              "anthropic/claude-sonnet-4-6",
              "openai/gpt-5.3-codex",
            ],
          },
        },
        runtime_fallback: {
          enabled: true,
          max_fallback_attempts: 5,
          cooldown_seconds: 600,
        },
      }),
    })

    const firstOutput = {
      message: {
        role: "user",
        system: "Prefer Claude first.",
        tools: [{ id: "read" }],
        model: {
          providerID: "anthropic",
          modelID: "claude-opus-4-6",
        },
      },
      parts: [{ type: "text", text: "Use the best available model." }],
    }

    await hooks["chat.message"]?.(
      {
        sessionID: "ses_rate_limit",
        agent: "atlas",
      },
      firstOutput,
    )

    await hooks.event?.({
      event: {
        type: "session.status",
        properties: {
          sessionID: "ses_rate_limit",
          status: {
            type: "retry",
            attempt: 1,
            message: "This request would exceed your account's rate limit. Please try again later.",
            next: currentTime + MODEL_RECOVERY_CHECK_MS,
          },
        },
      },
    })

    expect(promptCalls).toHaveLength(1)
    expect(promptCalls[0]).toMatchObject({
      body: {
        agent: "atlas",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-6",
        },
      },
    })
    expect(runtime.getSessionRetryState("ses_rate_limit")).toMatchObject({
      currentModel: "anthropic/claude-sonnet-4-6",
      preferredModel: "anthropic/claude-opus-4-6",
    })
    expect(runtime.getBlockedModels()).toEqual([
      {
        model: "anthropic/claude-opus-4-6",
        until: currentTime + (currentTime + MODEL_RECOVERY_CHECK_MS),
      },
    ])

    currentTime = currentTime + (currentTime + MODEL_RECOVERY_CHECK_MS) + 5_000
    await intervals.runAll()

    const secondOutput = {
      message: {
        role: "user",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-6",
        },
      },
      parts: [{ type: "text", text: "Try the primary again when it is back." }],
    }

    await hooks["chat.message"]?.(
      {
        sessionID: "ses_rate_limit",
        agent: "atlas",
      },
      secondOutput,
    )

    expect(secondOutput.message.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-4-6",
    })
  })

  it("prioritizes fallback_models when the current model was explicitly overridden", async () => {
    const { hooks, promptCalls } = createRuntime({
      configLoader: () => ({
        agents: {
          prometheus: {
            model: "opencode/qwen3.6-plus-free",
            fallback_models: [
              "openai/gpt-5.3-codex-spark",
              "opencode/qwen3.6-plus-free",
            ],
          },
        },
        runtime_fallback: {
          enabled: true,
          max_fallback_attempts: 5,
          cooldown_seconds: 600,
        },
      }),
    })

    await hooks["chat.message"]?.(
      {
        sessionID: "ses_override_fallback",
        agent: "prometheus",
        model: {
          providerID: "anthropic",
          modelID: "claude-opus-4-6",
        },
      },
      {
        message: {
          role: "user",
          model: {
            providerID: "anthropic",
            modelID: "claude-opus-4-6",
          },
        },
        parts: [{ type: "text", text: "Use fallback when Anthropic returns rate limit." }],
      },
    )

    await hooks.event?.({
      event: {
        type: "session.status",
        properties: {
          sessionID: "ses_override_fallback",
          status: {
            type: "retry",
            attempt: 1,
            message: "This request would exceed your account's rate limit. Please try again later.",
            next: 120_000,
          },
        },
      },
    })

    expect(promptCalls).toHaveLength(1)
    expect(promptCalls[0]).toMatchObject({
      body: {
        model: {
          providerID: "openai",
          modelID: "gpt-5.3-codex-spark",
        },
      },
    })
  })

  it("fails after the configured number of full fallback cycles", async () => {
    let currentTime = 10_000
    const signals: RetrySignal[] = []
    const { hooks, promptCalls, runtime, timers } = createRuntime({
      now: () => currentTime,
      onStateChange: async (_sessionID, signal) => {
        signals.push(signal)
      },
      promptAsyncImpl: async () => {
        throw {
          statusCode: 429,
          message: "rate limit exceeded",
        }
      },
      configLoader: () => ({
        agents: {
          prometheus: {
            model: "openai/gpt-5.4",
            fallback_models: [
              "anthropic/claude-opus-4-6",
              "openai/gpt-5.3-codex-spark",
            ],
          },
        },
        runtime_fallback: {
          enabled: true,
          max_fallback_attempts: 6,
          max_full_chain_cycles: 2,
          cooldown_seconds: 600,
        },
      }),
    })

    await hooks["chat.message"]?.(
      {
        sessionID: "ses_cycle_limit",
        agent: "prometheus",
      },
      {
        message: {
          role: "user",
          model: {
            providerID: "openai",
            modelID: "gpt-5.4",
          },
        },
        parts: [{ type: "text", text: "Keep retrying through fallback chain." }],
      },
    )

    await hooks.event?.({
      event: {
        type: "session.status",
        properties: {
          sessionID: "ses_cycle_limit",
          status: {
            type: "retry",
            attempt: 1,
            message: "This request would exceed your account's rate limit. Please try again later.",
            next: 120_000,
          },
        },
      },
    })

    expect(runtime.getSessionRetryState("ses_cycle_limit")).toMatchObject({
      state: "retrying",
      fallbackCycleCount: 1,
      scheduled: true,
    })
    expect(timers.getActiveTimers()).toHaveLength(1)

    currentTime = 750_000
    await timers.runNext()

    expect(runtime.getSessionRetryState("ses_cycle_limit")).toMatchObject({
      state: "failed",
      fallbackCycleCount: 2,
      scheduled: false,
      hardProviderBlock: false,
    })
    expect(signals.at(-1)).toMatchObject({
      state: "failed",
      hardProviderBlock: false,
    })
    expect(promptCalls.length).toBeGreaterThanOrEqual(3)
  })

  it("resets full-cycle counters after a successful fallback dispatch", async () => {
    const { hooks, promptCalls, runtime } = createRuntime({
      promptAsyncImpl: async (payload) => {
        const body = payload.body as { model?: { modelID?: string } } | undefined
        const modelID = body?.model?.modelID

        if (modelID === "claude-opus-4-6") {
          throw {
            statusCode: 429,
            message: "rate limit exceeded",
          }
        }

        return true
      },
      configLoader: () => ({
        agents: {
          prometheus: {
            model: "openai/gpt-5.4",
            fallback_models: [
              "anthropic/claude-opus-4-6",
              "openai/gpt-5.3-codex-spark",
            ],
          },
        },
        runtime_fallback: {
          enabled: true,
          max_fallback_attempts: 6,
          max_full_chain_cycles: 5,
          cooldown_seconds: 600,
        },
      }),
    })

    await hooks["chat.message"]?.(
      {
        sessionID: "ses_cycle_reset",
        agent: "prometheus",
      },
      {
        message: {
          role: "user",
          model: {
            providerID: "openai",
            modelID: "gpt-5.4",
          },
        },
        parts: [{ type: "text", text: "Switch model if primary is rate-limited." }],
      },
    )

    await hooks.event?.({
      event: {
        type: "session.status",
        properties: {
          sessionID: "ses_cycle_reset",
          status: {
            type: "retry",
            attempt: 1,
            message: "This request would exceed your account's rate limit. Please try again later.",
            next: 90_000,
          },
        },
      },
    })

    expect(promptCalls).toHaveLength(2)
    expect(promptCalls[0]?.body?.model).toMatchObject({
      providerID: "anthropic",
      modelID: "claude-opus-4-6",
    })
    expect(promptCalls[1]?.body?.model).toMatchObject({
      providerID: "openai",
      modelID: "gpt-5.3-codex-spark",
    })
    expect(runtime.getSessionRetryState("ses_cycle_reset")).toMatchObject({
      state: "running",
      fallbackCycleCount: 0,
      cycleVisitedModels: [],
      currentModel: "openai/gpt-5.3-codex-spark",
    })
  })
})
