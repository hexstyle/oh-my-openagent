import { afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test"

import { tryFallbackRetry, tryFallbackSwitch } from "./fallback-retry-handler"
import * as shared from "../../shared"
import * as modelErrorClassifier from "../../shared/model-error-classifier"
import * as providerModelTransform from "../../shared/provider-model-id-transform"
import type { BackgroundTask } from "./types"
import type { ConcurrencyManager } from "./concurrency"

function createMockTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "test-task-1",
    description: "test task",
    prompt: "test prompt",
    agent: "sisyphus-junior",
    status: "error",
    parentSessionID: "parent-session-1",
    parentMessageID: "parent-message-1",
    fallbackChain: [
      { model: "fallback-model-1", providers: ["provider-a"], variant: undefined },
      { model: "fallback-model-2", providers: ["provider-b"], variant: undefined },
    ],
    attemptCount: 0,
    concurrencyKey: "provider-a/original-model",
    model: { providerID: "provider-a", modelID: "original-model" },
    ...overrides,
  }
}

function createMockConcurrencyManager(): ConcurrencyManager {
  return {
    release: mock(() => {}),
    acquire: mock(async () => {}),
    getQueueLength: mock(() => 0),
    getActiveCount: mock(() => 0),
  } as unknown as ConcurrencyManager
}

function createMockClient() {
  return {
    session: {
      abort: mock(async () => ({})),
    },
  } as const
}

function createDefaultArgs(taskOverrides: Partial<BackgroundTask> = {}) {
  const processKeyFn = mock(() => {})
  const queuesByKey = new Map<string, Array<{ task: BackgroundTask; input: unknown }>>()
  const idleDeferralTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const transientRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const concurrencyManager = createMockConcurrencyManager()
  const client = createMockClient()
  const task = createMockTask(taskOverrides)

  return {
    task,
    errorInfo: { name: "UnknownError", message: "model overloaded" },
    source: "polling",
    concurrencyManager,
    client,
    idleDeferralTimers,
    transientRetryTimers,
    queuesByKey,
    processKey: processKeyFn,
  }
}

