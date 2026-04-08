import { join } from "node:path"
import { loadEffectiveUserConfig } from "../../../custom-opencode/user-config-layers"
import { loadConfigFromPath, mergeConfigs } from "../../../plugin-config"
import { detectPluginConfigFile, getOpenCodeConfigPaths } from "../../../shared"
import type { OmoConfig } from "./model-resolution-types"

const USER_CONFIG_DIR = getOpenCodeConfigPaths({ binary: "opencode", version: null }).configDir
const PROJECT_CONFIG_DIR = join(process.cwd(), ".opencode")

export function loadOmoConfig(): OmoConfig | null {
  const effectiveUserConfig = loadEffectiveUserConfig(USER_CONFIG_DIR, {})
  let config = effectiveUserConfig.effectiveConfig as OmoConfig | null

  const projectDetected = detectPluginConfigFile(PROJECT_CONFIG_DIR)
  if (projectDetected.format !== "none") {
    const projectConfig = loadConfigFromPath(projectDetected.path, {})
    if (projectConfig) {
      config = config ? mergeConfigs(config as any, projectConfig as any) as OmoConfig : projectConfig as OmoConfig
    }
  }
  return config
}
