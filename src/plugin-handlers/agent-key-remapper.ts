import {
  getAgentConfigKey,
  getAgentDisplayName,
  normalizeAgentForPrompt,
  PRESERVE_CONFIG_KEY_AGENTS,
} from "../shared/agent-display-names"

function normalizeAgentPayloadName(
  value: unknown,
  runtimeName: string,
  canonicalKey: string,
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value
  }

  const record = value as Record<string, unknown>
  const isKnownBuiltinAgent = getAgentDisplayName(canonicalKey) !== canonicalKey
  const currentName = typeof record.name === "string" ? record.name : undefined
  const normalizedName = isKnownBuiltinAgent
    ? runtimeName
    : normalizeAgentForPrompt(currentName)

  if (normalizedName === undefined || normalizedName === currentName) {
    return value
  }

  return {
    ...record,
    name: normalizedName,
  }
}

export function remapAgentKeysToDisplayNames(
  agents: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(agents)) {
    const canonicalKey = getAgentConfigKey(key)
    const displayName = getAgentDisplayName(canonicalKey)
    const preserveConfigKey = PRESERVE_CONFIG_KEY_AGENTS.has(canonicalKey)
    const outputKey = preserveConfigKey
      ? canonicalKey
      : displayName !== canonicalKey
        ? displayName
        : key
    const runtimeName = preserveConfigKey
      ? canonicalKey
      : displayName !== canonicalKey
        ? displayName
        : outputKey

    if (outputKey !== key) {
      result[outputKey] = normalizeAgentPayloadName(
        value,
        runtimeName,
        canonicalKey,
      )
    } else {
      result[key] = normalizeAgentPayloadName(value, runtimeName, canonicalKey)
    }
  }

  return result
}
