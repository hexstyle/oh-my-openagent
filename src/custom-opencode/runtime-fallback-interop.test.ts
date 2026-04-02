import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"

const managedPluginConfigPath = new URL("../../assets/custom-opencode/oh-my-opencode.json", import.meta.url)

type ManagedPluginConfig = {
  runtime_fallback?: {
    enabled?: boolean
  }
  disabled_hooks?: string[]
}

describe("custom runtime fallback interoperability", () => {
  it("keeps custom runtime fallback enabled while disabling built-in aborting fallback hooks", () => {
    const managedConfig = JSON.parse(
      readFileSync(managedPluginConfigPath, "utf-8")
    ) as ManagedPluginConfig

    expect(managedConfig.runtime_fallback?.enabled).toBe(true)
    expect(managedConfig.disabled_hooks).toEqual(
      expect.arrayContaining(["runtime-fallback", "model-fallback"])
    )
  })
})
