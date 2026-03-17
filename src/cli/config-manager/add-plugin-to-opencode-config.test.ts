import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { initConfigContext, resetConfigContext } from "./config-context"
import { addPluginToOpenCodeConfig } from "./add-plugin-to-opencode-config"

describe("addPluginToOpenCodeConfig", () => {
  let testConfigDir = ""
  let testConfigPath = ""

  beforeEach(() => {
    testConfigDir = join(tmpdir(), `omo-add-plugin-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    testConfigPath = join(testConfigDir, "opencode.json")

    mkdirSync(testConfigDir, { recursive: true })
    process.env.OPENCODE_CONFIG_DIR = testConfigDir
    resetConfigContext()
    initConfigContext("opencode", null)
  })

  afterEach(() => {
    rmSync(testConfigDir, { recursive: true, force: true })
    resetConfigContext()
    delete process.env.OPENCODE_CONFIG_DIR
  })

  describe("#given opencode.json with oh-my-opencode plugin", () => {
    it("replaces oh-my-opencode with new plugin entry", async () => {
      // given
      const config = { plugin: ["oh-my-opencode"] }
      writeFileSync(testConfigPath, JSON.stringify(config, null, 2) + "\n", "utf-8")

      // when
      const result = await addPluginToOpenCodeConfig("3.11.0")

      // then
      expect(result.success).toBe(true)
      const savedConfig = JSON.parse(readFileSync(testConfigPath, "utf-8"))
      // getPluginNameWithVersion returns just the name (without version) for non-dist-tag versions
      expect(savedConfig.plugin).toContain("oh-my-openagent")
      expect(savedConfig.plugin).not.toContain("oh-my-opencode")
    })

    it("replaces oh-my-opencode@old-version with new plugin entry", async () => {
      // given
      const config = { plugin: ["oh-my-opencode@1.0.0"] }
      writeFileSync(testConfigPath, JSON.stringify(config, null, 2) + "\n", "utf-8")

      // when
      const result = await addPluginToOpenCodeConfig("3.11.0")

      // then
      expect(result.success).toBe(true)
      const savedConfig = JSON.parse(readFileSync(testConfigPath, "utf-8"))
      expect(savedConfig.plugin).toContain("oh-my-openagent")
      expect(savedConfig.plugin).not.toContain("oh-my-opencode@1.0.0")
    })
  })

  describe("#given opencode.json with oh-my-openagent plugin", () => {
    it("keeps existing oh-my-openagent when no version change needed", async () => {
      // given
      const config = { plugin: ["oh-my-openagent"] }
      writeFileSync(testConfigPath, JSON.stringify(config, null, 2) + "\n", "utf-8")

      // when
      const result = await addPluginToOpenCodeConfig("3.11.0")

      // then
      expect(result.success).toBe(true)
      const savedConfig = JSON.parse(readFileSync(testConfigPath, "utf-8"))
      // Should keep the existing entry since getPluginNameWithVersion returns same name
      expect(savedConfig.plugin).toContain("oh-my-openagent")
    })

    it("replaces oh-my-openagent@old-version with new plugin entry", async () => {
      // given
      const config = { plugin: ["oh-my-openagent@1.0.0"] }
      writeFileSync(testConfigPath, JSON.stringify(config, null, 2) + "\n", "utf-8")

      // when
      const result = await addPluginToOpenCodeConfig("3.11.0")

      // then
      expect(result.success).toBe(true)
      const savedConfig = JSON.parse(readFileSync(testConfigPath, "utf-8"))
      expect(savedConfig.plugin).toContain("oh-my-openagent")
    })
  })

  describe("#given opencode.json with other plugins", () => {
    it("adds new plugin alongside existing plugins", async () => {
      // given
      const config = { plugin: ["some-other-plugin"] }
      writeFileSync(testConfigPath, JSON.stringify(config, null, 2) + "\n", "utf-8")

      // when
      const result = await addPluginToOpenCodeConfig("3.11.0")

      // then
      expect(result.success).toBe(true)
      const savedConfig = JSON.parse(readFileSync(testConfigPath, "utf-8"))
      expect(savedConfig.plugin).toContain("oh-my-openagent")
      expect(savedConfig.plugin).toContain("some-other-plugin")
    })
  })
})
