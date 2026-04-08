import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { loadPluginConfig } from "../plugin-config"
import { detectPluginConfigFile } from "../shared/jsonc-parser"

const tempDirs: string[] = []

function makeTempDir(prefix: string) {
  const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  tempDirs.push(dir)
  return dir
}

function writeJson(filePath: string, value: unknown) {
  writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf-8")
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }

  delete process.env.OPENCODE_CONFIG_DIR
})

describe("legacy alias and basename compatibility", () => {
  it("prefers the canonical basename when both plugin config names exist in the same directory", () => {
    const configDir = makeTempDir("alias-compat-detect")

    writeJson(join(configDir, "oh-my-openagent.json"), {
      agents: {
        prometheus: {
          model: "openai/gpt-5.4",
        },
      },
    })
    writeJson(join(configDir, "oh-my-opencode.json"), {
      agents: {
        prometheus: {
          model: "anthropic/claude-opus-4-6",
        },
      },
    })

    const detected = detectPluginConfigFile(configDir)

    expect(detected.format).toBe("json")
    expect(detected.path).toBe(join(configDir, "oh-my-openagent.json"))
    expect(detected.legacyPath).toBe(join(configDir, "oh-my-opencode.json"))
  })

  it("still loads legacy user and project basenames when no canonical sibling exists", () => {
    const projectDir = makeTempDir("alias-compat-project")
    const userConfigDir = makeTempDir("alias-compat-user")
    const projectConfigDir = join(projectDir, ".opencode")

    mkdirSync(projectConfigDir, { recursive: true })
    process.env.OPENCODE_CONFIG_DIR = userConfigDir

    writeJson(join(userConfigDir, "oh-my-opencode.json"), {
      agents: {
        prometheus: {
          model: "openai/gpt-5.4",
          variant: "high",
        },
      },
    })

    writeJson(join(projectConfigDir, "oh-my-opencode.json"), {
      agents: {
        prometheus: {
          prompt_append: "Project legacy override stays compatible.",
        },
      },
    })

    const config = loadPluginConfig(projectDir, {})

    expect(config.agents?.prometheus?.model).toBe("openai/gpt-5.4")
    expect(config.agents?.prometheus?.variant).toBe("high")
    expect(config.agents?.prometheus?.prompt_append).toBe(
      "Project legacy override stays compatible."
    )
  })

  it("uses the canonical config when a legacy sibling is also present", () => {
    const projectDir = makeTempDir("alias-compat-canonical-project")
    const userConfigDir = makeTempDir("alias-compat-canonical-user")
    const projectConfigDir = join(projectDir, ".opencode")

    mkdirSync(projectConfigDir, { recursive: true })
    process.env.OPENCODE_CONFIG_DIR = userConfigDir

    writeJson(join(userConfigDir, "oh-my-openagent.json"), {
      agents: {
        prometheus: {
          model: "openai/gpt-5.4",
          variant: "high",
        },
      },
    })
    writeJson(join(userConfigDir, "oh-my-opencode.json"), {
      agents: {
        prometheus: {
          model: "anthropic/claude-sonnet-4-6",
          variant: "low",
        },
      },
    })

    const config = loadPluginConfig(projectDir, {})

    expect(config.agents?.prometheus?.model).toBe("openai/gpt-5.4")
    expect(config.agents?.prometheus?.variant).toBe("high")
  })
})
