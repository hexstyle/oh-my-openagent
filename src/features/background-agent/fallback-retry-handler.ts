import type { BackgroundTask, LaunchInput } from "./types"
import type { FallbackEntry } from "../../shared/model-requirements"
import type { ConcurrencyManager } from "./concurrency"
import type { OpencodeClient, QueueItem } from "./constants"
import { log, readCachedModelCatalog, readConnectedProvidersCache, readProviderModelsCache, resolveKnownCachedModel } from "../../shared"
import { DEFAULT_CONFIG as DEFAULT_RUNTIME_FALLBACK_CONFIG } from "../../hooks/runtime-fallback/constants"
import { getRuntimeFallbackAction } from "../../hooks/runtime-fallback/fallback-policy"
import {
  shouldRetryError,
  shouldSwitchFallback,
  getNextFallback,
  hasMoreFallbacks,
  selectFallbackProvider,
} from "../../shared/model-error-classifier"
import { transformModelForProvider } from "../../shared/provider-model-id-transform"

const TRANSIENT_RETRY_WINDOW_MS = DEFAULT_RUNTIME_FALLBACK_CONFIG.transient_retry_window_seconds * 1000
const TRANSIENT_RETRY_INITIAL_DELAY_MS = DEFAULT_RUNTIME_FALLBACK_CONFIG.transient_retry_initial_delay_seconds * 1000
const TRANSIENT_RETRY_MAX_DELAY_MS = DEFAULT_RUNTIME_FALLBACK_CONFIG.transient_retry_max_delay_seconds * 1000

function isSameResolvedModel(task: BackgroundTask, providerID: string, modelID: string): boolean {
  const current = task.model
  if (!current) return false
  return current.providerID.toLowerCase() === providerID.toLowerCase()
    && current.modelID.toLowerCase() === modelID.toLowerCase()
}

function buildFallbackTaskModel(task: BackgroundTask, providerID: string, transformedModelId: string, nextFallback: FallbackEntry) {
  const preserveExistingSettings = isSameResolvedModel(task, providerID, transformedModelId)
  const currentModel = task.model

  return {
    providerID,
    modelID: transformedModelId,
    variant: nextFallback.variant ?? (preserveExistingSettings ? currentModel?.variant : undefined),
    reasoningEffort: nextFallback.reasoningEffort ?? (preserveExistingSettings ? currentModel?.reasoningEffort : undefined),
    temperature: nextFallback.temperature ?? (preserveExistingSettings ? currentModel?.temperature : undefined),
    top_p: nextFallback.top_p ?? (preserveExistingSettings ? currentModel?.top_p : undefined),
    maxTokens: nextFallback.maxTokens ?? (preserveExistingSettings ? currentModel?.maxTokens : undefined),
    thinking: nextFallback.thinking ?? (preserveExistingSettings ? currentModel?.thinking : undefined),
  }
}

function clearTaskIdleTimer(
  taskId: string,
  idleDeferralTimers: Map<string, ReturnType<typeof setTimeout>>,
): void {
  const idleTimer = idleDeferralTimers.get(taskId)
  if (!idleTimer) return

  clearTimeout(idleTimer)
  idleDeferralTimers.delete(taskId)
}

function clearTransientRetryTimer(
  taskId: string,
  transientRetryTimers: Map<string, ReturnType<typeof setTimeout>>,
): void {
  const timer = transientRetryTimers.get(taskId)
  if (!timer) return

  clearTimeout(timer)
  transientRetryTimers.delete(taskId)
}

function resetTransientRetryState(task: BackgroundTask): void {
  task.transientRetryCount = 0
  task.transientRetryStartedAt = undefined
  task.transientRetryDelayMs = undefined
}

function canKeepRetryingTransiently(task: BackgroundTask, now = Date.now()): boolean {
  if (TRANSIENT_RETRY_WINDOW_MS <= 0) {
    return false
  }

  if (task.transientRetryStartedAt === undefined) {
    return true
  }

  return now - task.transientRetryStartedAt < TRANSIENT_RETRY_WINDOW_MS
}

