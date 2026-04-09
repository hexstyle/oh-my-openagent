#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import { OhMyOpenCodeConfigSchema } from "../src/config"
import { extractConfiguredModelReferences } from "../src/custom-opencode/model-config-validation"
import { loadEffectiveUserConfig } from "../src/custom-opencode/user-config-layers"
import { mergeConfigs } from "../src/plugin-config"
import { findProviderModelMetadata, readProviderModelsCache, type ProviderModelsCache } from "../src/shared/connected-providers-cache"
import { getReadableOmoOpenCodeCacheDirs, getReadableOpenCodeCacheDirs } from "../src/shared/data-path"
import { parseJsonc } from "../src/shared/jsonc-parser"
import { __resetModelCache, readCachedModelCatalog, resolveKnownCachedModel } from "../src/shared/model-availability"
import { getOpenCodeConfigDir } from "../src/shared/opencode-config-dir"

type HostConfig = {
  provider?: Record<string, { models?: Record<string, { limit?: { context?: number } }> }>
}

type ModelsCache = Record<string, { models?: Record<string, { status?: string; limit?: { context?: number } }> }>
type RefreshResult = { refreshed: true } | { refreshed: false; warning: string }

function fail(message: string): never {
  throw new Error(message)
}

function refreshModelCatalog(): RefreshResult {
  const commands = [
    ["opencode", "models", "--refresh"],
    ["opencode", "models", "opencode", "--refresh"],
  ]

  for (const command of commands) {
    const result = Bun.spawnSync(command, {
      cwd: resolve(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    })
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString("utf-8").trim()
      const stdout = result.stdout.toString("utf-8").trim()
      return {
        refreshed: false,
        warning: `Failed to refresh model catalog via '${command.join(" ")}': ${stderr || stdout || "unknown error"}`,
      }
    }
  }

  return { refreshed: true }
}

function loadStrictConfig(pathValue: string, label: string) {
  const content = readFileSync(pathValue, "utf-8")
  const raw = parseJsonc<Record<string, unknown>>(content)
  const result = OhMyOpenCodeConfigSchema.safeParse(raw)
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join(", ")
    fail(`${label} is invalid: ${details}`)
  }
  return result.data
}

function getOpenCodeModelsCachePath(): string {
  return getReadableOpenCodeCacheDirs()
    .map((cacheDir) => join(cacheDir, "models.json"))
    .find((cacheFile) => existsSync(cacheFile))
    ?? join(getReadableOpenCodeCacheDirs()[0] ?? "", "models.json")
}

function getProviderModelsCachePath(): string {
  return getReadableOmoOpenCodeCacheDirs()
    .map((cacheDir) => join(cacheDir, "provider-models.json"))
    .find((cacheFile) => existsSync(cacheFile))
    ?? join(getReadableOmoOpenCodeCacheDirs()[0] ?? "", "provider-models.json")
}

function readModelsCache(): ModelsCache | null {
  const cacheFile = getOpenCodeModelsCachePath()
  if (!existsSync(cacheFile)) {
    return null
  }

  return parseJsonc<ModelsCache>(readFileSync(cacheFile, "utf-8"))
}

function getProviderModelContextLimit(
  providerModelsCache: ProviderModelsCache | null,
  providerID: string,
  modelID: string,
): number | null {
  const providerModel = findProviderModelMetadata(providerID, modelID, providerModelsCache)
  if (!providerModel) {
    return null
  }

  const status = typeof providerModel.status === "string" ? providerModel.status.toLowerCase() : ""
  if (status.includes("deprecated") || status.includes("disabled") || status.includes("removed")) {
    return null
  }

  const context = providerModel.limit?.context ?? providerModel.context
  return typeof context === "number" ? context : null
}

function getCachedModelContextLimit(
  modelsCache: ModelsCache | null,
  providerModelsCache: ProviderModelsCache | null,
  fullModel: string,
): number | null {
  const slashIndex = fullModel.indexOf("/")
  if (slashIndex <= 0 || slashIndex === fullModel.length - 1) {
    return null
  }

  const providerID = fullModel.slice(0, slashIndex)
  const modelID = fullModel.slice(slashIndex + 1)
  const modelEntry = modelsCache?.[providerID]?.models?.[modelID]
  if (modelEntry) {
    const status = typeof modelEntry.status === "string" ? modelEntry.status.toLowerCase() : ""
    if (status.includes("deprecated") || status.includes("disabled") || status.includes("removed")) {
      return null
    }

    const context = modelEntry.limit?.context
    return typeof context === "number" ? context : null
  }

  return getProviderModelContextLimit(providerModelsCache, providerID, modelID)
}

