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
  const compactedSessions = new Set<string>()
  const lastCompactionTime = new Map<string, number>()
  const tokenCache = new Map<string, CachedCompactionState>()

  const maybeCompactSession = async (sessionID: string): Promise<void> => {
    if (compactedSessions.has(sessionID) || compactionInProgress.has(sessionID)) return

    const lastTime = lastCompactionTime.get(sessionID)
    if (lastTime && Date.now() - lastTime < PREEMPTIVE_COMPACTION_COOLDOWN_MS) return

    const cached = tokenCache.get(sessionID)
    if (!cached) return

    const totalInputTokens = (cached.tokens.input ?? 0) + (cached.tokens.cache?.read ?? 0)
    const absoluteThreshold = getPreemptiveCompactionAbsoluteThreshold(pluginConfig)
    const reachedAbsoluteThreshold = absoluteThreshold !== null && totalInputTokens >= absoluteThreshold
    const actualLimit = resolveActualContextLimit(
      cached.providerID,
      cached.modelID,
      modelCacheState,
    )

    if (actualLimit === null && !reachedAbsoluteThreshold) {
      log("[preemptive-compaction] Skipping preemptive compaction: unknown context limit for model", {
        providerID: cached.providerID,
        modelID: cached.modelID,
        totalInputTokens,
        absoluteThreshold,
      })
      return
    }

    const usageRatio = actualLimit === null ? null : totalInputTokens / actualLimit
    const threshold = actualLimit === null ? null : getPreemptiveCompactionThreshold(actualLimit)

    if (
      (!reachedAbsoluteThreshold && usageRatio !== null && threshold !== null && usageRatio < threshold)
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

      compactedSessions.add(sessionID)
    } catch (error) {
      log("[preemptive-compaction] Compaction failed", { sessionID, error: String(error) })
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
        compactedSessions.delete(sessionID)
        lastCompactionTime.delete(sessionID)
        tokenCache.delete(sessionID)
        postCompactionMonitor.clear(sessionID)
      }
      return
    }

    if (event.type === "session.compacted") {
      const sessionID = (props?.sessionID as string | undefined)
        ?? (props?.info as { id?: string } | undefined)?.id
      if (sessionID) {
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
      compactedSessions.delete(info.sessionID)

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
