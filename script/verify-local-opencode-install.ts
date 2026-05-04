#!/usr/bin/env bun

import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import os from "node:os"
import { join, resolve } from "node:path"
import { createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk"

import { loadEffectiveUserConfig } from "../src/custom-opencode/user-config-layers"
import { getAgentDisplayName } from "../src/shared/agent-display-names"
import {
  getManagedConfigSchemaDependencySpec,
  getManagedLivePluginEntries,
  MANAGED_RUNTIME_PLUGIN_DEPENDENCIES,
} from "../src/shared/managed-opencode-runtime"

const repoRoot = resolve(import.meta.dir, "..")
const homeDir = process.env.HOME ?? os.homedir()
const configDir = process.env.OPENCODE_CONFIG_DIR
  ? resolve(process.env.OPENCODE_CONFIG_DIR)
  : join(homeDir, ".config", "opencode")
const cacheDir = join(homeDir, ".cache", "opencode")
const authPath = join(homeDir, ".local", "share", "opencode", "auth.json")
const codexAuthPath = join(homeDir, ".codex", "auth.json")

const hostAsset = JSON.parse(
  readFileSync(join(repoRoot, "assets", "custom-opencode", "opencode.json"), "utf-8"),
) as Record<string, unknown>
const pluginAsset = JSON.parse(
  readFileSync(join(repoRoot, "assets", "custom-opencode", "oh-my-opencode.json"), "utf-8"),
) as Record<string, unknown>
const expectedLiveHost = {
  ...hostAsset,
  plugin: getManagedLivePluginEntries(repoRoot),
}

type RuntimeAgentExpectation = {
  configKey?: string
  displayName: string
  runtimeName: string
  listedName: string
  model: string
  mode: "subagent" | "core"
}

type RuntimeAgentRecord = Record<string, unknown> & {
  mode?: string
  model?: string | { providerID?: string; modelID?: string }
  name?: string
  variant?: string
}

type ListedAgent = {
  name?: string
  mode?: string
  model?: string | { providerID?: string; modelID?: string }
}

type SmokeResult = {
  output: string
  exitCode: number
}

type SmokeConfig = {
  agentName: string
  model: { providerID: string; modelID: string }
}

type SmokeMessage = {
  role?: string
  info?: {
    role?: string
    error?: unknown
  }
  error?: unknown
  parts?: Array<{ type?: string; text?: string }>
}

type SmokeMessageOutcome = {
  output: string
  state: "success" | "skippable" | "failed" | "pending"
}

type SmokeChildSession = {
  id?: string
}

const SMOKE_PROMPT = "Stateless smoke test. Do not resume prior work, do not inspect the repository, do not ask questions. Reply with exactly OK."
const DEFAULT_SMOKE_TIMEOUT_OVERRIDE_MS = 90 * 1000
const ANTHROPIC_SMOKE_TIMEOUT_OVERRIDE_MS = 2 * 60 * 1000
const SMOKE_HEARTBEAT_INTERVAL_MS = 15 * 1000

function readPositiveIntEnv(name: string): number | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function buildExpectedAgents(pluginConfig: Record<string, unknown>): RuntimeAgentExpectation[] {
  const agents = (pluginConfig.agents ?? {}) as Record<string, { model?: unknown }>
  const expected: Array<{ key: string; configKey?: string; mode: "subagent" | "core" }> = [
    { key: "sisyphus", mode: "core" },
    { key: "hephaestus", mode: "core" },
    { key: "prometheus", mode: "core" },
    { key: "atlas", mode: "core" },
    { key: "sisyphus-junior", mode: "subagent" },
    { key: "oracle", mode: "subagent" },
    { key: "librarian", mode: "subagent" },
    { key: "explore", configKey: "explore", mode: "subagent" },
    { key: "multimodal-looker", mode: "subagent" },
    { key: "metis", mode: "subagent" },
    { key: "momus", mode: "subagent" },
  ]

  return expected.map((entry) => {
    const model = agents[entry.key]?.model
    if (typeof model !== "string" || model.length === 0) {
      fail(`Effective plugin config is missing model for agent ${entry.key}`)
    }

    return {
      configKey: entry.configKey,
      displayName: getAgentDisplayName(entry.key),
      runtimeName: entry.configKey ?? getAgentDisplayName(entry.key),
      listedName: entry.configKey ?? getAgentDisplayName(entry.key),
      model,
      mode: entry.mode,
    }
  })
}

const forbiddenRuntimeAgentKeys = [
  "sisyphus",
  "hephaestus",
  "prometheus",
  "atlas",
  "Sisyphus",
  "Hephaestus",
  "Prometheus",
  "Atlas",
  "oracle",
  "librarian",
  "multimodal-looker",
  "momus",
  "metis",
  "Sisyphus Junior",
  "Sisyphus-Junior",
  "sisyphus-junior",
]

function fail(message: string): never {
  throw new Error(message)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) fail(message)
}

