import { readFileSync, writeFileSync } from "node:fs"
import type { ConfigMergeResult } from "../types"
import { PLUGIN_NAME, LEGACY_PLUGIN_NAME } from "../../shared"
import { getConfigDir } from "./config-context"
import { ensureConfigDirectoryExists } from "./ensure-config-directory-exists"
import { formatErrorWithSuggestion } from "./format-error-with-suggestion"
import { detectConfigFormat } from "./opencode-config-format"
import { parseOpenCodeConfigFileWithError, type OpenCodeConfig } from "./parse-opencode-config-file"
import { deepMergeRecord } from "./deep-merge-record"
import { getPersonalOpenCodeConfig } from "./personal-config-preset"
import { getPluginNameWithVersion } from "./plugin-name-with-version"

const MANAGED_HOST_KEYS = [
  "default_agent",
  "instructions",
  "plugin",
  "provider",
  "lsp",
] as const

export async function addPluginToOpenCodeConfig(currentVersion: string): Promise<ConfigMergeResult> {
  try {
    ensureConfigDirectoryExists()
  } catch (err) {
    return {
      success: false,
      configPath: getConfigDir(),
      error: formatErrorWithSuggestion(err, "create config directory"),
    }
  }

  const { format, path } = detectConfigFormat()
  const pluginEntry = await getPluginNameWithVersion(currentVersion, PLUGIN_NAME)
  const presetConfig = getPersonalOpenCodeConfig(pluginEntry)

  try {
    if (format === "none") {
      const config = presetConfig
      writeFileSync(path, JSON.stringify(config, null, 2) + "\n")
      return { success: true, configPath: path }
    }

    const parseResult = parseOpenCodeConfigFileWithError(path)
    if (!parseResult.config) {
      return {
        success: false,
        configPath: path,
        error: parseResult.error ?? "Failed to parse config file",
      }
    }

    const config = deepMergeRecord(
      parseResult.config,
      presetConfig,
    ) as OpenCodeConfig
    for (const key of MANAGED_HOST_KEYS) {
      if (key in presetConfig) {
        ;(config as Record<string, unknown>)[key] = structuredClone(
          presetConfig[key],
        )
      }
    }
    const plugins = config.plugin ?? []
    const presetPlugins = presetConfig.plugin ?? []
    const isPluginPackageEntry = (plugin: string) =>
      plugin === PLUGIN_NAME || plugin.startsWith(`${PLUGIN_NAME}@`) ||
      plugin === LEGACY_PLUGIN_NAME || plugin.startsWith(`${LEGACY_PLUGIN_NAME}@`)

    const canonicalEntries = plugins.filter(
      (plugin) => plugin === PLUGIN_NAME || plugin.startsWith(`${PLUGIN_NAME}@`)
    )
    const legacyEntries = plugins.filter(
      (plugin) => plugin === LEGACY_PLUGIN_NAME || plugin.startsWith(`${LEGACY_PLUGIN_NAME}@`)
    )
    const otherPlugins = [...new Set([
      ...presetPlugins.filter((plugin) => !isPluginPackageEntry(plugin)),
      ...plugins.filter((plugin) => !isPluginPackageEntry(plugin)),
    ])]

    const normalizedPlugins: string[] = []

    if (canonicalEntries.length > 0) {
      normalizedPlugins.push(canonicalEntries[0])
    } else if (legacyEntries.length > 0) {
      const versionMatch = legacyEntries[0].match(/@(.+)$/)
      const preservedVersion = versionMatch ? versionMatch[1] : null
      normalizedPlugins.push(preservedVersion ? `${PLUGIN_NAME}@${preservedVersion}` : pluginEntry)
    } else {
      normalizedPlugins.push(pluginEntry)
    }

    normalizedPlugins.push(...otherPlugins)

    config.plugin = normalizedPlugins

    writeFileSync(path, JSON.stringify(config, null, 2) + "\n")

    return { success: true, configPath: path }
  } catch (err) {
    return {
      success: false,
      configPath: path,
      error: formatErrorWithSuggestion(err, "update opencode config"),
    }
  }
}
