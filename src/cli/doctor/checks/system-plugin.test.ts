/// <reference types="bun-types" />

import { beforeEach, describe, expect, it, mock } from "bun:test"

type SystemPluginModule = typeof import("./system-plugin")

const mockExistsSync = mock((_path: string) => false)
const mockReadFileSync = mock((_path: string, _encoding: string) => "")
const mockGetOpenCodeConfigPaths = mock(() => ({
  configJsonc: "/tmp/opencode.jsonc",
  configJson: "/tmp/opencode.json",
}))
const mockParseJsonc = mock((content: string) => JSON.parse(content) as { plugin?: string[] })

mock.module("node:fs", () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
}))

mock.module("../../../shared", () => ({
  LEGACY_PLUGIN_NAME: "oh-my-opencode",
  PLUGIN_NAME: "oh-my-openagent",
  getOpenCodeConfigPaths: mockGetOpenCodeConfigPaths,
  parseJsonc: mockParseJsonc,
}))

async function importFreshSystemPluginModule(): Promise<SystemPluginModule> {
  return import(`./system-plugin?test=${Date.now()}-${Math.random()}`)
}

describe("system plugin detection", () => {
  beforeEach(() => {
    mockExistsSync.mockReset()
    mockReadFileSync.mockReset()
    mockGetOpenCodeConfigPaths.mockReset()
    mockParseJsonc.mockReset()

    mockExistsSync.mockImplementation((path: string) => path === "/tmp/opencode.json")
    mockReadFileSync.mockImplementation((_path: string, _encoding: string) => JSON.stringify({
      plugin: ["oh-my-openagent"],
    }))
    mockGetOpenCodeConfigPaths.mockReturnValue({
      configJsonc: "/tmp/opencode.jsonc",
      configJson: "/tmp/opencode.json",
    })
    mockParseJsonc.mockImplementation((content: string) => JSON.parse(content) as { plugin?: string[] })
  })

  it("accepts the canonical package entry as a registered plugin", async () => {
    const { findPluginEntry, getPluginInfo } = await importFreshSystemPluginModule()

    expect(findPluginEntry(["oh-my-openagent"]))
      .toEqual({ entry: "oh-my-openagent", isLocalDev: false })

    expect(getPluginInfo()).toEqual({
      registered: true,
      configPath: "/tmp/opencode.json",
      entry: "oh-my-openagent",
      isPinned: false,
      pinnedVersion: null,
      isLocalDev: false,
    })
  })
})
