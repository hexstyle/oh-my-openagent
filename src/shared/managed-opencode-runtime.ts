import { pathToFileURL } from "node:url"

export const MANAGED_RUNTIME_PLUGIN_DEPENDENCIES = {
  "opencode-claude-auth": "1.4.7",
  "opencode-helicone-session": "1.0.1",
  "@nick-vi/opencode-type-inject": "1.5.1",
} as const

export const MANAGED_HOST_PLUGIN_ENTRIES = [
  "oh-my-openagent",
  "opencode-claude-auth",
  "opencode-helicone-session",
  "@nick-vi/opencode-type-inject",
] as const

export const MANAGED_HOST_INSTRUCTION_ENTRIES = [
  "./node_modules/oh-my-openagent/assets/custom-opencode/instructions/non-interactive-shell.md",
] as const

export function getManagedLivePluginEntries(repoRoot: string): string[] {
  return [
    pathToFileURL(repoRoot).toString(),
    ...MANAGED_HOST_PLUGIN_ENTRIES.filter((entry) => entry !== "oh-my-openagent"),
  ]
}
