import type { OhMyOpenCodeConfig } from "../../config"
import type { FallbackModelObject } from "../../config/schema/fallback-models"
import { agentPattern, normalizeAgentName } from "./agent-resolver"
import { HOOK_NAME } from "./constants"
import { log } from "../../shared/logger"
import { SessionCategoryRegistry } from "../../shared/session-category-registry"
import { normalizeFallbackModels, flattenToFallbackModelStrings } from "../../shared/model-resolver"
import { readCachedModelCatalog, resolveKnownCachedModel } from "../../shared/model-availability"

/**
 * Returns fallback model strings for the runtime-fallback system.
 * Object entries are flattened to "provider/model(variant)" strings so the
 * string-based fallback state machine can work with them unchanged.
 */
export function getFallbackModelsForSession(
  sessionID: string,
  agent: string | undefined,
  pluginConfig: OhMyOpenCodeConfig | undefined
): string[] {
  if (!pluginConfig) return []

  const raw = getRawFallbackModelsForSession(sessionID, agent, pluginConfig)
  const flattened = flattenToFallbackModelStrings(raw) ?? []
  if (flattened.length === 0) {
    return flattened
  }

  const knownModels = readCachedModelCatalog()
  if (knownModels.size === 0) {
    return flattened
  }

  const filtered = flattened.filter((model) => resolveKnownCachedModel(model, knownModels))
  if (filtered.length === 0) {
    log(`[${HOOK_NAME}] Preserving unfiltered fallback_models because cached catalog could not confirm any candidate`, {
      sessionID,
      agent,
      candidateCount: flattened.length,
    })
    return flattened
  }

  if (filtered.length !== flattened.length) {
    log(`[${HOOK_NAME}] Filtered unknown fallback models from session fallback chain`, {
      sessionID,
      agent,
      removed: flattened.filter((model) => !filtered.includes(model)),
    })
  }

  return filtered
}

/**
 * Returns the raw fallback model entries (strings and objects) for a session.
 * Use this when per-model settings (temperature, reasoningEffort, etc.) must be
 * preserved — e.g. before passing to buildFallbackChainFromModels.
 */
export function getRawFallbackModels(
  sessionID: string,
  agent: string | undefined,
  pluginConfig: OhMyOpenCodeConfig | undefined,
): (string | FallbackModelObject)[] | undefined {
  if (!pluginConfig) return undefined
  return getRawFallbackModelsForSession(sessionID, agent, pluginConfig)
}

function getRawFallbackModelsForSession(
  sessionID: string,
  agent: string | undefined,
  pluginConfig: OhMyOpenCodeConfig,
): (string | FallbackModelObject)[] | undefined {
  const sessionCategory = SessionCategoryRegistry.get(sessionID)
  if (sessionCategory && pluginConfig.categories?.[sessionCategory]) {
    const categoryConfig = pluginConfig.categories[sessionCategory]
    if (categoryConfig && "fallback_models" in categoryConfig) {
      return normalizeFallbackModels(categoryConfig.fallback_models)
    }
  }

  const tryGetFallbackFromAgent = (agentName: string): (string | FallbackModelObject)[] | undefined => {
    const normalizedAgentName = normalizeAgentName(agentName) ?? agentName
    const agentConfig = pluginConfig.agents?.[normalizedAgentName as keyof typeof pluginConfig.agents]
    if (!agentConfig) return undefined

    if ("fallback_models" in agentConfig) {
      return normalizeFallbackModels(agentConfig.fallback_models)
    }

    const agentCategory = agentConfig?.category
    if (agentCategory && pluginConfig.categories?.[agentCategory]) {
      const categoryConfig = pluginConfig.categories[agentCategory]
      if (categoryConfig && "fallback_models" in categoryConfig) {
        return normalizeFallbackModels(categoryConfig.fallback_models)
      }
    }

    return undefined
  }

  if (agent) {
    const result = tryGetFallbackFromAgent(agent)
    if (result) return result
  }

  const sessionAgentMatch = sessionID.match(agentPattern)
  if (sessionAgentMatch) {
    const detectedAgent = sessionAgentMatch[1].toLowerCase()
    const result = tryGetFallbackFromAgent(detectedAgent)
    if (result) return result
  }

  // Fallback to root-level fallback_models when agent/category resolution fails
  if ("fallback_models" in pluginConfig) {
    log(`[${HOOK_NAME}] Using root-level fallback_models for session`, { sessionID, agent })
    return normalizeFallbackModels(pluginConfig.fallback_models)
  }

  log(`[${HOOK_NAME}] No category/agent fallback models resolved for session`, { sessionID, agent })

  return undefined
}
