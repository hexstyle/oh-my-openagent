import { existsSync } from "node:fs"
import { join } from "node:path"

import type { OhMyOpenCodeConfig } from "../config"
import { loadConfigFromPath, mergeConfigs } from "../plugin-config"
import { detectLocalOverrideConfigFile } from "../shared/jsonc-parser"
import {
  CONFIG_BASENAME,
  LOCAL_OVERRIDE_CONFIG_BASENAME,
} from "../shared/plugin-identity"

export interface EffectiveUserConfig {
  managedPath: string
  localOverridePath: string | null
  ignoredCanonicalJsoncPath: string | null
  managedConfig: OhMyOpenCodeConfig | null
  localOverrideConfig: OhMyOpenCodeConfig | null
  effectiveConfig: OhMyOpenCodeConfig | null
}

export function getManagedUserConfigPath(configDir: string): string {
  return join(configDir, `${CONFIG_BASENAME}.json`)
}

export function getIgnoredCanonicalJsoncPath(configDir: string): string {
  return join(configDir, `${CONFIG_BASENAME}.jsonc`)
}

export function getDefaultLocalOverridePath(configDir: string): string {
  return join(configDir, `${LOCAL_OVERRIDE_CONFIG_BASENAME}.jsonc`)
}

export function loadEffectiveUserConfig(configDir: string, ctx: unknown): EffectiveUserConfig {
  const managedPath = getManagedUserConfigPath(configDir)
  const localOverrideDetected = detectLocalOverrideConfigFile(configDir)
  const localOverridePath = localOverrideDetected.format !== "none" ? localOverrideDetected.path : null
  const ignoredCanonicalJsoncPath = existsSync(getIgnoredCanonicalJsoncPath(configDir))
    ? getIgnoredCanonicalJsoncPath(configDir)
    : null

  const managedConfig = loadConfigFromPath(managedPath, ctx)
  const localOverrideConfig = localOverridePath
    ? loadConfigFromPath(localOverridePath, ctx)
    : null

  const effectiveConfig = managedConfig
    ? (localOverrideConfig ? mergeConfigs(managedConfig, localOverrideConfig) : managedConfig)
    : null

  return {
    managedPath,
    localOverridePath,
    ignoredCanonicalJsoncPath,
    managedConfig,
    localOverrideConfig,
    effectiveConfig,
  }
}