function assertManagedRuntimePackageLayout(): void {
  for (const [packageName, expectedVersion] of Object.entries(MANAGED_RUNTIME_PLUGIN_DEPENDENCIES)) {
    const packageRoot = join(cacheDir, "packages", `${packageName}@latest`)
    const packageJsonPath = join(packageRoot, "node_modules", "package.json")
    assert(existsSync(packageRoot), `Managed runtime package directory is missing: ${packageRoot}`)
    assert(
      existsSync(packageJsonPath),
      `Managed runtime package layout is incomplete for ${packageName}: missing ${packageJsonPath}`,
    )
    const packageManifest = readJson(packageJsonPath)
    assert(
      packageManifest.name === packageName,
      `Managed runtime package manifest mismatch for ${packageName}: expected name ${packageName}, got ${String(packageManifest.name)}`,
    )
    assert(
      packageManifest.version === expectedVersion,
      `Managed runtime package ${packageName} drifted: expected ${expectedVersion}, got ${String(packageManifest.version)}`,
    )
  }
}

function readJson(filePath: string): Record<string, unknown> {
  assert(existsSync(filePath), `Missing file: ${filePath}`)
  return JSON.parse(readFileSync(filePath, "utf-8")) as Record<string, unknown>
}

function deepEqualJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function normalizeSdkResponse<TData>(response: unknown, fallback: TData): TData {
  if (Array.isArray(response)) {
    return response as TData
  }
  if (response && typeof response === "object" && "data" in response) {
    const data = (response as { data?: unknown }).data
    if (data !== undefined && data !== null) {
      return data as TData
    }
  }
  return (response as TData | undefined) ?? fallback
}

function normalizeModel(model: RuntimeAgentRecord["model"]): string | undefined {
  if (typeof model === "string") {
    return model
  }
  if (model && typeof model === "object") {
    const providerID = typeof model.providerID === "string" ? model.providerID : undefined
    const modelID = typeof model.modelID === "string" ? model.modelID : undefined
    if (providerID && modelID) {
      return `${providerID}/${modelID}`
    }
  }
  return undefined
}

function assertRuntimeAgent(
  agentMap: Record<string, RuntimeAgentRecord>,
  expected: RuntimeAgentExpectation,
): void {
  const runtimeKey = expected.configKey ?? expected.displayName
  const agent = agentMap[runtimeKey]
  assert(agent, `Runtime is missing agent section for ${expected.displayName}`)

  if (expected.configKey) {
    assert(
      agent.name === expected.runtimeName,
      `Runtime agent ${runtimeKey} does not expose canonical runtime name ${expected.runtimeName}`,
    )
  }

  const actualModel = normalizeModel(agent.model)
  assert(
    actualModel === expected.model,
    `Runtime agent ${expected.displayName} is not pinned to ${expected.model}`,
  )

  if (expected.mode === "subagent") {
    assert(
      agent.mode === "subagent",
      `Runtime agent ${expected.displayName} has the wrong mode`,
    )
  } else {
    assert(
      agent.mode === "primary" || agent.mode === "all",
      `Runtime agent ${expected.displayName} has the wrong mode`,
    )
  }
}

function assertNoForbiddenRuntimeKeys(agentMap: Record<string, RuntimeAgentRecord>): void {
  for (const forbiddenKey of forbiddenRuntimeAgentKeys) {
    assert(!(forbiddenKey in agentMap), `Runtime still exposes forbidden agent key: ${forbiddenKey}`)
  }
}

