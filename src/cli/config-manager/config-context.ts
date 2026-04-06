import { existsSync } from "node:fs"
import { join } from "node:path"

import { getOpenCodeConfigPaths } from "../../shared"
import type {
  OpenCodeBinaryType,
  OpenCodeConfigPaths,
} from "../../shared/opencode-config-dir-types"
import { CONFIG_BASENAME } from "../../shared/plugin-identity"

export interface ConfigContext {
  binary: OpenCodeBinaryType
  version: string | null
  paths: OpenCodeConfigPaths
}

let configContext: ConfigContext | null = null

export function initConfigContext(binary: OpenCodeBinaryType, version: string | null): void {
  const paths = getOpenCodeConfigPaths({ binary, version })
  configContext = { binary, version, paths }
}

export function getConfigContext(): ConfigContext {
  if (!configContext) {
    const paths = getOpenCodeConfigPaths({ binary: "opencode", version: null })
    configContext = { binary: "opencode", version: null, paths }
  }
  return configContext
}

export function resetConfigContext(): void {
  configContext = null
}

export function getConfigDir(): string {
  return getConfigContext().paths.configDir
}

export function getConfigJson(): string {
  return getConfigContext().paths.configJson
}

export function getConfigJsonc(): string {
  return getConfigContext().paths.configJsonc
}

export function getOmoConfigPath(): string {
  const configDir = getConfigContext().paths.configDir
  const canonicalJsoncPath = join(configDir, `${CONFIG_BASENAME}.jsonc`)
  if (existsSync(canonicalJsoncPath)) {
    return canonicalJsoncPath
  }
  return join(configDir, `${CONFIG_BASENAME}.json`)
}