function getNextTransientRetryDelayMs(task: BackgroundTask): number {
  if (
    task.transientRetryDelayMs === undefined
    || task.transientRetryDelayMs <= 0
  ) {
    return TRANSIENT_RETRY_INITIAL_DELAY_MS
  }

  return Math.min(task.transientRetryDelayMs * 2, TRANSIENT_RETRY_MAX_DELAY_MS)
}

function buildRetryInput(task: BackgroundTask): LaunchInput {
  return {
    description: task.description,
    prompt: task.prompt,
    agent: task.agent,
    parentSessionID: task.parentSessionID,
    parentMessageID: task.parentMessageID,
    parentModel: task.parentModel,
    parentAgent: task.parentAgent,
    parentTools: task.parentTools,
    model: task.model,
    fallbackChain: task.fallbackChain,
    trustFallbackChain: task.trustFallbackChain,
    category: task.category,
    isUnstableAgent: task.isUnstableAgent,
  }
}

function enqueueRetryTask(args: {
  task: BackgroundTask
  key: string
  retryInput: LaunchInput
  queuesByKey: Map<string, QueueItem[]>
  processKey: (key: string) => void
}): void {
  const queue = args.queuesByKey.get(args.key) ?? []
  queue.push({ task: args.task, input: args.retryInput })
  args.queuesByKey.set(args.key, queue)
  args.processKey(args.key)
}

function prepareTaskForRetry(args: {
  task: BackgroundTask
  concurrencyManager: ConcurrencyManager
  client: OpencodeClient
  idleDeferralTimers: Map<string, ReturnType<typeof setTimeout>>
}): void {
  const { task, concurrencyManager, client, idleDeferralTimers } = args

  if (task.concurrencyKey) {
    concurrencyManager.release(task.concurrencyKey)
    task.concurrencyKey = undefined
  }

  if (task.sessionID) {
    client.session.abort({ path: { id: task.sessionID } }).catch(() => {})
  }

  clearTaskIdleTimer(task.id, idleDeferralTimers)

  task.status = "pending"
  task.sessionID = undefined
  task.startedAt = undefined
  task.queuedAt = new Date()
  task.error = undefined
}

function createReachabilityChecker(task: BackgroundTask) {
  const providerModelsCache = readProviderModelsCache()
  const connectedProviders = providerModelsCache?.connected ?? readConnectedProvidersCache()
  const connectedSet = connectedProviders ? new Set(connectedProviders.map(p => p.toLowerCase())) : null
  const knownModels = readCachedModelCatalog()
  const preferredProvider = task.model?.providerID?.toLowerCase()

  return {
    knownModels,
    isProviderReachable(entry: FallbackEntry): boolean {
      if (!connectedSet) return true
      if (entry.providers.some((provider) => connectedSet.has(provider.toLowerCase()))) {
        return true
      }
      return preferredProvider ? connectedSet.has(preferredProvider) : false
    },
  }
}

function selectNextFallbackCandidate(args: {
  task: BackgroundTask
  source: string
  skipSameResolvedModel: boolean
}): { selectedAttemptCount: number; nextFallback?: FallbackEntry; providerID?: string } {
  const { task, source, skipSameResolvedModel } = args
  const fallbackChain = task.fallbackChain
  const reachability = createReachabilityChecker(task)
  const attemptCount = task.attemptCount ?? 0

  let selectedAttemptCount = attemptCount
  while (fallbackChain && selectedAttemptCount < fallbackChain.length) {
    const candidate = getNextFallback(fallbackChain, selectedAttemptCount)
    if (!candidate) break
    selectedAttemptCount++
    if (!reachability.isProviderReachable(candidate)) {
      log("[background-agent] Skipping unreachable fallback:", {
        taskId: task.id,
        source,
        model: candidate.model,
        providers: candidate.providers,
      })
      continue
    }

    const providerID = selectFallbackProvider(
      candidate.providers,
      task.model?.providerID,
    )
    const transformedModelId = transformModelForProvider(providerID, candidate.model)
    const fullModel = `${providerID}/${transformedModelId}`

    if (
      !task.trustFallbackChain &&
      reachability.knownModels.size > 0 &&
      !resolveKnownCachedModel(fullModel, reachability.knownModels)
    ) {
      log("[background-agent] Skipping unknown fallback model:", {
        taskId: task.id,
        source,
        model: fullModel,
      })
      continue
    }

    if (skipSameResolvedModel && isSameResolvedModel(task, providerID, transformedModelId)) {
      log("[background-agent] Skipping no-op fallback candidate:", {
        taskId: task.id,
        source,
        model: fullModel,
      })
      continue
    }

    return { selectedAttemptCount, nextFallback: candidate, providerID }
  }

  return { selectedAttemptCount }
}

