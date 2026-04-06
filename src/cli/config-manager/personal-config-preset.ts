import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { OpenCodeConfig } from "./parse-opencode-config-file"

function resolveCustomPresetPath(fileName: string): string {
  let currentDir = dirname(fileURLToPath(import.meta.url))

  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(currentDir, "assets", "custom-opencode", fileName)
    if (existsSync(candidate)) {
      return candidate
    }
    currentDir = dirname(currentDir)
  }

  throw new Error(`Unable to locate custom-opencode preset: ${fileName}`)
}

function loadJsonRecord<T extends Record<string, unknown>>(fileName: string): T {
  const path = resolveCustomPresetPath(fileName)
  return JSON.parse(readFileSync(path, "utf-8")) as T
}

const PERSONAL_OPENCODE_CONFIG = loadJsonRecord<OpenCodeConfig>(
  "opencode.json",
)
const PERSONAL_OMO_CONFIG = loadJsonRecord<Record<string, unknown>>(
  "oh-my-opencode.json",
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
