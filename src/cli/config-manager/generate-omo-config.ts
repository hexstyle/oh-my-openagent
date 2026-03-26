import type { InstallConfig } from "../types"
import { generateModelConfig } from "../model-fallback"
import { generateAthenaConfig } from "./generate-athena-config"

export function generateOmoConfig(installConfig: InstallConfig): Record<string, unknown> {
  const generatedConfig = generateModelConfig(installConfig)
  const athenaConfig = generateAthenaConfig(installConfig)

  if (!athenaConfig) {
    return generatedConfig
  }

  return {
    ...generatedConfig,
    athena: athenaConfig,
  }
}
