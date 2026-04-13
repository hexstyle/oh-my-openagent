import { log } from "../shared/logger"
import type { OhMyOpenCodeConfig } from "../config"
import {
  resolveActualContextLimit,
  type ContextLimitModelCacheState,
} from "../shared/context-limit-resolver"

import { resolveCompactionModel } from "./shared/compaction-model-resolver"
import { createPostCompactionDegradationMonitor } from "./preemptive-compaction-degradation-monitor"

const PREEMPTIVE_COMPACTION_TIMEOUT_MS = 120_000
const PREEMPTIVE_COMPACTION_THRESHOLD = 0.78
const PREEMPTIVE_COMPACTION_LOW_LIMIT_THRESHOLD = 0.68
const PREEMPTIVE_COMPACTION_LOW_LIMIT_CUTOFF = 300_000
const PREEMPTIVE_COMPACTION_COOLDOWN_MS = 60_000
const PREEMPTIVE_COMPACTION_COMPLETION_TIMEOUT_MS = 5 * 60_000
const POST_COMPACTION_REARM_TOKEN_DELTA = 25_000

declare function setTimeout(handler: () => void, timeout?: number): unknown
declare function clearTimeout(timeoutID: unknown): void

interface TokenInfo {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

interface CachedCompactionState {
  providerID: string
  modelID: string
  tokens: TokenInfo
}

interface CompactionUsageSnapshot {
  totalInputTokens: number
  reachedAbsoluteThreshold: boolean
  actualLimit: number | null
  usageRatio: number | null
  threshold: number | null
}

function createZeroTokenInfo(): TokenInfo {
  return {
    input: 0,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  }
}

function getPreemptiveCompactionThreshold(actualLimit: number): number {
  return actualLimit <= PREEMPTIVE_COMPACTION_LOW_LIMIT_CUTOFF
    ? PREEMPTIVE_COMPACTION_LOW_LIMIT_THRESHOLD
    : PREEMPTIVE_COMPACTION_THRESHOLD
}

function getPreemptiveCompactionAbsoluteThreshold(pluginConfig: OhMyOpenCodeConfig): number | null {
  const configured = pluginConfig.experimental?.preemptive_compaction_input_tokens
  if (typeof configured !== "number" || !Number.isFinite(configured) || configured <= 0) {
    return null
  }

  return Math.floor(configured)
}

function getTotalInputTokens(tokens: TokenInfo): number {
  return (tokens.input ?? 0) + (tokens.cache?.read ?? 0)
}

function resolveCompactionUsageSnapshot(
  cached: CachedCompactionState,
  pluginConfig: OhMyOpenCodeConfig,
  modelCacheState?: ContextLimitModelCacheState,
): CompactionUsageSnapshot {
  const totalInputTokens = getTotalInputTokens(cached.tokens)
  const absoluteThreshold = getPreemptiveCompactionAbsoluteThreshold(pluginConfig)
  const reachedAbsoluteThreshold = absoluteThreshold !== null && totalInputTokens >= absoluteThreshold
  const actualLimit = resolveActualContextLimit(
    cached.providerID,
    cached.modelID,
    modelCacheState,
  )
  const usageRatio = actualLimit === null ? null : totalInputTokens / actualLimit
  const threshold = actualLimit === null ? null : getPreemptiveCompactionThreshold(actualLimit)

  return {
    totalInputTokens,
    reachedAbsoluteThreshold,
    actualLimit,
    usageRatio,
    threshold,
  }
}

function isCompactionThresholdReached(snapshot: CompactionUsageSnapshot): boolean {
  if (snapshot.reachedAbsoluteThreshold) return true
  if (snapshot.usageRatio === null || snapshot.threshold === null) return false
  return snapshot.usageRatio >= snapshot.threshold
}

async function withTimeout<TValue>(
  promise: Promise<TValue>,
  timeoutMs: number,
  errorMessage: string,
): Promise<TValue> {
  let timeoutID: unknown

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutID = setTimeout(() => {
      reject(new Error(errorMessage))
    }, timeoutMs)
  })

  return await Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutID)
  })
}

