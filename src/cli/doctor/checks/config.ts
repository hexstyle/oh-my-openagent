import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { loadEffectiveUserConfig } from "../../../custom-opencode/user-config-layers"
import { OhMyOpenCodeConfigSchema } from "../../../config"
import { detectPluginConfigFile, getOpenCodeConfigDir, parseJsonc } from "../../../shared"
import { CHECK_IDS, CHECK_NAMES } from "../constants"
import type { CheckResult, DoctorIssue } from "../types"
import { loadAvailableModelsFromCache } from "./model-resolution-cache"
import { getModelResolutionInfoWithOverrides } from "./model-resolution"
import { loadOmoConfig } from "./model-resolution-config"
import type { OmoConfig } from "./model-resolution-types"

const USER_CONFIG_DIR = getOpenCodeConfigDir({ binary: "opencode" })
const PROJECT_CONFIG_DIR = join(process.cwd(), ".opencode")

interface ConfigValidationResult {
  exists: boolean
  paths: string[]
  valid: boolean
  config: OmoConfig | null
  errors: string[]
}

function validateConfig(): ConfigValidationResult {
  const projectConfig = detectPluginConfigFile(PROJECT_CONFIG_DIR)
  const effectiveUserConfig = loadEffectiveUserConfig(USER_CONFIG_DIR, {})
  const ignoredCanonicalJsoncPath = join(USER_CONFIG_DIR, "oh-my-openagent.jsonc")
  const paths = [
    existsSync(effectiveUserConfig.managedPath) ? effectiveUserConfig.managedPath : null,
    effectiveUserConfig.localOverridePath,
    projectConfig.format !== "none" ? projectConfig.path : null,
  ].filter((value): value is string => Boolean(value))

  if (paths.length === 0) {
    return { exists: false, paths: [], valid: true, config: null, errors: [] }
  }

  const errors: string[] = []
  for (const pathValue of paths) {
    try {
      const content = readFileSync(pathValue, "utf-8")
      const rawConfig = parseJsonc<OmoConfig>(content)
      const schemaResult = OhMyOpenCodeConfigSchema.safeParse(rawConfig)

      if (!schemaResult.success) {
        errors.push(
          `${pathValue}: ${schemaResult.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join(", ")}`,
        )
      }
    } catch (error) {
      errors.push(`${pathValue}: ${error instanceof Error ? error.message : "Failed to parse config"}`)
    }
  }

  if (existsSync(ignoredCanonicalJsoncPath)) {
    errors.push(
      `${ignoredCanonicalJsoncPath}: unsupported canonical JSONC config; use oh-my-openagent.local.jsonc instead`,
    )
  }

  return {
    exists: true,
    paths,
    valid: errors.length === 0,
    config: errors.length === 0 ? loadOmoConfig() : null,
    errors,
  }
}

function collectModelResolutionIssues(config: OmoConfig): DoctorIssue[] {
  const issues: DoctorIssue[] = []
  const availableModels = loadAvailableModelsFromCache()
  const resolution = getModelResolutionInfoWithOverrides(config)

  const invalidAgentOverrides = resolution.agents.filter(
    (agent) => agent.userOverride && !agent.userOverride.includes("/")
  )
  const invalidCategoryOverrides = resolution.categories.filter(
    (category) => category.userOverride && !category.userOverride.includes("/")
  )

  for (const invalidAgent of invalidAgentOverrides) {
    issues.push({
      title: `Invalid agent override: ${invalidAgent.name}`,
      description: `Override '${invalidAgent.userOverride}' must be in provider/model format.`,
      severity: "warning",
      affects: [invalidAgent.name],
    })
  }

  for (const invalidCategory of invalidCategoryOverrides) {
    issues.push({
      title: `Invalid category override: ${invalidCategory.name}`,
      description: `Override '${invalidCategory.userOverride}' must be in provider/model format.`,
      severity: "warning",
      affects: [invalidCategory.name],
    })
  }

  if (availableModels.cacheExists) {
    const providerSet = new Set(availableModels.providers)
    const unknownProviders = [
      ...resolution.agents.map((agent) => agent.userOverride),
      ...resolution.categories.map((category) => category.userOverride),
    ]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.split("/")[0])
      .filter((provider) => provider.length > 0 && !providerSet.has(provider))

    if (unknownProviders.length > 0) {
      const uniqueProviders = [...new Set(unknownProviders)]
      issues.push({
        title: "Model override uses unavailable provider",
        description: `Provider(s) not found in OpenCode model cache: ${uniqueProviders.join(", ")}`,
        severity: "warning",
        affects: ["model resolution"],
      })
    }
  }

  return issues
}

export async function checkConfig(): Promise<CheckResult> {
  const validation = validateConfig()
  const issues: DoctorIssue[] = []

  if (!validation.exists) {
    return {
      name: CHECK_NAMES[CHECK_IDS.CONFIG],
      status: "pass",
      message: "No custom config found; defaults are used",
      details: undefined,
      issues,
    }
  }

  if (!validation.valid) {
    issues.push(
      ...validation.errors.map((error) => ({
        title: "Invalid configuration",
        description: error,
        severity: "error" as const,
        affects: ["plugin startup"],
      }))
    )

    return {
      name: CHECK_NAMES[CHECK_IDS.CONFIG],
      status: "fail",
      message: `Configuration invalid (${issues.length} issue${issues.length > 1 ? "s" : ""})`,
      details: validation.paths.map((pathValue) => `Path: ${pathValue}`),
      issues,
    }
  }

  if (validation.config) {
    issues.push(...collectModelResolutionIssues(validation.config))
  }

  return {
    name: CHECK_NAMES[CHECK_IDS.CONFIG],
    status: issues.length > 0 ? "warn" : "pass",
    message: issues.length > 0 ? `${issues.length} configuration warning(s)` : "Configuration is valid",
    details: validation.paths.map((pathValue) => `Path: ${pathValue}`),
    issues,
  }
}
