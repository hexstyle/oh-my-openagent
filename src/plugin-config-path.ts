import * as fs from "fs";
import { detectConfigFile, log } from "./shared";

interface ResolveConfigPathOptions {
  preferredBasePath: string;
  legacyBasePath: string;
}

function getDefaultConfigPath(basePath: string): string {
  return `${basePath}.json`;
}

function getTargetPath(preferredBasePath: string, format: "json" | "jsonc"): string {
  return `${preferredBasePath}.${format}`;
}

function migrateLegacyConfigPath(
  legacyPath: string,
  preferredBasePath: string,
  format: "json" | "jsonc"
): string {
  const targetPath = getTargetPath(preferredBasePath, format);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${legacyPath}.bak.${timestamp}`;

  try {
    fs.copyFileSync(legacyPath, backupPath);
  } catch (error) {
    log(`Failed to create backup before config path migration: ${legacyPath}`, error);
    return legacyPath;
  }

  try {
    fs.renameSync(legacyPath, targetPath);
    log(`Migrated legacy config path to new name: ${legacyPath} -> ${targetPath} (backup: ${backupPath})`);
    return targetPath;
  } catch (error) {
    log(`Failed to migrate legacy config path: ${legacyPath} -> ${targetPath}`, error);
    return legacyPath;
  }
}

export function resolveConfigPathWithLegacyMigration({
  preferredBasePath,
  legacyBasePath,
}: ResolveConfigPathOptions): string {
  const preferredDetected = detectConfigFile(preferredBasePath);
  const legacyDetected = detectConfigFile(legacyBasePath);

  if (preferredDetected.format !== "none") {
    if (legacyDetected.format !== "none") {
      log(
        `Detected legacy config also exists at ${legacyDetected.path}. Using new config path: ${preferredDetected.path}`
      );
    }
    return preferredDetected.path;
  }

  if (legacyDetected.format === "none") {
    return getDefaultConfigPath(preferredBasePath);
  }

  log(`Legacy config basename detected at ${legacyDetected.path}. Attempting auto-migration to new basename.`);
  return migrateLegacyConfigPath(legacyDetected.path, preferredBasePath, legacyDetected.format);
}
