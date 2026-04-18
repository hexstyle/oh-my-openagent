import type { OhMyOpenCodeConfig } from "../config"
import { flattenToFallbackModelStrings, normalizeFallbackModels } from "../shared/model-resolver"
import { parseFallbackModelEntry } from "../shared/fallback-chain-from-models"

export interface ConfiguredModelReference {
  model: string
  sources: string[]
}

export interface HostContextLimitReference {
  model: string
  requestedContext: number
  source: string
}

export interface FallbackPolicyViolation {
  source: string
  message: string
  chain: string[]
}

type HostConfigLike = {
  provider?: Record<string, { models?: Record<string, { limit?: { context?: number } }> }>
}

function normalizeConfiguredModel(value: string): string {
  const parsed = parseFallbackModelEntry(value, undefined)
  if (!parsed) {
    return value.trim()
  }

  return `${parsed.providers[0]}/${parsed.model}`
}

function addModelRef(target: Map<string, Set<string>>, model: string | undefined, source: string): void {
  if (!model || typeof model !== "string") {
    return
  }

  const normalized = normalizeConfiguredModel(model)
  if (!normalized) {
    return
  }

  const sources = target.get(normalized) ?? new Set<string>()
  sources.add(source)
  target.set(normalized, sources)
}

function addFallbackRefs(
  target: Map<string, Set<string>>,
  fallbackModels: string | unknown[] | undefined,
  sourcePrefix: string,
): void {
  const flattened = flattenToFallbackModelStrings(normalizeFallbackModels(fallbackModels as any)) ?? []
  const sourceBase =
    sourcePrefix === "fallback_models" || sourcePrefix.endsWith(".fallback_models")
      ? sourcePrefix
      : `${sourcePrefix}.fallback_models`
  flattened.forEach((model, index) => addModelRef(target, model, `${sourceBase}[${index}]`))
}

function flattenFallbackChain(fallbackModels: string | unknown[] | undefined): string[] {
  return flattenToFallbackModelStrings(normalizeFallbackModels(fallbackModels as any)) ?? []
}

function isFreeModel(model: string): boolean {
  const normalized = normalizeConfiguredModel(model).toLowerCase()
  return /(^|\/)big-pickle(?:\(|$)/i.test(normalized) || /(^|\/)[^/]+-free(?:\(|$)/i.test(normalized)
}

function isPaidOpenAIModel(model: string): boolean {
  return normalizeConfiguredModel(model).toLowerCase().startsWith("openai/")
}

function isPaidAnthropicModel(model: string): boolean {
  return normalizeConfiguredModel(model).toLowerCase().startsWith("anthropic/")
}

export function collectFallbackPolicyViolations(
  pluginConfig: OhMyOpenCodeConfig | null | undefined,
): FallbackPolicyViolation[] {
  if (!pluginConfig) {
    return []
  }

  const chains: Array<{ source: string; chain: string[] }> = []
  const pushChain = (source: string, fallbackModels: string | unknown[] | undefined) => {
    const chain = flattenFallbackChain(fallbackModels)
    if (chain.length === 0) {
      return
    }
    chains.push({ source, chain })
  }

  pushChain("fallback_models", pluginConfig.fallback_models)

  for (const [agentName, agentConfig] of Object.entries(pluginConfig.agents ?? {})) {
    pushChain(`agents.${agentName}.fallback_models`, agentConfig?.fallback_models)
  }

  for (const [categoryName, categoryConfig] of Object.entries(pluginConfig.categories ?? {})) {
    pushChain(`categories.${categoryName}.fallback_models`, categoryConfig?.fallback_models)
  }

  const violations: FallbackPolicyViolation[] = []

  for (const { source, chain } of chains) {
    const firstFreeIndex = chain.findIndex((model) => isFreeModel(model))
    if (firstFreeIndex === -1) {
      continue
    }

    const beforeFree = chain.slice(0, firstFreeIndex)
    const afterFree = chain.slice(firstFreeIndex + 1)
    const trailingPaid = afterFree.filter((model) => !isFreeModel(model))

    if (!beforeFree.some((model) => isPaidOpenAIModel(model))) {
      violations.push({
        source,
        chain,
        message: "free fallback requires at least one paid OpenAI/Codex model before free models",
      })
    }

    if (!beforeFree.some((model) => isPaidAnthropicModel(model))) {
      violations.push({
        source,
        chain,
        message: "free fallback requires at least one paid Claude model before free models",
      })
    }

    if (trailingPaid.length > 0) {
      violations.push({
        source,
        chain,
        message: "paid fallback models must appear before free models",
      })
    }
  }

  return violations
}

export function extractConfiguredModelReferences(
  pluginConfig: OhMyOpenCodeConfig | null | undefined,
  hostConfig?: HostConfigLike | null,
): {
  models: ConfiguredModelReference[]
  hostContextLimits: HostContextLimitReference[]
} {
  const refs = new Map<string, Set<string>>()
  const hostContextLimits: HostContextLimitReference[] = []

  if (pluginConfig) {
    addFallbackRefs(refs, pluginConfig.fallback_models, "fallback_models")

    for (const [agentName, agentConfig] of Object.entries(pluginConfig.agents ?? {})) {
      addModelRef(refs, agentConfig?.model, `agents.${agentName}.model`)
      addFallbackRefs(refs, agentConfig?.fallback_models, `agents.${agentName}`)
    }

    for (const [categoryName, categoryConfig] of Object.entries(pluginConfig.categories ?? {})) {
      addModelRef(refs, categoryConfig?.model, `categories.${categoryName}.model`)
      addFallbackRefs(refs, categoryConfig?.fallback_models, `categories.${categoryName}`)
    }

    for (const model of Object.keys(pluginConfig.background_task?.modelConcurrency ?? {})) {
      addModelRef(refs, model, `background_task.modelConcurrency.${model}`)
    }
  }

  for (const [providerID, providerConfig] of Object.entries(hostConfig?.provider ?? {})) {
    for (const [modelID, modelConfig] of Object.entries(providerConfig.models ?? {})) {
      const fullModel = `${providerID}/${modelID}`
      addModelRef(refs, fullModel, `provider.${providerID}.models.${modelID}`)

      const requestedContext = modelConfig.limit?.context
      if (typeof requestedContext === "number") {
        hostContextLimits.push({
          model: fullModel,
          requestedContext,
          source: `provider.${providerID}.models.${modelID}.limit.context`,
        })
      }
    }
  }

  return {
    models: Array.from(refs.entries())
      .map(([model, sources]) => ({
        model,
        sources: Array.from(sources).sort((left, right) => left.localeCompare(right)),
      }))
      .sort((left, right) => left.model.localeCompare(right.model)),
    hostContextLimits: hostContextLimits.sort((left, right) =>
      left.source.localeCompare(right.source),
    ),
  }
}
