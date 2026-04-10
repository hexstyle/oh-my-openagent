import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { resetConfigContext } from "./config-context"
import { detectCurrentConfig } from "./detect-current-config"
import { addPluginToOpenCodeConfig } from "./add-plugin-to-opencode-config"

describe("detectCurrentConfig - single package detection", () => {
  let testConfigDir = ""
  let testConfigPath = ""
  let testOmoConfigPath = ""

  beforeEach(() => {
    testConfigDir = join(tmpdir(), `omo-detect-config-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    testConfigPath = join(testConfigDir, "opencode.json")
    testOmoConfigPath = join(testConfigDir, "oh-my-openagent.json")

    mkdirSync(testConfigDir, { recursive: true })
    process.env.OPENCODE_CONFIG_DIR = testConfigDir
    resetConfigContext()
  })

  afterEach(() => {
    rmSync(testConfigDir, { recursive: true, force: true })
    resetConfigContext()
    delete process.env.OPENCODE_CONFIG_DIR
  })

  it("detects both legacy and canonical plugin entries", () => {
    // given
    writeFileSync(testConfigPath, JSON.stringify({ plugin: ["oh-my-opencode", "oh-my-openagent@3.11.0"] }, null, 2) + "\n", "utf-8")

    // when
    const result = detectCurrentConfig()

    // then
    expect(result.isInstalled).toBe(true)
  })

  it("returns false when plugin not present with similar name", () => {
    // given
    writeFileSync(testConfigPath, JSON.stringify({ plugin: ["oh-my-openagent-extra"] }, null, 2) + "\n", "utf-8")

    // when
    const result = detectCurrentConfig()

    // then
    expect(result.isInstalled).toBe(false)
  })

  it("detects OpenCode Go from the existing omo config", () => {
    // given
    writeFileSync(testConfigPath, JSON.stringify({ plugin: ["oh-my-opencode"] }, null, 2) + "\n", "utf-8")
    writeFileSync(testOmoConfigPath, JSON.stringify({ agents: { atlas: { model: "opencode-go/kimi-k2.5" } } }, null, 2) + "\n", "utf-8")

    // when
    const result = detectCurrentConfig()

    // then
    expect(result.isInstalled).toBe(true)
    expect(result.hasOpencodeGo).toBe(true)
  })
})

describe("addPluginToOpenCodeConfig - single package writes", () => {
  let testConfigDir = ""
  let testConfigPath = ""

  beforeEach(() => {
    testConfigDir = join(tmpdir(), `omo-add-plugin-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    testConfigPath = join(testConfigDir, "opencode.json")

    mkdirSync(testConfigDir, { recursive: true })
    process.env.OPENCODE_CONFIG_DIR = testConfigDir
    resetConfigContext()
  })

  afterEach(() => {
    rmSync(testConfigDir, { recursive: true, force: true })
    resetConfigContext()
    delete process.env.OPENCODE_CONFIG_DIR
  })

  it("writes canonical plugin entry for new installs", async () => {
    // given
    writeFileSync(testConfigPath, JSON.stringify({}, null, 2) + "\n", "utf-8")

    // when
    const result = await addPluginToOpenCodeConfig("3.11.0")

    // then
    expect(result.success).toBe(true)
    const savedConfig = JSON.parse(readFileSync(testConfigPath, "utf-8"))
    expect(savedConfig.plugin[0]).toMatch(/^oh-my-openagent(?:@.+)?$/)
    expect(savedConfig.plugin).toContain("opencode-claude-auth")
    expect(savedConfig.default_agent).toBe("Prometheus (Plan Builder)")
    expect(savedConfig.lsp.typescript.command).toEqual([
      "typescript-language-server",
      "--stdio",
    ])
    expect(savedConfig.provider.openai.models["gpt-5.4"].limit.context).toBe(200000)
    expect(savedConfig.provider.openai.models["gpt-5.3-codex"]).toBeUndefined()
    expect(savedConfig.provider.openai.models["gpt-5.3-codex-spark"].limit.context).toBe(128000)
  })

  it("upgrades a bare legacy plugin entry to canonical", async () => {
    // given
    writeFileSync(testConfigPath, JSON.stringify({ plugin: ["oh-my-opencode"] }, null, 2) + "\n", "utf-8")

    // when
    const result = await addPluginToOpenCodeConfig("3.11.0")

    // then
    expect(result.success).toBe(true)
    const savedConfig = JSON.parse(readFileSync(testConfigPath, "utf-8"))
    expect(savedConfig.plugin[0]).toBe("oh-my-openagent")
    expect(savedConfig.plugin).toContain("opencode-claude-auth")
  })

  it("normalizes a version-pinned legacy entry to the canonical managed package entry", async () => {
    // given
    writeFileSync(testConfigPath, JSON.stringify({ plugin: ["oh-my-opencode@3.10.0"] }, null, 2) + "\n", "utf-8")

    // when
    const result = await addPluginToOpenCodeConfig("3.11.0")

    // then
    expect(result.success).toBe(true)
    const savedConfig = JSON.parse(readFileSync(testConfigPath, "utf-8"))
    expect(savedConfig.plugin[0]).toBe("oh-my-openagent")
    expect(savedConfig.plugin).toContain("opencode-claude-auth")
  })

  it("removes stale legacy entry when canonical and legacy entries both exist", async () => {
    // given
    writeFileSync(testConfigPath, JSON.stringify({ plugin: ["oh-my-openagent", "oh-my-opencode"] }, null, 2) + "\n", "utf-8")

    // when
    const result = await addPluginToOpenCodeConfig("3.11.0")

    // then
    expect(result.success).toBe(true)
    const savedConfig = JSON.parse(readFileSync(testConfigPath, "utf-8"))
    expect(savedConfig.plugin[0]).toBe("oh-my-openagent")
    expect(savedConfig.plugin).toContain("opencode-claude-auth")
  })

  it("preserves a canonical entry when it already exists", async () => {
    // given
    writeFileSync(testConfigPath, JSON.stringify({ plugin: ["oh-my-openagent@3.10.0"] }, null, 2) + "\n", "utf-8")

    // when
    const result = await addPluginToOpenCodeConfig("3.11.0")

    // then
    expect(result.success).toBe(true)
    const savedConfig = JSON.parse(readFileSync(testConfigPath, "utf-8"))
    expect(savedConfig.plugin[0]).toBe("oh-my-openagent")
  })

  it("rewrites quoted jsonc plugin field in place", async () => {
    // given
    testConfigPath = join(testConfigDir, "opencode.jsonc")
    writeFileSync(testConfigPath, '{\n  "plugin": ["oh-my-opencode"]\n}\n', "utf-8")

    // when
    const result = await addPluginToOpenCodeConfig("3.11.0")

    // then
    expect(result.success).toBe(true)
    const savedConfig = JSON.parse(readFileSync(testConfigPath, "utf-8"))
    expect(savedConfig.plugin[0]).toBe("oh-my-openagent")
    expect(savedConfig.plugin).toContain("opencode-claude-auth")
    expect(savedConfig.default_agent).toBe("Prometheus (Plan Builder)")
    expect(savedConfig.lsp.csharp.command).toEqual(["csharp-ls"])
  })
})
