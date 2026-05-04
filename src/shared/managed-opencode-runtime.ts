import { pathToFileURL } from "node:url"

export const MANAGED_RUNTIME_PLUGIN_DEPENDENCIES = {
  "opencode-claude-auth": "1.5.3",
  "opencode-helicone-session": "1.0.1",
} as const

export const MANAGED_HOST_PLUGIN_ENTRIES = [
  "oh-my-openagent",
  "opencode-claude-auth",
  "opencode-helicone-session",
] as const

export const MANAGED_HOST_INSTRUCTION_ENTRIES = [
  "./node_modules/oh-my-openagent/assets/custom-opencode/instructions/non-interactive-shell.md",
] as const

export function getManagedConfigSchemaDependencySpec(repoRoot: string): string {
  return pathToFileURL(repoRoot).toString()
}

export function buildManagedConfigWorkspacePackage(
  currentPackageJson: Record<string, unknown> | undefined,
  repoRoot: string,
): Record<string, unknown> {
  const currentDependencies =
    typeof currentPackageJson?.dependencies === "object" && currentPackageJson.dependencies !== null
      ? { ...(currentPackageJson.dependencies as Record<string, unknown>) }
      : {}

  delete currentDependencies["oh-my-opencode"]
  currentDependencies["oh-my-openagent"] = getManagedConfigSchemaDependencySpec(repoRoot)

  return {
    ...(currentPackageJson ?? {}),
    dependencies: currentDependencies,
  }
}

export function getManagedLivePluginEntries(repoRoot: string): string[] {
  return [
    pathToFileURL(repoRoot).toString(),
    ...MANAGED_HOST_PLUGIN_ENTRIES.filter((entry) => entry !== "oh-my-openagent"),
  ]
}