function switchToNextFallback(args: {
  task: BackgroundTask
  errorInfo: { name?: string; message?: string }
  source: string
  concurrencyManager: ConcurrencyManager
  client: OpencodeClient
  idleDeferralTimers: Map<string, ReturnType<typeof setTimeout>>
  transientRetryTimers: Map<string, ReturnType<typeof setTimeout>>
  queuesByKey: Map<string, QueueItem[]>
  processKey: (key: string) => void
}): boolean {
  const { task, errorInfo, source, concurrencyManager, client, idleDeferralTimers, transientRetryTimers, queuesByKey, processKey } = args
  const fallbackChain = task.fallbackChain
  const canSwitch =
    fallbackChain &&
    fallbackChain.length > 0 &&
    hasMoreFallbacks(fallbackChain, task.attemptCount ?? 0)

  if (!canSwitch) return false

  const {
    selectedAttemptCount,
    nextFallback,
    providerID,
  } = selectNextFallbackCandidate({
    task,
    source,
    skipSameResolvedModel: true,
  })

  if (!nextFallback || !providerID) return false

  log("[background-agent] Switching to fallback model:", {
    taskId: task.id,
    source,
    errorName: errorInfo.name,
    errorMessage: errorInfo.message?.slice(0, 100),
    attemptCount: selectedAttemptCount,
    nextModel: `${providerID}/${nextFallback.model}`,
  })

  clearTransientRetryTimer(task.id, transientRetryTimers)
  resetTransientRetryState(task)
  prepareTaskForRetry({
    task,
    concurrencyManager,
    client,
    idleDeferralTimers,
  })

  task.attemptCount = selectedAttemptCount
  const transformedModelId = transformModelForProvider(providerID, nextFallback.model)
  task.model = buildFallbackTaskModel(task, providerID, transformedModelId, nextFallback)

  const key = task.model ? `${task.model.providerID}/${task.model.modelID}` : task.agent
  enqueueRetryTask({
    task,
    key,
    retryInput: buildRetryInput(task),
    queuesByKey,
    processKey,
  })
  return true
}

