import { afterAll, afterEach, describe, expect, mock, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const readCachedModelCatalogMock = mock(() => new Set<string>())
const resolveKnownCachedModelMock = mock((_target: string, availableModels: Set<string>) => availableModels.size > 0 ? null : "known")

mock.module("../../shared/model-availability", () => ({
  readCachedModelCatalog: readCachedModelCatalogMock,
  resolveKnownCachedModel: resolveKnownCachedModelMock,
  fuzzyMatchModel: mock(() => null),
  isModelAvailable: mock(() => false),
  getConnectedProviders: mock(async () => []),
  fetchAvailableModels: mock(async () => new Set<string>()),
  __resetModelCache: mock(() => {}),
  isModelCacheAvailable: mock(() => false),
}))

import { getFallbackModelsForSession } from "./fallback-models"
import { SessionCategoryRegistry } from "../../shared/session-category-registry"

describe("runtime-fallback fallback-models", () => {
  afterEach(() => {
    SessionCategoryRegistry.clear()
    readCachedModelCatalogMock.mockReturnValue(new Set())
    resolveKnownCachedModelMock.mockImplementation((_target: string, availableModels: Set<string>) => availableModels.size > 0 ? null : "known")
  })

  afterAll(() => {
    mock.restore()
  })

  test("uses category fallback_models when session category is registered", () => {
    //#given
    const sessionID = "ses_runtime_fallback_category"
    SessionCategoryRegistry.register(sessionID, "quick")
    const pluginConfig = {
      categories: {
        quick: {
          fallback_models: ["openai/gpt-5.2", "anthropic/claude-opus-4-6"],
        },
      },
    } as any

    //#when
    const result = getFallbackModelsForSession(sessionID, undefined, pluginConfig)

    //#then
    expect(result).toEqual(["openai/gpt-5.2", "anthropic/claude-opus-4-6"])
  })

  test("uses agent-specific fallback_models when agent is resolved", () => {
    //#given
    const pluginConfig = {
      agents: {
        oracle: {
          fallback_models: ["openai/gpt-5.2", "anthropic/claude-opus-4-6"],
        },
      },
    } as any

    //#when
    const result = getFallbackModelsForSession("ses_runtime_fallback_agent", "oracle", pluginConfig)

    //#then
    expect(result).toEqual(["openai/gpt-5.2", "anthropic/claude-opus-4-6"])
  })

  test("resolves agent-specific fallback_models from canonical display names", () => {
    const pluginConfig = {
      agents: {
        atlas: {
          fallback_models: ["anthropic/claude-sonnet-4-6", "openai/gpt-5.3-codex-spark"],
        },
      },
      fallback_models: ["openai/gpt-5.4", "opencode/minimax-m2.5-free"],
    } as any

    const result = getFallbackModelsForSession(
      "ses_runtime_fallback_display_name",
      "Atlas (Plan Executor)",
      pluginConfig,
    )

    expect(result).toEqual([
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5.3-codex-spark",
    ])
  })

  test("does not fall back to another agent chain when agent cannot be resolved", () => {
    //#given
    const pluginConfig = {
      agents: {
        sisyphus: {
          fallback_models: ["quotio/gpt-5.2", "quotio/glm-5", "quotio/kimi-k2.5"],
        },
        oracle: {
          fallback_models: ["openai/gpt-5.2", "anthropic/claude-opus-4-6"],
        },
      },
    } as any

    //#when
    const result = getFallbackModelsForSession("ses_runtime_fallback_unknown", undefined, pluginConfig)

    //#then
    expect(result).toEqual([])
  })

  test("filters unknown fallback models when the cached catalog is available", () => {
    readCachedModelCatalogMock.mockReturnValue(new Set([
      "openai/gpt-5.3-codex-spark",
      "opencode/nemotron-3-super-free",
    ]))
    resolveKnownCachedModelMock.mockImplementation((target: string, availableModels: Set<string>) =>
      availableModels.has(target) ? target : null
    )

    const pluginConfig = {
      agents: {
        explore: {
          fallback_models: [
            "openai/gpt-5.3-codex-spark",
            "opencode/qwen3.6-plus-free",
            "opencode/nemotron-3-super-free",
          ],
        },
      },
    } as any

    const result = getFallbackModelsForSession("ses_runtime_fallback_filtered", "explore", pluginConfig)

    expect(result).toEqual([
      "openai/gpt-5.3-codex-spark",
      "opencode/nemotron-3-super-free",
    ])
  })

  test("managed sisyphus-junior chain keeps paid models ahead of spark and free", () => {
    const managedConfig = JSON.parse(
      readFileSync(
        join(import.meta.dir, "../../../assets/custom-opencode/oh-my-opencode.json"),
        "utf8",
      ),
    )

    const result = getFallbackModelsForSession(
      "ses_runtime_fallback_sisyphus_junior",
      "sisyphus-junior",
      managedConfig,
    )

    expect(result).toEqual([
      "anthropic/claude-opus-4-7",
      "openai/gpt-5.4",
      "openai/gpt-5.3-codex-spark",
      "opencode/nemotron-3-super-free",
      "opencode/minimax-m2.5-free",
      "opencode/big-pickle",
    ])
  })

  test("managed explore chain keeps paid OpenAI and Claude before free fallback", () => {
    const managedConfig = JSON.parse(
      readFileSync(
        join(import.meta.dir, "../../../assets/custom-opencode/oh-my-opencode.json"),
        "utf8",
      ),
    )

    const result = getFallbackModelsForSession(
      "ses_runtime_fallback_explore",
      "explore",
      managedConfig,
    )

    expect(result).toEqual([
      "openai/gpt-5.4",
      "anthropic/claude-opus-4-6",
      "openai/gpt-5.3-codex-spark",
      "opencode/nemotron-3-super-free",
      "opencode/minimax-m2.5-free",
      "opencode/big-pickle",
    ])
  })
})
