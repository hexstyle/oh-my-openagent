import { AGENT_DISPLAY_NAMES } from "../shared/agent-display-names"

export function remapAgentKeysToDisplayNames(
  agents: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(agents)) {
    const displayName = AGENT_DISPLAY_NAMES[key]
    if (displayName && displayName !== key) {
      // Register under display name (what OpenCode UI shows and resolves).
      result[displayName] = value
      // Also register under config key (what internal lookups use: "prometheus", "atlas", etc.).
      result[key] = value
    } else {
      result[key] = value
    }
  }

  return result
}