function main(): void {
  const repoRoot = resolve(import.meta.dir, "..")
  const configDir = getOpenCodeConfigDir({ binary: "opencode" })
  const managedHostAssetPath = join(repoRoot, "assets", "custom-opencode", "opencode.json")
  const managedPluginAssetPath = join(repoRoot, "assets", "custom-opencode", "oh-my-opencode.json")
  const effectiveUserConfig = loadEffectiveUserConfig(configDir, {})

  if (effectiveUserConfig.ignoredCanonicalJsoncPath) {
    fail(
      `Unsupported canonical JSONC config is still present: ${effectiveUserConfig.ignoredCanonicalJsoncPath}. ` +
      "Use oh-my-openagent.local.jsonc for user overrides.",
    )
  }

  if (!existsSync(managedHostAssetPath)) {
    fail(`Missing managed host asset: ${managedHostAssetPath}`)
  }

  if (!existsSync(managedPluginAssetPath)) {
    fail(`Missing managed plugin asset: ${managedPluginAssetPath}`)
  }

  const managedConfig = loadStrictConfig(managedPluginAssetPath, "Managed repo plugin config")
  const localOverrideConfig = effectiveUserConfig.localOverridePath
    ? loadStrictConfig(effectiveUserConfig.localOverridePath, "Local model override config")
    : null
  const effectiveConfig = localOverrideConfig ? mergeConfigs(managedConfig, localOverrideConfig) : managedConfig
  const hostConfig = parseJsonc<HostConfig>(readFileSync(managedHostAssetPath, "utf-8"))

  const refreshResult = refreshModelCatalog()
  __resetModelCache()
  const availableModels = readCachedModelCatalog()
  const modelsCache = readModelsCache()
  const providerModelsCache = readProviderModelsCache()

  if (!refreshResult.refreshed) {
    const cachePaths = [
      availableModels.size > 0 && existsSync(getOpenCodeModelsCachePath()) ? getOpenCodeModelsCachePath() : null,
      availableModels.size > 0 && existsSync(getProviderModelsCachePath()) ? getProviderModelsCachePath() : null,
    ].filter((entry): entry is string => Boolean(entry))

    if (availableModels.size === 0 || cachePaths.length === 0) {
      fail(`${refreshResult.warning}\nNo cached model catalog is available for offline validation.`)
    }

    console.warn(
      `[validate-model-config] Model catalog refresh is unavailable; using cached metadata from ${cachePaths.join(", ")}`,
    )
    console.warn(`[validate-model-config] Refresh failure: ${refreshResult.warning}`)
  }

  const references = extractConfiguredModelReferences(effectiveConfig, hostConfig)

  const missingModels = references.models
    .filter((entry) => !resolveKnownCachedModel(entry.model, availableModels))
    .map((entry) => `${entry.model} <- ${entry.sources.join(", ")}`)

  if (missingModels.length > 0) {
    fail(
      `Configured model IDs are not available in the refreshed catalog:\n${missingModels
        .map((entry) => `- ${entry}`)
        .join("\n")}`,
    )
  }

  const contextViolations = references.hostContextLimits
    .map((entry) => {
      const resolved = resolveKnownCachedModel(entry.model, availableModels)
      if (!resolved) {
        return null
      }

      const availableContext = getCachedModelContextLimit(modelsCache, providerModelsCache, resolved)
      if (availableContext === null) {
        return null
      }

      if (entry.requestedContext > availableContext) {
        return `${entry.source}: requested ${entry.requestedContext}, available ${availableContext} on ${resolved}`
      }

      return null
    })
    .filter((entry): entry is string => Boolean(entry))

  if (contextViolations.length > 0) {
    fail(
      `Configured context limits exceed the refreshed model metadata:\n${contextViolations
        .map((entry) => `- ${entry}`)
        .join("\n")}`,
    )
  }

  const localOverrideLabel = effectiveUserConfig.localOverridePath
    ? ` + local override ${effectiveUserConfig.localOverridePath}`
    : ""
  console.log(
    `[validate-model-config] validated ${references.models.length} configured models using ${managedPluginAssetPath}${localOverrideLabel}`,
  )
}

main()
