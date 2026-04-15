import type { OhMyOpenCodeConfig } from "../../config"
import { HOOK_NAME } from "./constants"
import { buildModelStringWithVariant } from "./event-model"
import { log } from "../../shared/logger"
import { SessionCategoryRegistry } from "../../shared/session-category-registry"

type ResolveFallbackBootstrapModelOptions = {
  sessionID: string
  source: string
  eventModel?: string
  resolvedAgent?: string
  pluginConfig?: OhMyOpenCodeConfig
}

export function resolveFallbackBootstrapModel(
  options: ResolveFallbackBootstrapModelOptions,
): string | undefined {
  if (options.eventModel) {
    return options.eventModel
  }

  const agentConfigs = options.pluginConfig?.agents
  const agentConfig = options.resolvedAgent && agentConfigs
    ? agentConfigs[options.resolvedAgent as keyof typeof agentConfigs]
    : undefined
  const agentModel = typeof agentConfig?.model === "string"
    ? buildModelStringWithVariant(agentConfig.model, agentConfig.variant)
    : undefined
  if (agentModel) {
    log(`[${HOOK_NAME}] Derived model from agent config for ${options.source}`, {
      sessionID: options.sessionID,
      agent: options.resolvedAgent,
      model: agentModel,
    })
    return agentModel
  }

  const agentCategory = typeof agentConfig?.category === "string" ? agentConfig.category : undefined
  if (agentCategory) {
    const agentCategoryConfig = options.pluginConfig?.categories?.[agentCategory]
    const agentCategoryModel = typeof agentCategoryConfig?.model === "string"
      ? buildModelStringWithVariant(agentCategoryConfig.model, agentCategoryConfig.variant)
      : undefined
    if (typeof agentCategoryModel === "string" && agentCategoryModel.length > 0) {
      log(`[${HOOK_NAME}] Derived model from agent category config for ${options.source}`, {
        sessionID: options.sessionID,
        agent: options.resolvedAgent,
        category: agentCategory,
        model: agentCategoryModel,
      })
      return agentCategoryModel
    }
  }

  const sessionCategory = SessionCategoryRegistry.get(options.sessionID)
  const categoryConfig = sessionCategory
    ? options.pluginConfig?.categories?.[sessionCategory]
    : undefined
  const categoryModel = typeof categoryConfig?.model === "string"
    ? buildModelStringWithVariant(categoryConfig.model, categoryConfig.variant)
    : undefined
  if (typeof categoryModel === "string" && categoryModel.length > 0) {
    log(`[${HOOK_NAME}] Derived model from session category config for ${options.source}`, {
      sessionID: options.sessionID,
      category: sessionCategory,
      model: categoryModel,
    })
    return categoryModel
  }

  return undefined
}
