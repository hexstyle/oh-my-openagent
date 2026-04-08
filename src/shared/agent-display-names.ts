import { AGENT_NAME_MAP } from "./migration/agent-names"

/**
 * Agent config keys to display names mapping.
 * Config keys are lowercase (e.g., "sisyphus", "atlas").
 * Display names include suffixes for UI/logs (e.g., "Sisyphus (Ultraworker)").
 */
export const AGENT_DISPLAY_NAMES: Record<string, string> = {
  sisyphus: "Sisyphus (Ultraworker)",
  hephaestus: "Hephaestus (Deep Agent)",
  prometheus: "Prometheus (Plan Builder)",
  atlas: "Atlas (Plan Executor)",
  "sisyphus-junior": "Sisyphus Junior (Focused Executor)",
  metis: "Metis (Plan Consultant)",
  momus: "Momus (Plan Critic)",
  athena: "Athena (Council)",
  "athena-junior": "Athena Junior (Council)",
  oracle: "Oracle (Strategic Advisor)",
  librarian: "Librarian (OSS Research)",
  explore: "Explore (Code Search)",
  "multimodal-looker": "Multimodal Looker (Document Vision)",
  "council-member": "Council Member (Advisor)",
}

export const PRESERVE_CONFIG_KEY_AGENTS = new Set(["explore"])
export const PRIMARY_RUNTIME_AGENTS = new Set(["sisyphus", "hephaestus", "prometheus", "atlas"])

/**
 * Get display name for an agent config key.
 * Uses case-insensitive lookup for backward compatibility.
 * Returns original key if not found.
 */
export function getAgentDisplayName(configKey: string): string {
  // Try exact match first
  const exactMatch = AGENT_DISPLAY_NAMES[configKey]
  if (exactMatch !== undefined) return exactMatch
  
  // Fall back to case-insensitive search
  const lowerKey = configKey.toLowerCase()
  for (const [k, v] of Object.entries(AGENT_DISPLAY_NAMES)) {
    if (k.toLowerCase() === lowerKey) return v
  }
  
  // Unknown agent: return original key
  return configKey
}

const REVERSE_DISPLAY_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(AGENT_DISPLAY_NAMES).map(([key, displayName]) => [displayName.toLowerCase(), key]),
)

/**
 * Resolve an agent name (display name or config key) to its lowercase config key.
 * "Atlas (Plan Executor)" → "atlas", "atlas" → "atlas", "unknown" → "unknown"
 */
export function getAgentConfigKey(agentName: string): string {
  const trimmed = agentName.trim()
  const lower = trimmed.toLowerCase()
  const reversed = REVERSE_DISPLAY_NAMES[lower]
  if (reversed !== undefined) return reversed
  const migrated =
    AGENT_NAME_MAP[trimmed] ??
    AGENT_NAME_MAP[lower]
  if (migrated !== undefined) return migrated
  if (AGENT_DISPLAY_NAMES[lower] !== undefined) return lower
  return lower
}

/**
 * Normalize an agent name for prompt APIs.
 * - Known display names -> canonical display names
 * - Known config keys (any case) -> canonical display names
 * - Unknown/custom names -> preserved as-is (trimmed)
 */
export function normalizeAgentForPrompt(agentName: string | undefined): string | undefined {
  if (typeof agentName !== "string") {
    return undefined
  }

  const trimmed = agentName.trim()
  if (!trimmed) {
    return undefined
  }

  const configKey = getAgentConfigKey(trimmed)
  const displayName = getAgentDisplayName(configKey)
  if (displayName !== configKey) {
    return displayName
  }

  return trimmed
}

/**
 * Normalize an agent name for session prompt APIs (`session.prompt` / `session.promptAsync`).
 * Reserved runtime agents such as `explore` must stay on their internal execution key.
 * All other known agents are normalized to their canonical display names.
 */
export function normalizeAgentForSessionPrompt(agentName: string | undefined): string | undefined {
  if (typeof agentName !== "string") {
    return undefined
  }

  const trimmed = agentName.trim()
  if (!trimmed) {
    return undefined
  }

  const configKey = getAgentConfigKey(trimmed)
  if (PRESERVE_CONFIG_KEY_AGENTS.has(configKey)) {
    return configKey
  }

  const displayName = getAgentDisplayName(configKey)
  if (displayName !== configKey) {
    return displayName
  }

  return trimmed
}

/**
 * Normalize an agent name for execution paths that must preserve internal runtime keys.
 * Reserved runtime agents (for example `explore`) are always mapped to their config key.
 * All other agent names are preserved as provided, aside from trimming.
 */
export function normalizeAgentForExecution(agentName: string | undefined): string | undefined {
  if (typeof agentName !== "string") {
    return undefined
  }

  const trimmed = agentName.trim()
  if (!trimmed) {
    return undefined
  }

  const configKey = getAgentConfigKey(trimmed)
  if (PRESERVE_CONFIG_KEY_AGENTS.has(configKey)) {
    return configKey
  }

  return trimmed
}

export function isPrimaryRuntimeAgent(agentName: string | undefined): boolean {
  if (typeof agentName !== "string") {
    return false
  }

  const trimmed = agentName.trim()
  if (!trimmed) {
    return false
  }

  return PRIMARY_RUNTIME_AGENTS.has(getAgentConfigKey(trimmed))
}
