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
