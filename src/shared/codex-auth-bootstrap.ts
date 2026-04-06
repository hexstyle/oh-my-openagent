import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import os from "node:os"
import { dirname, join } from "node:path"

import { log } from "./logger"

type CodexCliTokenRecord = {
  access_token?: string
  refresh_token?: string
  id_token?: string
  account_id?: string
}

type CodexCliAuthRecord = CodexCliTokenRecord & {
  tokens?: CodexCliTokenRecord
}

type OpenCodeProviderAuth = {
  type?: string
  access?: string
  refresh?: string
  expires?: number
  id?: string
  account_id?: string
  email?: string
}

type OpenCodeLegacyCredential = {
  providerID?: string
  type?: string
  accessToken?: string
  refreshToken?: string
  idToken?: string
  expiresAt?: number
  accountID?: string
  email?: string
}

type OpenCodeAuthStore = Record<string, unknown> & {
  credentials?: OpenCodeLegacyCredential[]
  openai?: OpenCodeProviderAuth
}

function getHomeDir(): string {
  return process.env.HOME ?? os.homedir()
}

function getCodexAuthPath(): string {
  return join(getHomeDir(), ".codex", "auth.json")
}

function getOpenCodeAuthPath(): string {
  return join(getHomeDir(), ".local", "share", "opencode", "auth.json")
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> | undefined {
  if (!token) return undefined

  const parts = token.split(".")
  if (parts.length < 2) return undefined

  try {
    const normalized = parts[1]!.replace(/-/g, "+").replace(/_/g, "/")
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")
    return JSON.parse(Buffer.from(padded, "base64").toString("utf-8")) as Record<string, unknown>
  } catch {
    return undefined
  }
}

function readJsonFile<T>(filePath: string): T | undefined {
  if (!existsSync(filePath)) return undefined

  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T
  } catch (error) {
    log("[codex-auth-bootstrap] Failed to parse JSON file", {
      filePath,
      error: String(error),
    })
    return undefined
  }
}

function readCodexTokens(source: CodexCliAuthRecord | undefined): CodexCliTokenRecord | undefined {
  if (!source) return undefined
  return source.tokens ?? source
}

function isFresh(expiresAt: number | undefined): boolean {
  if (!expiresAt) return false
  return expiresAt > Date.now() + 60_000
}

function buildOpenAIOAuthEntry(source: CodexCliTokenRecord): OpenCodeProviderAuth | undefined {
  if (!source.access_token) return undefined

  const idPayload = decodeJwtPayload(source.id_token)
  const accessPayload = decodeJwtPayload(source.access_token)
  const expiresAtSeconds =
    typeof accessPayload?.exp === "number"
      ? accessPayload.exp
      : typeof idPayload?.exp === "number"
        ? idPayload.exp
        : undefined
  const email =
    typeof idPayload?.email === "string"
      ? idPayload.email
      : typeof accessPayload?.email === "string"
        ? accessPayload.email
        : undefined

  return {
    type: "oauth",
    access: source.access_token,
    ...(source.refresh_token ? { refresh: source.refresh_token } : {}),
    ...(expiresAtSeconds ? { expires: expiresAtSeconds * 1000 } : {}),
    ...(source.id_token ? { id: source.id_token } : {}),
    ...(source.account_id ? { account_id: source.account_id } : {}),
    ...(email ? { email } : {}),
  }
}

function readExistingOpenAICredential(store: OpenCodeAuthStore): OpenCodeProviderAuth | undefined {
  const direct = store.openai
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    return direct
  }

  const legacy = store.credentials?.find((entry) => entry.providerID === "openai")
  if (!legacy?.accessToken) {
    return undefined
  }

  return {
    type: legacy.type,
    access: legacy.accessToken,
    refresh: legacy.refreshToken,
    expires: legacy.expiresAt,
    id: legacy.idToken,
    account_id: legacy.accountID,
    email: legacy.email,
  }
}

export function syncCodexCliAuthToOpenCodeAuth(): void {
  const codexAuth = readJsonFile<CodexCliAuthRecord>(getCodexAuthPath())
  const codexTokens = readCodexTokens(codexAuth)
  if (!codexTokens) return

  const openaiCredential = buildOpenAIOAuthEntry(codexTokens)
  if (!openaiCredential) return

  const authPath = getOpenCodeAuthPath()
  const existingStore = readJsonFile<OpenCodeAuthStore>(authPath) ?? {}
  const existingOpenAI = readExistingOpenAICredential(existingStore)

  if (isFresh(existingOpenAI?.expires)) {
    return
  }

  const nextStore: OpenCodeAuthStore = {
    ...existingStore,
    openai: openaiCredential,
  }

  if (Array.isArray(existingStore.credentials)) {
    nextStore.credentials = existingStore.credentials.filter(
      (entry) => entry.providerID !== "openai",
    )
  }

  mkdirSync(dirname(authPath), { recursive: true })
  writeFileSync(authPath, JSON.stringify(nextStore, null, 2) + "\n", {
    encoding: "utf-8",
    mode: 0o600,
  })
  if (process.platform !== "win32") {
    chmodSync(authPath, 0o600)
  }

  log("[codex-auth-bootstrap] Synced Codex CLI OAuth into OpenCode auth store", {
    authPath,
  })
}