describe("tryFallbackRetry", () => {
  beforeEach(() => {
    mock.restore()
    spyOn(shared, "log").mockImplementation(() => {})
    spyOn(shared, "readConnectedProvidersCache").mockReturnValue(null)
    spyOn(shared, "readProviderModelsCache").mockReturnValue(null)
    spyOn(shared, "readCachedModelCatalog").mockReturnValue(new Set())
    spyOn(shared, "resolveKnownCachedModel").mockImplementation((_target: string, availableModels: Set<string>) => availableModels.size > 0 ? null : "known")
    spyOn(modelErrorClassifier, "shouldRetryError").mockImplementation(() => true)
    spyOn(modelErrorClassifier, "shouldSwitchFallback").mockImplementation(() => true)
    spyOn(modelErrorClassifier, "getNextFallback").mockImplementation((chain: Array<{ model: string }>, attempt: number) => chain[attempt])
    spyOn(modelErrorClassifier, "hasMoreFallbacks").mockImplementation((chain: Array<{ model: string }>, attempt: number) => attempt < chain.length)
    spyOn(modelErrorClassifier, "selectFallbackProvider").mockImplementation((providers: string[]) => providers[0])
    spyOn(providerModelTransform, "transformModelForProvider").mockImplementation((_provider: string, model: string) => model)
  })

  afterEach(() => {
    jest.useRealTimers()
    mock.restore()
  })

  test("schedules delayed same-model retry for transient errors instead of burning the fallback chain immediately", () => {
    jest.useFakeTimers()
    const args = createDefaultArgs({ sessionID: "session-to-abort" })

    const result = tryFallbackRetry(args)

    expect(result).toBe(true)
    expect(args.task.status).toBe("pending")
    expect(args.task.attemptCount).toBe(0)
    expect(args.task.model).toEqual({
      providerID: "provider-a",
      modelID: "original-model",
    })
    expect(args.task.transientRetryCount).toBe(1)
    expect(args.task.transientRetryDelayMs).toBe(10_000)
    expect(args.client.session.abort).toHaveBeenCalledWith({
      path: { id: "session-to-abort" },
    })
    expect(args.processKey).not.toHaveBeenCalled()
    expect(args.queuesByKey.size).toBe(0)

    jest.advanceTimersByTime(9_999)
    expect(args.processKey).not.toHaveBeenCalled()

    jest.advanceTimersByTime(1)
    expect(args.processKey).toHaveBeenCalledWith("provider-a/original-model")
    const queue = args.queuesByKey.get("provider-a/original-model")
    expect(queue).toBeDefined()
    expect(queue).toHaveLength(1)
    expect(queue?.[0]?.task).toBe(args.task)
  })

  test("caps delayed transient retries at five minutes", () => {
    jest.useFakeTimers()
    const args = createDefaultArgs({
      transientRetryStartedAt: Date.now(),
      transientRetryCount: 4,
      transientRetryDelayMs: 240_000,
    })

    const result = tryFallbackRetry(args)

    expect(result).toBe(true)
    expect(args.task.transientRetryCount).toBe(5)
    expect(args.task.transientRetryDelayMs).toBe(300_000)

    jest.advanceTimersByTime(299_999)
    expect(args.processKey).not.toHaveBeenCalled()

    jest.advanceTimersByTime(1)
    expect(args.processKey).toHaveBeenCalledWith("provider-a/original-model")
  })

  test("falls through to the next distinct fallback model after the transient retry window expires", () => {
    const args = createDefaultArgs({
      fallbackChain: [
        { model: "original-model", providers: ["provider-a"], variant: undefined },
        { model: "fallback-model-1", providers: ["provider-b"], variant: undefined },
      ],
      transientRetryStartedAt: Date.now() - (15 * 60 * 1000 + 1_000),
      transientRetryCount: 9,
      transientRetryDelayMs: 300_000,
    })

    const result = tryFallbackRetry(args)

    expect(result).toBe(true)
    expect(args.task.attemptCount).toBe(2)
    expect(args.task.transientRetryCount).toBe(0)
    expect(args.task.transientRetryStartedAt).toBeUndefined()
    expect(args.task.transientRetryDelayMs).toBeUndefined()
    expect(args.task.model).toEqual({
      providerID: "provider-b",
      modelID: "fallback-model-1",
    })
    expect(args.processKey).toHaveBeenCalledWith("provider-b/fallback-model-1")
  })

  test("switches immediately to the next distinct fallback when the provider says the model does not exist", () => {
    const args = createDefaultArgs({
      fallbackChain: [
        { model: "original-model", providers: ["provider-a"], variant: undefined },
        { model: "fallback-model-1", providers: ["provider-b"], variant: undefined },
      ],
    })

    const result = tryFallbackRetry({
      ...args,
      errorInfo: {
        name: "ProviderModelNotFoundError",
        message: "Model not found: provider-a/original-model.",
      },
    })

    expect(result).toBe(true)
    expect(args.task.attemptCount).toBe(2)
    expect(args.task.model).toEqual({
      providerID: "provider-b",
      modelID: "fallback-model-1",
    })
    expect(args.task.transientRetryCount).toBe(0)
    expect(args.processKey).toHaveBeenCalledWith("provider-b/fallback-model-1")
  })

  test("treats transient 403 forbidden failures as delayed same-model retries", () => {
    jest.useFakeTimers()
    const args = createDefaultArgs({
      sessionID: "session-forbidden-retry",
    })

    const result = tryFallbackRetry({
      ...args,
      errorInfo: {
        name: "AuthenticationError",
        message: "403 Forbidden",
      },
    })

    expect(result).toBe(true)
    expect(args.task.attemptCount).toBe(0)
    expect(args.task.transientRetryCount).toBe(1)
    expect(args.task.transientRetryDelayMs).toBe(10_000)

    jest.advanceTimersByTime(10_000)
    expect(args.processKey).toHaveBeenCalledWith("provider-a/original-model")
  })

  test("treats request-not-allowed 403 failures as delayed same-model retries", () => {
    jest.useFakeTimers()
    const args = createDefaultArgs({
      sessionID: "session-request-not-allowed-retry",
    })

    const result = tryFallbackRetry({
      ...args,
      errorInfo: {
        name: "AuthenticationError",
        message: "Request not allowed",
      },
    })

    expect(result).toBe(true)
    expect(args.task.attemptCount).toBe(0)
    expect(args.task.transientRetryCount).toBe(1)
    expect(args.task.transientRetryDelayMs).toBe(10_000)

    jest.advanceTimersByTime(10_000)
    expect(args.processKey).toHaveBeenCalledWith("provider-a/original-model")
  })

  test("treats remote compact 403 forbidden failures as delayed same-model retries", () => {
    jest.useFakeTimers()
    const args = createDefaultArgs({
      sessionID: "session-remote-compact-retry",
    })

    const result = tryFallbackRetry({
      ...args,
      errorInfo: {
        name: "UnknownError",
        message: "Error running remote compact task: unexpected status 403 Forbidden",
      },
    })

    expect(result).toBe(true)
    expect(args.task.attemptCount).toBe(0)
    expect(args.task.transientRetryCount).toBe(1)
    expect(args.task.transientRetryDelayMs).toBe(10_000)

    jest.advanceTimersByTime(10_000)
    expect(args.processKey).toHaveBeenCalledWith("provider-a/original-model")
  })

  test("skips fallback entries that are absent from the cached model catalog", () => {
    ;(shared.readCachedModelCatalog as any).mockReturnValue(new Set([
      "provider-b/fallback-model-1",
    ]))
    ;(shared.resolveKnownCachedModel as any).mockImplementation((target: string, availableModels: Set<string>) =>
      availableModels.has(target) ? target : null
    )

    const args = createDefaultArgs({
      fallbackChain: [
        { model: "original-model", providers: ["provider-a"], variant: undefined },
        { model: "missing-model", providers: ["provider-c"], variant: undefined },
        { model: "fallback-model-1", providers: ["provider-b"], variant: undefined },
      ],
    })

    const result = tryFallbackRetry({
      ...args,
      errorInfo: {
        name: "ProviderModelNotFoundError",
        message: "Model not found: provider-a/original-model.",
      },
    })

    expect(result).toBe(true)
    expect(args.task.attemptCount).toBe(3)
    expect(args.task.model).toEqual({
      providerID: "provider-b",
      modelID: "fallback-model-1",
    })
    expect(args.processKey).toHaveBeenCalledWith("provider-b/fallback-model-1")
  })

  test("trusts explicit fallback chains even when the cached catalog is stale", () => {
    ;(shared.readCachedModelCatalog as any).mockReturnValue(new Set([
      "provider-a/original-model",
    ]))
    ;(shared.resolveKnownCachedModel as any).mockImplementation((target: string, availableModels: Set<string>) =>
      availableModels.has(target) ? target : null
    )

    const args = createDefaultArgs({
      trustFallbackChain: true,
      fallbackChain: [
        { model: "original-model", providers: ["provider-a"], variant: undefined },
        { model: "fallback-model-1", providers: ["provider-b"], variant: undefined },
      ],
    })

    const result = tryFallbackRetry({
      ...args,
      errorInfo: {
        name: "ProviderModelNotFoundError",
        message: "Model not found: provider-a/original-model.",
      },
    })

    expect(result).toBe(true)
    expect(args.task.attemptCount).toBe(2)
    expect(args.task.model).toEqual({
      providerID: "provider-b",
      modelID: "fallback-model-1",
    })
    expect(args.processKey).toHaveBeenCalledWith("provider-b/fallback-model-1")
  })

  test("returns false when the error is not retryable", () => {
    ;(modelErrorClassifier.shouldRetryError as any).mockImplementation(() => false)
    const args = createDefaultArgs()

    const result = tryFallbackRetry({
      ...args,
      errorInfo: {
        name: "PermissionDeniedError",
        message: "Permission denied",
      },
    })

    expect(result).toBe(false)
  })
})

