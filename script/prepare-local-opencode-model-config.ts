#!/usr/bin/env bun

import { copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

import { detectLocalOverrideConfigFile } from "../src/shared/jsonc-parser"
import { getOpenCodeConfigDir } from "../src/shared/opencode-config-dir"
import {
  CONFIG_BASENAME,
  LEGACY_CONFIG_BASENAME,
  LOCAL_OVERRIDE_CONFIG_BASENAME,
} from "../src/shared/plugin-identity"

const repoRoot = resolve(import.meta.dir, "..")
const configDir = getOpenCodeConfigDir({ binary: "opencode" })
const defaultLocalOverridePath = join(configDir, `${LOCAL_OVERRIDE_CONFIG_BASENAME}.jsonc`)
const templatePath = join(
  repoRoot,
  "assets",
  "custom-opencode",
  "oh-my-openagent.local.template.jsonc",
)

function backupPath(filePath: string): string {
  const timestamp = new Date().toISOString().replace(/[.:]/g, "-")
  return `${filePath}.ignored-${timestamp}.bak`
}

function moveToBackup(filePath: string): string {
  const targetPath = backupPath(filePath)
  renameSync(filePath, targetPath)
  return targetPath
}

function main(): void {
  mkdirSync(configDir, { recursive: true })

  const localDetected = detectLocalOverrideConfigFile(configDir)
  const canonicalJsoncPath = join(configDir, `${CONFIG_BASENAME}.jsonc`)
  const legacyCandidates = [
    join(configDir, `${LEGACY_CONFIG_BASENAME}.jsonc`),
    join(configDir, `${LEGACY_CONFIG_BASENAME}.json`),
  ]

  const staleCandidates = [canonicalJsoncPath, ...legacyCandidates].filter((pathValue) => existsSync(pathValue))

  if (localDetected.format !== "none") {
    for (const stalePath of staleCandidates) {
      const backup = moveToBackup(stalePath)
      console.log(`[prepare-local-config] moved ignored duplicate to ${backup}`)
    }
    console.log(`[prepare-local-config] using existing local override ${localDetected.path}`)
    return
  }

  const migrateCandidate = staleCandidates[0]
  if (migrateCandidate) {
    renameSync(migrateCandidate, defaultLocalOverridePath)
    console.log(`[prepare-local-config] migrated ${migrateCandidate} -> ${defaultLocalOverridePath}`)

    for (const stalePath of staleCandidates.slice(1)) {
      const backup = moveToBackup(stalePath)
      console.log(`[prepare-local-config] moved ignored duplicate to ${backup}`)
    }
    return
  }

  mkdirSync(dirname(defaultLocalOverridePath), { recursive: true })
  copyFileSync(templatePath, defaultLocalOverridePath)
  console.log(`[prepare-local-config] created local override template ${defaultLocalOverridePath}`)
}

main()
