import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

import {
  formatFindings,
  isScannableTextFile,
  scanContentForPublicSecrets,
  scanTrackedFilesForPublicSecrets,
} from "./check-no-public-secrets"

describe("check-no-public-secrets", () => {
  test("accepts placeholders and env-driven Antigravity credentials", () => {
    const content = `
export const ANTIGRAVITY_CLIENT_ID = process.env.ANTIGRAVITY_CLIENT_ID ?? "your-client-id"
export const ANTIGRAVITY_CLIENT_SECRET = process.env.ANTIGRAVITY_CLIENT_SECRET ?? "your-client-secret"
`

    expect(scanContentForPublicSecrets("src/auth/antigravity/constants.ts", content)).toEqual([])
  })

  test("flags hardcoded Antigravity credentials in source", () => {
    const content = `
export const ANTIGRAVITY_CLIENT_ID =
  "123456789012-prod.apps.googleusercontent.com"
export const ANTIGRAVITY_CLIENT_SECRET = "GOCSPX-liveSecret123456"
`

    expect(scanContentForPublicSecrets("src/auth/antigravity/constants.ts", content)).toEqual([
      {
        filePath: "src/auth/antigravity/constants.ts",
        line: 3,
        rule: "google-oauth-client-id",
      },
      {
        filePath: "src/auth/antigravity/constants.ts",
        line: 4,
        rule: "google-oauth-client-secret",
      },
      {
        filePath: "src/auth/antigravity/constants.ts",
        line: 2,
        rule: "hardcoded-antigravity-client-id",
      },
      {
        filePath: "src/auth/antigravity/constants.ts",
        line: 4,
        rule: "hardcoded-antigravity-client-secret",
      },
    ])
  })

  test("flags real OAuth credentials in markdown plans", () => {
    const content = `
**OAuth Configuration:**
- Client ID: \`123456789012-prod.apps.googleusercontent.com\`
- Client Secret: \`GOCSPX-liveSecret123456\`
`

    expect(scanContentForPublicSecrets("ai-todolist.md", content)).toEqual([
      {
        filePath: "ai-todolist.md",
        line: 3,
        rule: "google-oauth-client-id",
      },
      {
        filePath: "ai-todolist.md",
        line: 4,
        rule: "google-oauth-client-secret",
      },
    ])
  })

  test("skips generated build output", () => {
    expect(isScannableTextFile("dist/index.js")).toBe(false)
    expect(isScannableTextFile("src/index.ts")).toBe(true)
  })

  test("formats findings without leaking the secret value", () => {
    const output = formatFindings([
      {
        filePath: "ai-todolist.md",
        line: 4,
        rule: "google-oauth-client-secret",
      },
    ])

    expect(output).toContain("ai-todolist.md:4")
    expect(output).not.toContain("GOCSPX-")
  })

  test("current tracked repository tree is free of public secrets", () => {
    const repoRoot = resolve(import.meta.dir, "..")
    expect(scanTrackedFilesForPublicSecrets(repoRoot)).toEqual([])
  })
})
