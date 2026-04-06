import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseJsonc } from "../../shared"
import type { ConfigMergeResult, InstallConfig } from "../types"
import { getConfigDir, getOmoConfigPath } from "./config-context"
import { deepMergeRecord } from "./deep-merge-record"
import { ensureConfigDirectoryExists } from "./ensure-config-directory-exists"
import { formatErrorWithSuggestion } from "./format-error-with-suggestion"
import { getPersonalOmoConfig } from "./personal-config-preset"
import { AGENT_NAME_MAP, migrateAgentNames } from "../../shared/migration"
import { normalizeAgentForPrompt } from "../../shared/agent-display-names"
import { CONFIG_BASENAME, LEGACY_CONFIG_BASENAME } from "../../shared/plugin-identity"

function isEmptyOrWhitespace(content: string): boolean {
  return content.trim().length === 0
}

const MANAGED_OMO_KEYS = [
  "default_run_agent",
  "agents",
  "categories",
  "background_task",
  "hashline_edit",
  "sisyphus",
  "sisyphus_agent",
  "babysitting",
  "model_capabilities",
  "experimental",
  "notification",
  "fallback_models",
  "runtime_fallback",
  "disabled_agents",
] as const

function canonicalizeDisabledAgents(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined

  return [...new Set(
    value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => AGENT_NAME_MAP[entry] ?? AGENT_NAME_MAP[entry.toLowerCase()] ?? entry)
  )]
}

function canonicalizeOmoConfig(config: Record<string, unknown>): Record<string, unknown> {
  const nextConfig = structuredClone(config)

  if (nextConfig.agents && typeof nextConfig.agents === "object" && !Array.isArray(nextConfig.agents)) {
    nextConfig.agents = migrateAgentNames(nextConfig.agents as Record<string, unknown>).migrated
  }

  const disabledAgents = canonicalizeDisabledAgents(nextConfig.disabled_agents)
  if (disabledAgents !== undefined) {
    nextConfig.disabled_agents = disabledAgents
  }

  if (typeof nextConfig.default_run_agent === "string") {
    nextConfig.default_run_agent =
      normalizeAgentForPrompt(nextConfig.default_run_agent) ?? nextConfig.default_run_agent.trim()
  }

  return nextConfig
}

function removeLegacyPluginConfig(configDir: string): void {
  for (const extension of [".json", ".jsonc"] as const) {
    const legacyPath = join(configDir, `${LEGACY_CONFIG_BASENAME}${extension}`)
    const canonicalPath = join(configDir, `${CONFIG_BASENAME}${extension}`)
    if (!existsSync(legacyPath) || legacyPath === canonicalPath) continue
    rmSync(legacyPath, { force: true })
  }
}

export function writeOmoConfig(installConfig: InstallConfig): ConfigMergeResult {
  try {
    ensureConfigDirectoryExists()
  } catch (err) {
    return {
      success: false,
      configPath: getConfigDir(),
      error: formatErrorWithSuggestion(err, "create config directory"),
    }
  }

  const omoConfigPath = getOmoConfigPath()

  try {
    const newConfig = canonicalizeOmoConfig(getPersonalOmoConfig())

    if (existsSync(omoConfigPath)) {
      try {
        const stat = statSync(omoConfigPath)
        const content = readFileSync(omoConfigPath, "utf-8")

        if (stat.size === 0 || isEmptyOrWhitespace(content)) {
          writeFileSync(omoConfigPath, JSON.stringify(newConfig, null, 2) + "\n")
          removeLegacyPluginConfig(getConfigDir())
          return { success: true, configPath: omoConfigPath }
        }

        const existing = parseJsonc<Record<string, unknown>>(content)
        if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
          writeFileSync(omoConfigPath, JSON.stringify(newConfig, null, 2) + "\n")
          removeLegacyPluginConfig(getConfigDir())
          return { success: true, configPath: omoConfigPath }
        }

        const merged = deepMergeRecord(existing, newConfig)
        for (const key of MANAGED_OMO_KEYS) {
          if (key in newConfig) {
            merged[key] = structuredClone(newConfig[key]) as unknown
          } else {
            delete merged[key]
          }
        }
        const canonicalMerged = canonicalizeOmoConfig(merged)
        writeFileSync(omoConfigPath, JSON.stringify(canonicalMerged, null, 2) + "\n")
      } catch (parseErr) {
        if (parseErr instanceof SyntaxError) {
          writeFileSync(omoConfigPath, JSON.stringify(newConfig, null, 2) + "\n")
          removeLegacyPluginConfig(getConfigDir())
          return { success: true, configPath: omoConfigPath }
        }
        throw parseErr
      }
    } else {
      writeFileSync(omoConfigPath, JSON.stringify(newConfig, null, 2) + "\n")
    }

    removeLegacyPluginConfig(getConfigDir())

    return { success: true, configPath: omoConfigPath }
  } catch (err) {
    return {
      success: false,
      configPath: omoConfigPath,
      error: formatErrorWithSuggestion(err, "write oh-my-opencode config"),
    }
  }
}
