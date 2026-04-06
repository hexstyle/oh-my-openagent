import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { syncCodexCliAuthToOpenCodeAuth } from "./codex-auth-bootstrap"

function encodeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.`
}

describe("syncCodexCliAuthToOpenCodeAuth", () => {
  const originalHome = process.env.HOME
  let homeDir = ""

  afterEach(() => {
    if (homeDir) {
      rmSync(homeDir, { recursive: true, force: true })
      homeDir = ""
    }

    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
  })

  it("imports Codex CLI auth into the OpenCode auth store using the live top-level provider format", () => {
    homeDir = join(tmpdir(), `codex-auth-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    process.env.HOME = homeDir

    mkdirSync(join(homeDir, ".codex"), { recursive: true })
    const now = Math.floor(Date.now() / 1000) + 3600
    writeFileSync(
      join(homeDir, ".codex", "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: encodeJwt({ exp: now, email: "user@example.com" }),
          refresh_token: "refresh-token",
          id_token: encodeJwt({ exp: now, email: "user@example.com" }),
          account_id: "acct_123",
        },
      }),
    )

    syncCodexCliAuthToOpenCodeAuth()

    const saved = JSON.parse(
      readFileSync(join(homeDir, ".local", "share", "opencode", "auth.json"), "utf-8"),
    ) as { openai?: Record<string, unknown> }

    expect(saved.openai?.type).toBe("oauth")
    expect(saved.openai?.access).toBeString()
    expect(saved.openai?.refresh).toBe("refresh-token")
    expect(saved.openai?.account_id).toBe("acct_123")
    expect(saved.openai?.email).toBe("user@example.com")
  })

  it("preserves a fresh top-level OpenCode openai oauth credential", () => {
    homeDir = join(tmpdir(), `codex-auth-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    process.env.HOME = homeDir

    mkdirSync(join(homeDir, ".codex"), { recursive: true })
    mkdirSync(join(homeDir, ".local", "share", "opencode"), { recursive: true })

    const futureMs = Date.now() + 3600_000
    writeFileSync(
      join(homeDir, ".codex", "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: encodeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
          refresh_token: "refresh-token",
        },
      }),
    )
    writeFileSync(
      join(homeDir, ".local", "share", "opencode", "auth.json"),
      JSON.stringify({
        openai: {
          type: "oauth",
          access: "existing-access",
          expires: futureMs,
        },
      }),
    )

    syncCodexCliAuthToOpenCodeAuth()

    const saved = JSON.parse(
      readFileSync(join(homeDir, ".local", "share", "opencode", "auth.json"), "utf-8"),
    ) as { openai?: Record<string, unknown> }

    expect(saved.openai?.access).toBe("existing-access")
  })

  it("refreshes a legacy credentials-array OpenCode openai oauth credential from Codex auth", () => {
    homeDir = join(tmpdir(), `codex-auth-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    process.env.HOME = homeDir

    mkdirSync(join(homeDir, ".codex"), { recursive: true })
    mkdirSync(join(homeDir, ".local", "share", "opencode"), { recursive: true })

    writeFileSync(
      join(homeDir, ".codex", "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: encodeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
          refresh_token: "new-refresh-token",
        },
      }),
    )
    writeFileSync(
      join(homeDir, ".local", "share", "opencode", "auth.json"),
      JSON.stringify({
        credentials: [
          {
            providerID: "openai",
            type: "oauth",
            accessToken: "expired-access",
            expiresAt: Date.now() - 1000,
          },
        ],
      }),
    )

    syncCodexCliAuthToOpenCodeAuth()

    const saved = JSON.parse(
      readFileSync(join(homeDir, ".local", "share", "opencode", "auth.json"), "utf-8"),
    ) as { openai?: Record<string, unknown>; credentials?: Array<Record<string, unknown>> }

    expect(saved.openai?.access).not.toBe("expired-access")
    expect(saved.openai?.refresh).toBe("new-refresh-token")
    expect(saved.credentials).toEqual([])
  })

  it("does nothing when Codex auth is missing", () => {
    homeDir = join(tmpdir(), `codex-auth-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    process.env.HOME = homeDir

    syncCodexCliAuthToOpenCodeAuth()

    expect(() => readFileSync(join(homeDir, ".local", "share", "opencode", "auth.json"), "utf-8")).toThrow()
  })
})
