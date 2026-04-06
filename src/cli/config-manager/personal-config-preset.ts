import { readFileSync } from "node:fs"
import type { OpenCodeConfig } from "./parse-opencode-config-file"

function loadJsonRecord<T extends Record<string, unknown>>(relativePath: string): T {
  const url = new URL(relativePath, import.meta.url)
  return JSON.parse(readFileSync(url, "utf-8")) as T
}

const PERSONAL_OPENCODE_CONFIG = loadJsonRecord<OpenCodeConfig>(
  "../../../assets/custom-opencode/opencode.json",
)
const PERSONAL_OMO_CONFIG = loadJsonRecord<Record<string, unknown>>(
  "../../../assets/custom-opencode/oh-my-opencode.json",
)

function cloneRecord<T extends Record<string, unknown>>(value: T): T {
  return structuredClone(value)
}

export function getPersonalOpenCodeConfig(pluginEntry = "oh-my-openagent"): OpenCodeConfig {
  const preset = cloneRecord(PERSONAL_OPENCODE_CONFIG)
  const existingPlugins = Array.isArray(preset.plugin) ? preset.plugin : []
  const normalizedPlugins = existingPlugins.map((plugin) =>
    plugin === "oh-my-openagent" || plugin.startsWith("oh-my-openagent@") ||
      plugin === "oh-my-opencode" || plugin.startsWith("oh-my-opencode@")
      ? pluginEntry
      : plugin
  )
  if (!normalizedPlugins.some((plugin) => plugin === pluginEntry)) {
    normalizedPlugins.unshift(pluginEntry)
  }
  preset.plugin = normalizedPlugins
  return preset
}

export function getPersonalOmoConfig(): Record<string, unknown> {
  return cloneRecord(PERSONAL_OMO_CONFIG)
}