export function isSkippableProviderQuotaSmokeFailure(output: string): boolean {
  const normalized = output.toLowerCase()
  return [
    "out of extra usage",
    "usage limit",
    "insufficient balance",
    "add more at claude.ai/settings/usage",
    "billing hard limit",
  ].some((pattern) => normalized.includes(pattern))
}

export function assertSmokeSucceededOrSkippable(args: {
  providerLabel: string
  result: SmokeResult
}): void {
  if (/\bOK\b/.test(args.result.output)) {
    return
  }

  if (isSkippableProviderQuotaSmokeFailure(args.result.output)) {
    console.log(`[verify] skipping ${args.providerLabel} smoke: provider quota exhausted`)
    return
  }

  const normalizedOutput = args.result.output.trim()
  const excerpt = normalizedOutput.length > 0
    ? normalizedOutput.slice(0, 400)
    : "no output captured"
  fail(`${args.providerLabel} smoke test did not return OK: ${excerpt}`)
}

function stringifySmokeError(error: unknown): string {
  if (!error) return ""
  if (typeof error === "string") return error
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error && "message" in error && typeof error.message === "string") {
    return error.message
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function getSmokeMessageRole(message: SmokeMessage): string | undefined {
  if (typeof message.role === "string") {
    return message.role
  }
  return typeof message.info?.role === "string" ? message.info.role : undefined
}

function getSmokeMessageError(message: SmokeMessage): unknown {
  return message.error ?? message.info?.error
}

function getSmokeMessageText(message: SmokeMessage): string {
  return (message.parts ?? [])
    .filter((part) => typeof part?.text === "string")
    .map((part) => (part.text ?? "").trim())
    .filter((text) => text.length > 0)
    .join("\n")
}

export function interpretSmokeMessages(messages: SmokeMessage[] | unknown): SmokeMessageOutcome {
  const normalizedMessages = Array.isArray(messages)
    ? messages
    : messages && typeof messages === "object" && "messages" in messages && Array.isArray(messages.messages)
      ? messages.messages as SmokeMessage[]
      : messages && typeof messages === "object" && "data" in messages && Array.isArray(messages.data)
        ? messages.data as SmokeMessage[]
        : []

  const latestMessage = [...normalizedMessages]
    .reverse()
    .find((message) => getSmokeMessageRole(message) === "assistant" || getSmokeMessageRole(message) === "user")

  if (!latestMessage) {
    return { output: "", state: "pending" }
  }

  if (getSmokeMessageRole(latestMessage) === "user") {
    return { output: "", state: "pending" }
  }

  const text = getSmokeMessageText(latestMessage)
  const errorText = stringifySmokeError(getSmokeMessageError(latestMessage))
  const output = [text, errorText].filter((value) => value.length > 0).join("\n").trim()

  if (/\bOK\b/.test(text)) {
    return { output: text, state: "success" }
  }

  if (isSkippableProviderQuotaSmokeFailure(output)) {
    return { output, state: "skippable" }
  }

  if (errorText.length > 0) {
    return { output, state: "failed" }
  }

  return { output, state: "pending" }
}

export async function interpretSmokeDescendantMessages(args: {
  client: ReturnType<typeof createOpencodeClient>
  smokeDirectory: string
  sessionID: string
  visited?: Set<string>
}): Promise<SmokeMessageOutcome> {
  const { client, smokeDirectory, sessionID } = args
  const visited = args.visited ?? new Set<string>()
  if (visited.has(sessionID)) {
    return { output: "", state: "pending" }
  }
  visited.add(sessionID)

  if (typeof client.session.children !== "function") {
    return { output: "", state: "pending" }
  }

  const childrenResponse = await client.session.children({
    path: { id: sessionID },
    query: { directory: smokeDirectory },
  })
  const children = normalizeSdkResponse(childrenResponse, [] as SmokeChildSession[])
  if (children.length === 0) {
    return { output: "", state: "pending" }
  }

  for (let index = children.length - 1; index >= 0; index -= 1) {
    const childSessionID = typeof children[index]?.id === "string" ? children[index]?.id : undefined
    if (!childSessionID) {
      continue
    }

    const childMessagesResponse = await client.session.messages({
      path: { id: childSessionID },
      query: { directory: smokeDirectory },
    })
    const childMessages = normalizeSdkResponse(childMessagesResponse, [] as SmokeMessage[])
    const childOutcome = interpretSmokeMessages(childMessages)
    if (childOutcome.state !== "pending") {
      return childOutcome
    }

    const descendantOutcome = await interpretSmokeDescendantMessages({
      client,
      smokeDirectory,
      sessionID: childSessionID,
      visited,
    })
    if (descendantOutcome.state !== "pending") {
      return descendantOutcome
    }
  }

  return { output: "", state: "pending" }
}

export function createSmokeWorkspace(baseDir = os.tmpdir()): string {
  return mkdtempSync(join(baseDir, "oh-my-openagent-verify-smoke-"))
}

export function resolveSmokeTimeoutMs(agentName: string): number {
  const globalOverride = readPositiveIntEnv("OH_MY_OPENAGENT_VERIFY_SMOKE_TIMEOUT_MS")
  if (globalOverride) {
    return globalOverride
  }

  if (agentName === "Prometheus (Plan Builder)") {
    return readPositiveIntEnv("OH_MY_OPENAGENT_VERIFY_ANTHROPIC_SMOKE_TIMEOUT_MS")
      ?? ANTHROPIC_SMOKE_TIMEOUT_OVERRIDE_MS
  }

  return DEFAULT_SMOKE_TIMEOUT_OVERRIDE_MS
}

export function getProviderSmokeConfig(provider: "anthropic" | "openai"): SmokeConfig {
  if (provider === "anthropic") {
    return {
      agentName: "Sisyphus (Ultraworker)",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    }
  }

  return {
    agentName: "Sisyphus (Ultraworker)",
    model: { providerID: "openai", modelID: "gpt-5.4" },
  }
}

async function runSmoke(config: SmokeConfig): Promise<SmokeResult> {
  const port = 44000 + Math.floor(Math.random() * 1000)
  const server = await createOpencodeServer({ port, timeout: 30_000 })
  const smokeDirectory = createSmokeWorkspace()
  const client = createOpencodeClient({
    baseUrl: server.url,
    directory: smokeDirectory,
  })
  const timeoutAt = Date.now() + resolveSmokeTimeoutMs(config.agentName)
  const startedAt = Date.now()
  let nextHeartbeatAt = startedAt + SMOKE_HEARTBEAT_INTERVAL_MS
  let latestOutput = ""

  try {
    const created = await client.session.create({
      body: {
        title: `verify smoke ${config.model.providerID}/${config.model.modelID}`,
        permission: [
          { permission: "question", action: "deny", pattern: "*" },
        ],
      } as Record<string, unknown>,
      query: { directory: smokeDirectory },
    })
    const session = normalizeSdkResponse(created, {} as { id?: string })
    const sessionID = typeof session.id === "string" ? session.id : undefined
    if (!sessionID) {
      return {
        output: "Failed to create smoke session",
        exitCode: 1,
      }
    }

    await client.session.promptAsync({
      path: { id: sessionID },
      body: {
        agent: config.agentName,
        model: config.model,
        parts: [{ type: "text", text: SMOKE_PROMPT }],
      },
      query: { directory: smokeDirectory },
    })

    while (Date.now() < timeoutAt) {
      const messagesResponse = await client.session.messages({
        path: { id: sessionID },
        query: { directory: smokeDirectory },
      })
      const messages = normalizeSdkResponse(messagesResponse, [] as SmokeMessage[])
      const outcome = interpretSmokeMessages(messages)
      if (outcome.output.length > 0) {
        latestOutput = outcome.output
      }

      if (outcome.state === "success") {
        return { output: outcome.output, exitCode: 0 }
      }

      if (outcome.state === "skippable" || outcome.state === "failed") {
        return { output: outcome.output, exitCode: 1 }
      }

      const descendantOutcome = await interpretSmokeDescendantMessages({
        client,
        smokeDirectory,
        sessionID,
      })
      if (descendantOutcome.output.length > 0) {
        latestOutput = descendantOutcome.output
      }

      if (descendantOutcome.state === "success") {
        return { output: descendantOutcome.output, exitCode: 0 }
      }

      if (descendantOutcome.state === "skippable" || descendantOutcome.state === "failed") {
        return { output: descendantOutcome.output, exitCode: 1 }
      }

      const now = Date.now()
      if (now >= nextHeartbeatAt) {
        console.log(
          `[verify] smoke ${config.model.providerID}/${config.model.modelID} still waiting (${Math.round((now - startedAt) / 1000)}s elapsed, ${Math.max(0, Math.round((timeoutAt - now) / 1000))}s left)`,
        )
        nextHeartbeatAt = now + SMOKE_HEARTBEAT_INTERVAL_MS
      }

      await new Promise((resolve) => setTimeout(resolve, 1_000))
    }

    return {
      output: latestOutput || "Timed out waiting for smoke response",
      exitCode: 1,
    }
  } finally {
    server.close()
    killOpencodeServerOnPort(port)
    rmSync(smokeDirectory, { recursive: true, force: true })
  }
}

function killOpencodeServerOnPort(port: number): void {
  Bun.spawnSync(
    [
      "/bin/sh",
      "-lc",
      `pids="$(lsof -tiTCP:${port} -sTCP:LISTEN 2>/dev/null)" && [ -n "$pids" ] && kill -9 $pids >/dev/null 2>&1 || true`,
    ],
    {
      cwd: repoRoot,
      stdout: "ignore",
      stderr: "ignore",
      env: process.env,
    },
  )
}

async function getLiveRuntimeState(): Promise<{
  config: Record<string, unknown>
  listedAgents: ListedAgent[]
}> {
  const port = 43000 + Math.floor(Math.random() * 1000)
  const server = await createOpencodeServer({ port, timeout: 30_000 })
  const client = createOpencodeClient({
    baseUrl: server.url,
    directory: repoRoot,
  })

  try {
    const configResponse = await client.config.get()
    const agentsResponse = await client.app.agents()
    return {
      config: normalizeSdkResponse(configResponse, {} as Record<string, unknown>),
      listedAgents: normalizeSdkResponse(agentsResponse, [] as ListedAgent[]),
    }
  } finally {
    server.close()
    killOpencodeServerOnPort(port)
  }
}

async function main(): Promise<void> {
  console.log("[verify] checking managed files")
  const liveHostPath = join(configDir, "opencode.json")
  const livePluginPath = join(configDir, "oh-my-openagent.json")
  const legacyPluginPath = join(configDir, "oh-my-opencode.json")
  const ignoredCanonicalJsoncPath = join(configDir, "oh-my-openagent.jsonc")
  const runtimePackagePath = join(cacheDir, "package.json")
  const configWorkspacePackagePath = join(configDir, "package.json")
  const configSchemaLink = join(configDir, "node_modules", "oh-my-openagent")

  assertManagedRuntimePackageLayout()

  const liveHost = readJson(liveHostPath)
  const livePlugin = readJson(livePluginPath)
  const runtimePackage = readJson(runtimePackagePath)
  const configWorkspacePackage = readJson(configWorkspacePackagePath)
  const authStore = existsSync(authPath) ? readJson(authPath) : {}

  assert(
    deepEqualJson(liveHost, expectedLiveHost),
    `Live host config drifted from managed asset: ${liveHostPath}`,
  )
  assert(
    deepEqualJson(livePlugin, pluginAsset),
    `Live plugin config drifted from managed asset: ${livePluginPath}`,
  )
  assert(
    !existsSync(ignoredCanonicalJsoncPath),
    `Unsupported canonical JSONC config shadows managed mode: ${ignoredCanonicalJsoncPath}`,
  )
  assert(!existsSync(legacyPluginPath), `Legacy plugin config still exists: ${legacyPluginPath}`)

  const dependencies = runtimePackage.dependencies as Record<string, string> | undefined
  assert(dependencies, `Runtime package is missing dependencies in ${runtimePackagePath}`)
  assert(
    deepEqualJson(dependencies, MANAGED_RUNTIME_PLUGIN_DEPENDENCIES),
    "Runtime package dependencies do not match the managed plugin set",
  )
  assert(
    dependencies["oh-my-openagent"] === undefined,
    "Runtime package still contains a published oh-my-openagent dependency",
  )
  assert(
    dependencies["oh-my-opencode"] === undefined,
    "Runtime package still contains a legacy oh-my-opencode dependency",
  )

  const configWorkspaceDependencies = configWorkspacePackage.dependencies as Record<string, string> | undefined
  assert(configWorkspaceDependencies, `Config workspace package is missing dependencies in ${configWorkspacePackagePath}`)
  assert(
    configWorkspaceDependencies["oh-my-openagent"] === getManagedConfigSchemaDependencySpec(repoRoot),
    "Config workspace package does not pin the local oh-my-openagent schema dependency",
  )
  assert(
    configWorkspaceDependencies["oh-my-opencode"] === undefined,
    "Config workspace package still contains the legacy oh-my-opencode alias",
  )

  assert(existsSync(configSchemaLink), `Missing config schema link: ${configSchemaLink}`)
  assert(lstatSync(configSchemaLink).isSymbolicLink(), `Config schema link is not a symlink: ${configSchemaLink}`)
  assert(
    realpathSync(configSchemaLink) === repoRoot,
    "Config schema symlink does not point to the local fork",
  )

  if (existsSync(codexAuthPath)) {
    assert(
      authStore.openai && typeof authStore.openai === "object",
      "Codex CLI auth exists, but OpenCode auth store is missing the synced OpenAI OAuth entry",
    )
  }

  const effectiveUserConfig = loadEffectiveUserConfig(configDir, {})
  const expectedAgents = buildExpectedAgents(
    (effectiveUserConfig.effectiveConfig as Record<string, unknown> | null) ?? pluginAsset,
  )

  console.log("[verify] querying live runtime")
  const runtimeState = await getLiveRuntimeState()
  assert(
    runtimeState.config.default_agent === hostAsset.default_agent,
    "Runtime default agent does not match the managed host config",
  )

  const runtimeAgentMap = (runtimeState.config.agent ?? {}) as Record<string, RuntimeAgentRecord>
  const runtimeAgentKeys = Object.keys(runtimeAgentMap)
  assertNoForbiddenRuntimeKeys(runtimeAgentMap)
  assert(
    JSON.stringify(runtimeAgentKeys) === JSON.stringify(
      expectedAgents.map((agent) => agent.configKey ?? agent.displayName).concat(["build", "plan"]),
    ),
    `Runtime agent keys do not match the canonical set: ${runtimeAgentKeys.join(", ")}`,
  )
  for (const expectedAgent of expectedAgents) {
    assertRuntimeAgent(runtimeAgentMap, expectedAgent)
  }

  const listedNames = runtimeState.listedAgents
    .map((agent) => agent.name)
    .filter((name): name is string => typeof name === "string")
  for (const expectedAgent of expectedAgents) {
    assert(
      listedNames.includes(expectedAgent.listedName),
      `app.agents() is missing ${expectedAgent.listedName}`,
    )
  }
  for (const forbiddenKey of forbiddenRuntimeAgentKeys) {
    assert(
      !listedNames.includes(forbiddenKey),
      `app.agents() still exposes forbidden alias name: ${forbiddenKey}`,
    )
  }

  if (authStore.anthropic && typeof authStore.anthropic === "object") {
    console.log("[verify] running Anthropic smoke")
    const result = await runSmoke(getProviderSmokeConfig("anthropic"))
    assertSmokeSucceededOrSkippable({
      providerLabel: "Anthropic",
      result,
    })
  }

  if (authStore.openai && typeof authStore.openai === "object") {
    console.log("[verify] running OpenAI smoke")
    const result = await runSmoke(getProviderSmokeConfig("openai"))
    assertSmokeSucceededOrSkippable({
      providerLabel: "OpenAI",
      result,
    })
  }

  console.log("Local OpenCode fork install verified successfully.")
}

if (import.meta.main) {
  await main()
}
