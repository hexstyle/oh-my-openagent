import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

export type PublicSecretFinding = {
  filePath: string
  line: number
  rule: string
}

type ScanRule = {
  id: string
  pattern: RegExp
}

const GOOGLE_OAUTH_CLIENT_ID_PATTERN = /\b\d{12}-[a-z0-9-]+\.apps\.googleusercontent\.com\b/g
const GOOGLE_OAUTH_CLIENT_SECRET_PATTERN = /\bGOCSPX-[A-Za-z0-9_-]{8,}\b/g

const SOURCE_RULES: ScanRule[] = [
  {
    id: "google-oauth-client-id",
    pattern: GOOGLE_OAUTH_CLIENT_ID_PATTERN,
  },
  {
    id: "google-oauth-client-secret",
    pattern: GOOGLE_OAUTH_CLIENT_SECRET_PATTERN,
  },
  {
    id: "hardcoded-antigravity-client-id",
    pattern: /ANTIGRAVITY_CLIENT_ID\s*=\s*(?:\r?\n\s*)?["'`]([^"'`\n]+)["'`]/g,
  },
  {
    id: "hardcoded-antigravity-client-secret",
    pattern: /ANTIGRAVITY_CLIENT_SECRET\s*=\s*(?:\r?\n\s*)?["'`]([^"'`\n]+)["'`]/g,
  },
]

const SCANNABLE_TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".go",
  ".js",
  ".json",
  ".jsonc",
  ".md",
  ".mjs",
  ".mts",
  ".sh",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
])

const SELF_REFERENTIAL_SCAN_EXCLUDES = new Set([
  "script/check-no-public-secrets.ts",
  "script/check-no-public-secrets.test.ts",
])

function getLineNumber(content: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset; index += 1) {
    if (content[index] === "\n") {
      line += 1
    }
  }
  return line
}

function isAllowedPlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  if (!normalized) {
    return true
  }

  return (
    normalized.includes("process.env")
    || normalized.includes("<redacted>")
    || normalized.includes("your-")
    || normalized.includes("your_")
    || normalized.includes("placeholder")
    || normalized.includes("example")
    || normalized.includes("dummy")
    || normalized.includes("fake")
    || normalized.includes("test")
  )
}

function shouldReport(rule: string, matchText: string): boolean {
  if (
    rule !== "hardcoded-antigravity-client-id"
    && rule !== "hardcoded-antigravity-client-secret"
  ) {
    return true
  }

  const literalMatch = matchText.match(/["'`]([^"'`\n]+)["'`]/)
  const literalValue = literalMatch?.[1] ?? ""
  return !isAllowedPlaceholder(literalValue)
}

export function scanContentForPublicSecrets(
  filePath: string,
  content: string,
): PublicSecretFinding[] {
  const findings: PublicSecretFinding[] = []

  for (const rule of SOURCE_RULES) {
    rule.pattern.lastIndex = 0
    for (const match of content.matchAll(rule.pattern)) {
      const matchText = match[0] ?? ""
      if (!shouldReport(rule.id, matchText)) {
        continue
      }

      findings.push({
        filePath,
        line: getLineNumber(content, match.index ?? 0),
        rule: rule.id,
      })
    }
  }

  return findings
}

export function isScannableTextFile(filePath: string): boolean {
  if (SELF_REFERENTIAL_SCAN_EXCLUDES.has(filePath)) {
    return false
  }

  if (filePath.startsWith("dist/") || filePath.includes("/dist/")) {
    return false
  }

  const basename = filePath.split("/").pop() ?? filePath
  if (basename === "Dockerfile") {
    return true
  }

  const extension = basename.includes(".")
    ? `.${basename.split(".").pop() ?? ""}`
    : ""

  return SCANNABLE_TEXT_EXTENSIONS.has(extension)
}

export function listTrackedFiles(cwd: string): string[] {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd,
    encoding: "utf8",
  })

  return output
    .split("\0")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

export function scanTrackedFilesForPublicSecrets(cwd: string): PublicSecretFinding[] {
  const findings: PublicSecretFinding[] = []

  for (const filePath of listTrackedFiles(cwd)) {
    if (!isScannableTextFile(filePath)) {
      continue
    }

    const absolutePath = resolve(cwd, filePath)
    const content = readFileSync(absolutePath, "utf8")
    findings.push(...scanContentForPublicSecrets(filePath, content))
  }

  return findings
}

export function formatFindings(findings: PublicSecretFinding[]): string {
  const lines = findings.map((finding) =>
    `- ${finding.filePath}:${finding.line} (${finding.rule})`
  )
  return [
    "Public secret scan failed. Remove hardcoded credentials before committing.",
    ...lines,
  ].join("\n")
}

if (import.meta.main) {
  const cwd = resolve(import.meta.dir, "..")
  const findings = scanTrackedFilesForPublicSecrets(cwd)
  if (findings.length > 0) {
    console.error(formatFindings(findings))
    process.exit(1)
  }

  console.log("Public secret scan passed.")
}
