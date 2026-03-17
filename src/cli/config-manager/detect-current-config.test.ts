import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { initConfigContext, resetConfigContext } from "./config-context"
import { detectCurrentConfig } from "./detect-current-config"

describe("detectCurrentConfig", () => {
  let testConfigDir = ""
  let testConfigPath = ""

  beforeEach(() => {
    testConfigDir = join(tmpdir(), `omo-detect-config-${Date.now()}-${Math.random().toString(36).slice(2)}`)
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
    it("returns isInstalled: true when plugin array contains oh-my-opencode", () => {
      // given
      const config = { plugin: ["oh-my-opencode"] }
      writeFileSync(testConfigPath, JSON.stringify(config, null, 2) + "\n", "utf-8")

      // when
      const result = detectCurrentConfig()

      // then
      expect(result.isInstalled).toBe(true)
    })

    it("returns isInstalled: true when plugin array contains oh-my-opencode with version", () => {
      // given
      const config = { plugin: ["oh-my-opencode@3.11.0"] }
      writeFileSync(testConfigPath, JSON.stringify(config, null, 2) + "\n", "utf-8")

      // when
      const result = detectCurrentConfig()

      // then
      expect(result.isInstalled).toBe(true)
    })
  })

  describe("#given opencode.json with oh-my-openagent plugin", () => {
    it("returns isInstalled: true when plugin array contains oh-my-openagent", () => {
      // given
      const config = { plugin: ["oh-my-openagent"] }
      writeFileSync(testConfigPath, JSON.stringify(config, null, 2) + "\n", "utf-8")

      // when
      const result = detectCurrentConfig()

      // then
      expect(result.isInstalled).toBe(true)
    })

    it("returns isInstalled: true when plugin array contains oh-my-openagent with version", () => {
      // given
      const config = { plugin: ["oh-my-openagent@3.11.0"] }
      writeFileSync(testConfigPath, JSON.stringify(config, null, 2) + "\n", "utf-8")

      // when
      const result = detectCurrentConfig()

      // then
      expect(result.isInstalled).toBe(true)
    })
  })

  describe("#given opencode.json with no plugin", () => {
    it("returns isInstalled: false when plugin array is empty", () => {
      // given
      const config = { plugin: [] }
      writeFileSync(testConfigPath, JSON.stringify(config, null, 2) + "\n", "utf-8")

      // when
      const result = detectCurrentConfig()

      // then
      expect(result.isInstalled).toBe(false)
    })

    it("returns isInstalled: false when plugin array does not contain our plugin", () => {
      // given
      const config = { plugin: ["some-other-plugin"] }
      writeFileSync(testConfigPath, JSON.stringify(config, null, 2) + "\n", "utf-8")

      // when
      const result = detectCurrentConfig()

      // then
      expect(result.isInstalled).toBe(false)
    })
  })
})
