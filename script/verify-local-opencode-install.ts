#!/usr/bin/env bun

import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs"
import os from "node:os"
import { join, resolve } from "node:path"
import { createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk"

import { loadEffectiveUserConfig } from "../src/custom-opencode/user-config-layers"
import { getAgentDisplayName } from "../src/shared/agent-display-names"
import {
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

  fail(`${args.providerLabel} smoke test did not return OK`)
}

function runSmoke(agentName: string): SmokeResult {
  const result = Bun.spawnSync(
    ["opencode", "run", "--agent", agentName, "Reply with OK only."],
    {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    },
  )

  return {
    output: `${result.stdout.toString("utf-8")}\n${result.stderr.toString("utf-8")}`.trim(),
    exitCode: result.exitCode ?? 0,
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
  const configSchemaLink = join(configDir, "node_modules", "oh-my-openagent")

  const liveHost = readJson(liveHostPath)
  const livePlugin = readJson(livePluginPath)
  const runtimePackage = readJson(runtimePackagePath)
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
    const result = runSmoke("Prometheus (Plan Builder)")
    assertSmokeSucceededOrSkippable({
      providerLabel: "Anthropic",
      result,
    })
  }

  if (authStore.openai && typeof authStore.openai === "object") {
    console.log("[verify] running OpenAI smoke")
    const result = runSmoke("Hephaestus (Deep Agent)")
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
