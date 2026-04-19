import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import type { OhMyOpenCodeConfig } from "../../config"
import type { HookDeps, RuntimeFallbackInterval, RuntimeFallbackPluginInput } from "./types"

type RuntimeFallbackModule = typeof import("./hook")

const loadPluginConfigMock = mock(() => ({} satisfies OhMyOpenCodeConfig))
const createAutoRetryHelpersMock = mock((_deps: HookDeps) => {
  void _deps

  return {
    abortSessionRequest: async () => {},
    clearSessionFallbackTimeout: () => {},
    scheduleSessionFallbackTimeout: () => {},
    autoRetryWithFallback: async () => {},
    retryCurrentModel: async () => false,
    retryCurrentModelInFreshSession: async () => false,
    resolveAgentForSessionFromContext: async () => undefined,
    cleanupStaleSessions: () => {},
    recoverPreferredModels: async () => {},
  }
})
const createEventHandlerMock = mock(() => async () => {})
const createMessageUpdateHandlerMock = mock(() => async () => {})
const createChatMessageHandlerMock = mock(() => async () => {})

function registerModuleMocks(): void {
  mock.module("../../plugin-config", () => ({
    loadPluginConfig: loadPluginConfigMock,
  }))

  mock.module("./auto-retry", () => ({
    createAutoRetryHelpers: createAutoRetryHelpersMock,
  }))

  mock.module("./event-handler", () => ({
    createEventHandler: createEventHandlerMock,
  }))

  mock.module("./message-update-handler", () => ({
    createMessageUpdateHandler: createMessageUpdateHandlerMock,
  }))

  mock.module("./chat-message-handler", () => ({
    createChatMessageHandler: createChatMessageHandlerMock,
  }))
}

function createMockContext(): RuntimeFallbackPluginInput {
  return {
    client: {
      session: {
        abort: async () => ({}),
        messages: async () => ({}),
        promptAsync: async () => ({}),
      },
      tui: {
        showToast: async () => ({}),
      },
    },
    directory: "/test",
  }
}

function createMockInterval(): RuntimeFallbackInterval {
  return {
    unref: () => {},
  }
}

describe("createRuntimeFallbackHook initialization", () => {
  const originalSetInterval = globalThis.setInterval
  let setIntervalCalls = 0
  let createRuntimeFallbackHook: RuntimeFallbackModule["createRuntimeFallbackHook"]

  beforeEach(async () => {
    mock.restore()
    registerModuleMocks()
    loadPluginConfigMock.mockClear()
    createAutoRetryHelpersMock.mockClear()
    createEventHandlerMock.mockClear()
    createMessageUpdateHandlerMock.mockClear()
    createChatMessageHandlerMock.mockClear()
    setIntervalCalls = 0

    globalThis.setInterval = ((callback: Parameters<typeof originalSetInterval>[0], delay?: number) => {
      void callback
      void delay
      setIntervalCalls += 1
      return createMockInterval() as ReturnType<typeof globalThis.setInterval>
    }) as typeof globalThis.setInterval

    const cacheBuster = `${Date.now()}-${Math.random()}`
    const runtimeFallbackModule: RuntimeFallbackModule = await import(`./hook?test=${cacheBuster}`)
    createRuntimeFallbackHook = runtimeFallbackModule.createRuntimeFallbackHook
  })

  afterEach(() => {
    globalThis.setInterval = originalSetInterval
    mock.restore()
  })

  test("#given injected pluginConfig #when the hook factory runs #then loadPluginConfig is not called", () => {
    // given
    const pluginConfig = {} satisfies OhMyOpenCodeConfig

    // when
    createRuntimeFallbackHook(createMockContext(), { pluginConfig })

    // then
    expect(loadPluginConfigMock).not.toHaveBeenCalled()
  })

  test("#given a fresh hook #when it initializes and later receives events #then background intervals start exactly once", async () => {
    // given
    const hook = createRuntimeFallbackHook(createMockContext(), { pluginConfig: {} })

    // when
    expect(setIntervalCalls).toBe(2)
    await hook.event({ event: { type: "session.created", properties: {} } })
    expect(setIntervalCalls).toBe(2)
    await hook.event({ event: { type: "session.error", properties: {} } })

    // then
    expect(setIntervalCalls).toBe(2)
  })
})