type PluginInput = {
  client: {
    session: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: (...args: any[]) => any
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      summarize: (...args: any[]) => any
    }
    tui: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      showToast: (...args: any[]) => any
    }
  }
  directory: string
}

export function createPreemptiveCompactionHook(
  ctx: PluginInput,
  pluginConfig: OhMyOpenCodeConfig,
  modelCacheState?: ContextLimitModelCacheState,
) {
  const compactionInProgress = new Set<string>()
  const compactionAwaitingCompletion = new Set<string>()
  const compactionCompletionTimers = new Map<string, unknown>()
  const compactedSessions = new Set<string>()
  const lastCompactionTime = new Map<string, number>()
  const postCompactionBaselineTokens = new Map<string, number>()
  const tokenCache = new Map<string, CachedCompactionState>()

  const clearCompactionCompletionWait = (sessionID: string): void => {
    const timer = compactionCompletionTimers.get(sessionID)
    if (timer !== undefined) {
      clearTimeout(timer)
      compactionCompletionTimers.delete(sessionID)
    }
    compactionAwaitingCompletion.delete(sessionID)
  }

  const armCompactionCompletionWait = (sessionID: string): void => {
    clearCompactionCompletionWait(sessionID)
    compactionAwaitingCompletion.add(sessionID)

    const timer = setTimeout(() => {
      compactionCompletionTimers.delete(sessionID)
      compactionAwaitingCompletion.delete(sessionID)
    }, PREEMPTIVE_COMPACTION_COMPLETION_TIMEOUT_MS)

    compactionCompletionTimers.set(sessionID, timer)
  }

  const maybeCompactSession = async (sessionID: string): Promise<void> => {
    if (
      compactedSessions.has(sessionID)
      || compactionInProgress.has(sessionID)
      || compactionAwaitingCompletion.has(sessionID)
    ) return

    const lastTime = lastCompactionTime.get(sessionID)
    if (lastTime && Date.now() - lastTime < PREEMPTIVE_COMPACTION_COOLDOWN_MS) return

    const cached = tokenCache.get(sessionID)
    if (!cached) return

    const usageSnapshot = resolveCompactionUsageSnapshot(cached, pluginConfig, modelCacheState)
    const { totalInputTokens, reachedAbsoluteThreshold, actualLimit, usageRatio, threshold } = usageSnapshot
    const absoluteThreshold = getPreemptiveCompactionAbsoluteThreshold(pluginConfig)

    if (actualLimit === null && !reachedAbsoluteThreshold) {
      log("[preemptive-compaction] Skipping preemptive compaction: unknown context limit for model", {
        providerID: cached.providerID,
        modelID: cached.modelID,
        totalInputTokens,
        absoluteThreshold,
      })
      return
    }

    if (
      (!isCompactionThresholdReached(usageSnapshot))
      || !cached.modelID
    ) {
      return
    }

    compactionInProgress.add(sessionID)
    lastCompactionTime.set(sessionID, Date.now())

    try {
      const { providerID: targetProviderID, modelID: targetModelID } = resolveCompactionModel(
        pluginConfig,
        sessionID,
        cached.providerID,
        cached.modelID,
      )

      log("[preemptive-compaction] Triggering preemptive compaction", {
        sessionID,
        providerID: cached.providerID,
        modelID: cached.modelID,
        totalInputTokens,
        actualLimit,
        usageRatio,
        threshold,
        absoluteThreshold,
        reachedAbsoluteThreshold,
      })

      await withTimeout(
        ctx.client.session.summarize({
          path: { id: sessionID },
          body: { providerID: targetProviderID, modelID: targetModelID, auto: true } as never,
          query: { directory: ctx.directory },
        }),
        PREEMPTIVE_COMPACTION_TIMEOUT_MS,
        `Compaction summarize timed out after ${PREEMPTIVE_COMPACTION_TIMEOUT_MS}ms`,
      )

      lastCompactionTime.set(sessionID, Date.now())
      armCompactionCompletionWait(sessionID)
      compactedSessions.add(sessionID)
      postCompactionBaselineTokens.delete(sessionID)
    } catch (error) {
      log("[preemptive-compaction] Compaction failed", { sessionID, error: String(error) })
      clearCompactionCompletionWait(sessionID)
    } finally {
      compactionInProgress.delete(sessionID)
    }
  }

  const postCompactionMonitor = createPostCompactionDegradationMonitor({
    client: ctx.client,
    directory: ctx.directory,
    pluginConfig,
    tokenCache,
    compactionInProgress,
  })

  const toolExecuteAfter = async (
    input: { tool: string; sessionID: string; callID: string },
    _output: { title: string; output: string; metadata: unknown }
  ) => {
    await maybeCompactSession(input.sessionID)
  }

  const eventHandler = async ({ event }: { event: { type: string; properties?: unknown } }) => {
    const props = event.properties as Record<string, unknown> | undefined

    if (event.type === "session.deleted") {
      const sessionID = (props?.info as { id?: string } | undefined)?.id
      if (sessionID) {
        compactionInProgress.delete(sessionID)
        clearCompactionCompletionWait(sessionID)
        compactedSessions.delete(sessionID)
        lastCompactionTime.delete(sessionID)
        postCompactionBaselineTokens.delete(sessionID)
        tokenCache.delete(sessionID)
        postCompactionMonitor.clear(sessionID)
      }
      return
    }

    if (event.type === "session.compacted") {
      const sessionID = (props?.sessionID as string | undefined)
        ?? (props?.info as { id?: string } | undefined)?.id
      if (sessionID) {
        clearCompactionCompletionWait(sessionID)
        lastCompactionTime.set(sessionID, Date.now())
        compactedSessions.add(sessionID)
        postCompactionBaselineTokens.delete(sessionID)
        const cached = tokenCache.get(sessionID)
        if (cached) {
          tokenCache.set(sessionID, {
            ...cached,
            tokens: createZeroTokenInfo(),
          })
        }
        postCompactionMonitor.onSessionCompacted(sessionID)
      }
      return
    }

    if (event.type === "session.idle") {
      const sessionID = (props?.sessionID as string | undefined)
        ?? (props?.info as { id?: string } | undefined)?.id
      if (sessionID) {
        await maybeCompactSession(sessionID)
      }
      return
    }

    if (event.type === "message.updated") {
      const info = props?.info as {
        id?: string
        role?: string
        sessionID?: string
        providerID?: string
        modelID?: string
        finish?: boolean
        tokens?: TokenInfo
      } | undefined

      if (!info || info.role !== "assistant" || !info.finish || !info.sessionID) return

      if (info.providerID && info.tokens) {
        tokenCache.set(info.sessionID, {
          providerID: info.providerID,
          modelID: info.modelID ?? "",
          tokens: info.tokens,
        })
      }

      if (compactedSessions.has(info.sessionID)) {
        if (info.providerID && info.tokens) {
          const usageSnapshot = resolveCompactionUsageSnapshot(
            {
              providerID: info.providerID,
              modelID: info.modelID ?? "",
              tokens: info.tokens,
            },
            pluginConfig,
            modelCacheState,
          )

          if (!isCompactionThresholdReached(usageSnapshot)) {
            compactedSessions.delete(info.sessionID)
            postCompactionBaselineTokens.delete(info.sessionID)
          } else {
            const baselineTokens = postCompactionBaselineTokens.get(info.sessionID)

            if (baselineTokens === undefined) {
              postCompactionBaselineTokens.set(info.sessionID, usageSnapshot.totalInputTokens)
            } else if (
              usageSnapshot.totalInputTokens - baselineTokens >= POST_COMPACTION_REARM_TOKEN_DELTA
            ) {
              compactedSessions.delete(info.sessionID)
              postCompactionBaselineTokens.delete(info.sessionID)
            }
          }
        }
      } else {
        postCompactionBaselineTokens.delete(info.sessionID)
      }

      await postCompactionMonitor.onAssistantMessageUpdated({
        sessionID: info.sessionID,
        id: info.id,
      })
    }
  }

  return {
    "tool.execute.after": toolExecuteAfter,
    event: eventHandler,
  }
}
