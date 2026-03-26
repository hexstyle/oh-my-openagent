import { type OhMyOpenCodeConfig, OhMyOpenCodeConfigSchema } from "./config"

const PARTIAL_STRING_ARRAY_KEYS = new Set([
  "disabled_mcps",
  "disabled_agents",
  "disabled_skills",
  "disabled_hooks",
  "disabled_commands",
  "disabled_tools",
])

export interface PartialConfigParseResult {
  config: OhMyOpenCodeConfig
  invalidSections: string[]
}

function formatIssue(path: PropertyKey[], message: string): string {
  const pathText = path.length > 0 ? path.join(".") : "root"
  return `${pathText}: ${message}`
}

export function parseConfigPartiallyWithIssues(
  rawConfig: Record<string, unknown>
): PartialConfigParseResult {
  const fullResult = OhMyOpenCodeConfigSchema.safeParse(rawConfig)
  if (fullResult.success) {
    return {
      config: fullResult.data,
      invalidSections: [],
    }
  }

  const partialConfig: Record<string, unknown> = {}
  const invalidSections: string[] = []

  for (const key of Object.keys(rawConfig)) {
    if (PARTIAL_STRING_ARRAY_KEYS.has(key)) {
      const sectionValue = rawConfig[key]
      if (Array.isArray(sectionValue) && sectionValue.every((value) => typeof value === "string")) {
        partialConfig[key] = sectionValue
      } else {
        invalidSections.push(formatIssue([key], "Expected an array of strings"))
      }
      continue
    }

    const sectionResult = OhMyOpenCodeConfigSchema.safeParse({ [key]: rawConfig[key] })
    if (sectionResult.success) {
      const parsed = sectionResult.data as Record<string, unknown>
      if (parsed[key] !== undefined) {
        partialConfig[key] = parsed[key]
      }
      continue
    }

    const sectionIssues = sectionResult.error.issues.filter((issue) => issue.path[0] === key)
    const issuesToReport = sectionIssues.length > 0 ? sectionIssues : sectionResult.error.issues
    const sectionErrors = issuesToReport
      .map((issue) => formatIssue(issue.path, issue.message))
      .join(", ")

    if (sectionErrors.length > 0) {
      invalidSections.push(`${key}: ${sectionErrors}`)
    }
  }

  return {
    config: partialConfig as OhMyOpenCodeConfig,
    invalidSections,
  }
}
