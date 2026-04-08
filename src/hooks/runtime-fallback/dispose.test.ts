import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { HookDeps, RuntimeFallbackPluginInput } from "./types"
import { createRuntimeFallbackHook } from "./hook"

function createMockContext(): RuntimeFallbackPluginInput {
  return {
    client: {
      session: {
        abort: async () => ({}),
        messages: async () => ({ data: [] }),
        promptAsync: async () => ({}),
      },
      tui: {
        showToast: async () => ({}),
      },
    },
    directory: "/test",
  }
}

describe("createRuntimeFallbackHook dispose", () => {
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  const originalClearTimeout = globalThis.clearTimeout
  const createdIntervals: Array<ReturnType<typeof originalSetInterval>> = []
  const clearedIntervals: Array<Parameters<typeof originalClearInterval>[0]> = []
  const clearedTimeouts: Array<Parameters<typeof originalClearTimeout>[0]> = []
  let deps: HookDeps | undefined
  const timeoutMapSizesDuringClear: number[] = []

  beforeEach(() => {
    createdIntervals.length = 0
    clearedIntervals.length = 0
    clearedTimeouts.length = 0
    timeoutMapSizesDuringClear.length = 0
    deps = undefined

    const wrappedSetInterval = ((handler: () => void, timeout?: number) => {
      const interval = originalSetInterval(handler, timeout)
      createdIntervals.push(interval)
      return interval
    }) as typeof globalThis.setInterval

    const wrappedClearInterval = ((interval?: Parameters<typeof clearInterval>[0]) => {
      clearedIntervals.push(interval)
      return originalClearInterval(interval)
    }) as typeof globalThis.clearInterval

    const wrappedClearTimeout = ((timeout?: Parameters<typeof clearTimeout>[0]) => {
      timeoutMapSizesDuringClear.push(deps?.sessionFallbackTimeouts.size ?? -1)
      clearedTimeouts.push(timeout)
      return originalClearTimeout(timeout)
    }) as typeof globalThis.clearTimeout

    globalThis.setInterval = wrappedSetInterval
    globalThis.clearInterval = wrappedClearInterval
    globalThis.clearTimeout = wrappedClearTimeout
  })

  afterEach(() => {
    globalThis.setInterval = originalSetInterval
    globalThis.clearInterval = originalClearInterval
    globalThis.clearTimeout = originalClearTimeout
  })

  test("#given runtime-fallback hook created #when dispose() is called #then cleanup interval is cleared", () => {
    // given
    const hook = createRuntimeFallbackHook(createMockContext(), { pluginConfig: {} })

    // when
    hook.dispose?.()

    // then
    expect(createdIntervals).toHaveLength(2)
    expect(clearedIntervals).toEqual(createdIntervals)
  })

  test("#given hook with session state data #when dispose() is called #then all Maps and Sets are empty", () => {
    // given
    const hook = createRuntimeFallbackHook(createMockContext(), { pluginConfig: {} })
    deps = hook._deps!
    const fallbackTimeout = setTimeout(() => {}, 60_000)

    deps.sessionStates.set("session-1", {
      originalModel: "anthropic/claude-opus-4-6",
      currentModel: "openai/gpt-5.4",
      fallbackIndex: 1,
      fallbackModels: [],
      failedModels: new Map([["anthropic/claude-opus-4-6", 1]]),
      attemptCount: 1,
      transientRetryCount: 0,
    })
    deps.sessionLastAccess.set("session-1", Date.now())
    deps.sessionRetryInFlight.add("session-1")
    deps.sessionAwaitingFallbackResult.add("session-1")
    deps.sessionFallbackTimeouts.set("session-1", fallbackTimeout)

    // when
    hook.dispose?.()

    // then
    expect(deps.sessionStates.size).toBe(0)
    expect(deps.sessionLastAccess.size).toBe(0)
    expect(deps.sessionRetryInFlight.size).toBe(0)
    expect(deps.sessionAwaitingFallbackResult.size).toBe(0)
    expect(deps.sessionFallbackTimeouts.size).toBe(0)
    expect(deps.sessionTransientRetryTimeouts.size).toBe(0)
  })

  test("#given hook with pending fallback timeouts #when dispose() is called #then timeouts are cleared before Map is emptied", () => {
    // given
    const hook = createRuntimeFallbackHook(createMockContext(), { pluginConfig: {} })
    deps = hook._deps!
    const fallbackTimeout = setTimeout(() => {}, 60_000)
    deps.sessionFallbackTimeouts.set("session-1", fallbackTimeout)

    // when
    hook.dispose?.()

    // then
    expect(clearedTimeouts).toEqual([fallbackTimeout])
    expect(timeoutMapSizesDuringClear).toEqual([1])
    expect(deps.sessionFallbackTimeouts.size).toBe(0)
  })
})
