import {
  CONFIG_BASENAME,
  LEGACY_CONFIG_BASENAME,
} from "../../../shared/plugin-identity"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { detectConfigFile, getOpenCodeConfigPaths, parseJsonc } from "../../../shared"
import type { OmoConfig } from "./model-resolution-types"

const USER_CONFIG_BASES = [
  join(getOpenCodeConfigPaths({ binary: "opencode", version: null }).configDir, CONFIG_BASENAME),
  join(getOpenCodeConfigPaths({ binary: "opencode", version: null }).configDir, LEGACY_CONFIG_BASENAME),
] as const

const PROJECT_CONFIG_BASES = [
  join(process.cwd(), ".opencode", CONFIG_BASENAME),
  join(process.cwd(), ".opencode", LEGACY_CONFIG_BASENAME),
] as const

export function loadOmoConfig(): OmoConfig | null {
  for (const projectConfigBase of PROJECT_CONFIG_BASES) {
    const projectDetected = detectConfigFile(projectConfigBase)
    if (projectDetected.format !== "none") {
      try {
        const content = readFileSync(projectDetected.path, "utf-8")
        return parseJsonc<OmoConfig>(content)
      } catch {
        return null
      }
    }
  }

  for (const userConfigBase of USER_CONFIG_BASES) {
    const userDetected = detectConfigFile(userConfigBase)
    if (userDetected.format !== "none") {
      try {
        const content = readFileSync(userDetected.path, "utf-8")
        return parseJsonc<OmoConfig>(content)
      } catch {
        return null
      }
    }
  }

  return null
}
