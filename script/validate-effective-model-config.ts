#!/usr/bin/env bun

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

import { OhMyOpenCodeConfigSchema } from "../src/config"
import { extractConfiguredModelReferences } from "../src/custom-opencode/model-config-validation"
import { loadEffectiveUserConfig } from "../src/custom-opencode/user-config-layers"
import { mergeConfigs } from "../src/plugin-config"
import { parseJsonc } from "../src/shared/jsonc-parser"
import { __resetModelCache, readCachedModelCatalog, resolveKnownCachedModel } from "../src/shared/model-availability"
import { getOpenCodeConfigDir } from "../src/shared/opencode-config-dir"

type HostConfig = {
  provider?: Record<string, { models?: Record<string, { limit?: { context?: number } }> }>
}

type ModelsCache = Record<string, { models?: Record<string, { status?: string; limit?: { context?: number } }> }>

function fail(message: string): never {
  throw new Error(message)
}

function refreshModelCatalog(): void {
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
      fail(`Failed to refresh model catalog via '${command.join(" ")}': ${stderr || stdout || "unknown error"}`)
    }
  }
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

function readModelsCache(): ModelsCache {
  const cacheFile = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "opencode", "models.json")
  if (!existsSync(cacheFile)) {
    fail(`OpenCode models cache not found after refresh: ${cacheFile}`)
  }

  return parseJsonc<ModelsCache>(readFileSync(cacheFile, "utf-8"))
}

function getCachedModelContextLimit(modelsCache: ModelsCache, fullModel: string): number | null {
  const slashIndex = fullModel.indexOf("/")
  if (slashIndex <= 0 || slashIndex === fullModel.length - 1) {
    return null
  }

  const providerID = fullModel.slice(0, slashIndex)
  const modelID = fullModel.slice(slashIndex + 1)
  const modelEntry = modelsCache[providerID]?.models?.[modelID]
  if (!modelEntry) {
    return null
  }

  const status = typeof modelEntry.status === "string" ? modelEntry.status.toLowerCase() : ""
  if (status.includes("deprecated") || status.includes("disabled") || status.includes("removed")) {
    return null
  }

  const context = modelEntry.limit?.context
  return typeof context === "number" ? context : null
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

  refreshModelCatalog()
  __resetModelCache()
  const availableModels = readCachedModelCatalog()
  const modelsCache = readModelsCache()
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

      const availableContext = getCachedModelContextLimit(modelsCache, resolved)
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