function scheduleTransientRetry(args: {
  task: BackgroundTask
  errorInfo: { name?: string; message?: string }
  source: string
  concurrencyManager: ConcurrencyManager
  client: OpencodeClient
  idleDeferralTimers: Map<string, ReturnType<typeof setTimeout>>
  transientRetryTimers: Map<string, ReturnType<typeof setTimeout>>
  queuesByKey: Map<string, QueueItem[]>
  processKey: (key: string) => void
}): boolean {
  const { task, errorInfo, source, concurrencyManager, client, idleDeferralTimers, transientRetryTimers, queuesByKey, processKey } = args
  const now = Date.now()

  if (!canKeepRetryingTransiently(task, now)) {
    log("[background-agent] Transient retry window exhausted, moving to fallback chain:", {
      taskId: task.id,
      source,
      transientRetryCount: task.transientRetryCount ?? 0,
      currentModel: task.model ? `${task.model.providerID}/${task.model.modelID}` : undefined,
    })
    return switchToNextFallback(args)
  }

  if (task.transientRetryStartedAt === undefined) {
    task.transientRetryStartedAt = now
  }

  const delayMs = getNextTransientRetryDelayMs(task)
  task.transientRetryDelayMs = delayMs
  task.transientRetryCount = (task.transientRetryCount ?? 0) + 1

  log("[background-agent] Scheduling delayed transient retry on current model:", {
    taskId: task.id,
    source,
    errorName: errorInfo.name,
    errorMessage: errorInfo.message?.slice(0, 100),
    delayMs,
    transientRetryCount: task.transientRetryCount,
    currentModel: task.model ? `${task.model.providerID}/${task.model.modelID}` : undefined,
  })

  clearTransientRetryTimer(task.id, transientRetryTimers)
  prepareTaskForRetry({
    task,
    concurrencyManager,
    client,
    idleDeferralTimers,
  })

  const key = task.model ? `${task.model.providerID}/${task.model.modelID}` : task.agent
  const retryInput = buildRetryInput(task)
  const timer = setTimeout(() => {
    transientRetryTimers.delete(task.id)

    if (task.status !== "pending") {
      return
    }

    enqueueRetryTask({
      task,
      key,
      retryInput,
      queuesByKey,
      processKey,
    })
  }, delayMs)
  timer.unref?.()
  transientRetryTimers.set(task.id, timer)

  return true
}

export function tryFallbackRetry(args: {
  task: BackgroundTask
  errorInfo: { name?: string; message?: string }
  source: string
  concurrencyManager: ConcurrencyManager
  client: OpencodeClient
  idleDeferralTimers: Map<string, ReturnType<typeof setTimeout>>
  transientRetryTimers: Map<string, ReturnType<typeof setTimeout>>
  queuesByKey: Map<string, QueueItem[]>
  processKey: (key: string) => void
}): boolean {
  const { task, errorInfo, source, concurrencyManager, client, idleDeferralTimers, transientRetryTimers, queuesByKey, processKey } = args
  const fallbackChain = task.fallbackChain
  const canRetry =
    shouldRetryError(errorInfo) &&
    fallbackChain &&
    fallbackChain.length > 0 &&
    hasMoreFallbacks(fallbackChain, task.attemptCount ?? 0)

  if (!canRetry) return false

  const action = getRuntimeFallbackAction(
    errorInfo,
    DEFAULT_RUNTIME_FALLBACK_CONFIG.retry_on_errors,
  )

  if (action === "retry_same_model") {
    return scheduleTransientRetry({
      task,
      errorInfo,
      source,
      concurrencyManager,
      client,
      idleDeferralTimers,
      transientRetryTimers,
      queuesByKey,
      processKey,
    })
  }

  return switchToNextFallback({
    task,
    errorInfo,
    source,
    concurrencyManager,
    client,
    idleDeferralTimers,
    transientRetryTimers,
    queuesByKey,
    processKey,
  })
}

export function tryFallbackSwitch(args: {
  task: BackgroundTask
  errorInfo: { name?: string; message?: string }
  source: string
  concurrencyManager: ConcurrencyManager
  client: OpencodeClient
  idleDeferralTimers: Map<string, ReturnType<typeof setTimeout>>
  transientRetryTimers: Map<string, ReturnType<typeof setTimeout>>
  queuesByKey: Map<string, QueueItem[]>
  processKey: (key: string) => void
}): boolean {
  const { task, errorInfo, source, concurrencyManager, client, idleDeferralTimers, transientRetryTimers, queuesByKey, processKey } = args
  const fallbackChain = task.fallbackChain
  const canSwitch =
    shouldSwitchFallback(errorInfo) &&
    fallbackChain &&
    fallbackChain.length > 0 &&
    hasMoreFallbacks(fallbackChain, task.attemptCount ?? 0)

  if (!canSwitch) return false

  return switchToNextFallback({
    task,
    errorInfo,
    source,
    concurrencyManager,
    client,
    idleDeferralTimers,
    transientRetryTimers,
    queuesByKey,
    processKey,
  })
}
