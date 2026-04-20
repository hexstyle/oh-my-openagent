import type { OhMyOpenCodeConfig } from "../../config"
import {
  resolveActualContextLimit,
  type ContextLimitModelCacheState,
} from "../../shared/context-limit-resolver"

const PREEMPTIVE_COMPACTION_THRESHOLD = 0.78
const PREEMPTIVE_COMPACTION_LOW_LIMIT_THRESHOLD = 0.68
const PREEMPTIVE_COMPACTION_LOW_LIMIT_CUTOFF = 300_000

export interface PreemptiveCompactionTokenInfo {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface PreemptiveCompactionCachedState {
  providerID: string
  modelID: string
  tokens: PreemptiveCompactionTokenInfo
}

export interface PreemptiveCompactionUsageSnapshot {
  totalInputTokens: number
  reachedAbsoluteThreshold: boolean
  actualLimit: number | null
  usageRatio: number | null
  threshold: number | null
  absoluteThreshold: number | null
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

function getTotalInputTokens(tokens: PreemptiveCompactionTokenInfo): number {
  return (tokens.input ?? 0) + (tokens.cache?.read ?? 0)
}

export function resolvePreemptiveCompactionUsageSnapshot(
  cached: PreemptiveCompactionCachedState,
  pluginConfig: OhMyOpenCodeConfig,
  modelCacheState?: ContextLimitModelCacheState,
): PreemptiveCompactionUsageSnapshot {
  const totalInputTokens = getTotalInputTokens(cached.tokens)
  const actualLimit = resolveActualContextLimit(
    cached.providerID,
    cached.modelID,
    modelCacheState,
  )
  const absoluteThreshold = getPreemptiveCompactionAbsoluteThreshold(pluginConfig)
  const usageRatio = actualLimit === null ? null : totalInputTokens / actualLimit
  const threshold = actualLimit === null ? null : getPreemptiveCompactionThreshold(actualLimit)

  return {
    totalInputTokens,
    reachedAbsoluteThreshold:
      actualLimit === null
      && absoluteThreshold !== null
      && totalInputTokens >= absoluteThreshold,
    actualLimit,
    usageRatio,
    threshold,
    absoluteThreshold,
  }
}

export function isPreemptiveCompactionThresholdReached(
  snapshot: PreemptiveCompactionUsageSnapshot,
): boolean {
  if (snapshot.reachedAbsoluteThreshold) return true
  if (snapshot.usageRatio === null || snapshot.threshold === null) return false
  return snapshot.usageRatio >= snapshot.threshold
}