describe("tryFallbackSwitch", () => {
  beforeEach(() => {
    mock.restore()
    spyOn(shared, "log").mockImplementation(() => {})
    spyOn(shared, "readConnectedProvidersCache").mockReturnValue(null)
    spyOn(shared, "readProviderModelsCache").mockReturnValue(null)
    spyOn(shared, "readCachedModelCatalog").mockReturnValue(new Set())
    spyOn(shared, "resolveKnownCachedModel").mockImplementation((_target: string, availableModels: Set<string>) => availableModels.size > 0 ? null : "known")
    spyOn(modelErrorClassifier, "shouldRetryError").mockImplementation(() => true)
    spyOn(modelErrorClassifier, "shouldSwitchFallback").mockImplementation(() => true)
    spyOn(modelErrorClassifier, "getNextFallback").mockImplementation((chain: Array<{ model: string }>, attempt: number) => chain[attempt])
    spyOn(modelErrorClassifier, "hasMoreFallbacks").mockImplementation((chain: Array<{ model: string }>, attempt: number) => attempt < chain.length)
    spyOn(modelErrorClassifier, "selectFallbackProvider").mockImplementation((providers: string[]) => providers[0])
    spyOn(providerModelTransform, "transformModelForProvider").mockImplementation((_provider: string, model: string) => model)
  })

  test("switches quota failures to the next distinct fallback model and clears transient retry timers", () => {
    const args = createDefaultArgs({
      fallbackChain: [
        { model: "original-model", providers: ["provider-a"], variant: undefined },
        { model: "fallback-model-1", providers: ["provider-b"], variant: "high" },
      ],
      transientRetryCount: 3,
      transientRetryStartedAt: Date.now(),
      transientRetryDelayMs: 120_000,
    })
    const timer = setTimeout(() => {}, 10_000)
    args.transientRetryTimers.set(args.task.id, timer)

    const result = tryFallbackSwitch({
      ...args,
      errorInfo: {
        name: "RateLimitError",
        message: "usage limit reached",
      },
    })

    expect(result).toBe(true)
    expect(args.task.attemptCount).toBe(2)
    expect(args.task.transientRetryCount).toBe(0)
    expect(args.task.transientRetryStartedAt).toBeUndefined()
    expect(args.task.transientRetryDelayMs).toBeUndefined()
    expect(args.transientRetryTimers.has(args.task.id)).toBe(false)
    expect(args.task.model).toEqual({
      providerID: "provider-b",
      modelID: "fallback-model-1",
      variant: "high",
    })
    expect(args.processKey).toHaveBeenCalledWith("provider-b/fallback-model-1")
  })
})
