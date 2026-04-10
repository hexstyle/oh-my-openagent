declare const require: (name: string) => any
const { afterEach, beforeEach, describe, expect, mock, spyOn, test } = require("bun:test")

import * as connectedProvidersCache from "../../shared/connected-providers-cache"
import * as providerModelTransform from "../../shared/provider-model-id-transform"
import * as modelAvailability from "../../shared/model-availability"
import * as modelErrorClassifier from "../../shared/model-error-classifier"

const readConnectedProvidersCacheMock = mock(() => null)
const readProviderModelsCacheMock = mock(() => null)
const readCachedModelCatalogMock = mock(() => new Set<string>())
const resolveKnownCachedModelMock = mock((_target: string, availableModels: Set<string>) => availableModels.size > 0 ? null : "known")
const shouldRetryErrorMock = mock((error: { message?: string } = {}) => {
  const message = (error.message ?? "").toLowerCase()
  return [
    "bad gateway",
    "overloaded",
    "retrying in",
    "unknown provider",
    "model not found",
    "too many requests",
    "service unavailable",
    "503",
    "529",
  ].some((token) => message.includes(token))
})
const shouldSwitchFallbackMock = mock((error: { message?: string } = {}) => {
  const message = (error.message ?? "").toLowerCase()
  return [
    "quota",
    "usage limit",
    "limit reached",
    "insufficient",
    "billing",
    "payment required",
    "429",
    "402",
  ].some((token) => message.includes(token))
})
const getNextFallbackMock = mock((chain: Array<{ model: string }>, attempt: number) => chain[attempt])
const hasMoreFallbacksMock = mock((chain: Array<{ model: string }>, attempt: number) => attempt < chain.length)
const selectFallbackProviderMock = mock((providers: string[], preferredProviderID?: string) => {
  const connectedProviders = readConnectedProvidersCacheMock()
  if (connectedProviders) {
    const connectedSet = new Set(connectedProviders.map((provider: string) => provider.toLowerCase()))

    for (const provider of providers) {
      if (connectedSet.has(provider.toLowerCase())) {
        return provider
      }
    }

    if (preferredProviderID && connectedSet.has(preferredProviderID.toLowerCase())) {
      return preferredProviderID
    }
  }

  return providers[0] || preferredProviderID || "opencode"
})
const transformModelForProviderMock = mock((provider: string, model: string) => {
  if (provider === "github-copilot") {
    return model
      .replace("claude-opus-4-6", "claude-opus-4.6")
      .replace("claude-sonnet-4-6", "claude-sonnet-4.6")
      .replace("claude-sonnet-4-5", "claude-sonnet-4.5")
      .replace("claude-haiku-4-5", "claude-haiku-4.5")
      .replace("claude-sonnet-4", "claude-sonnet-4")
      .replace(/gemini-3\.1-pro(?!-)/g, "gemini-3.1-pro-preview")
      .replace(/gemini-3-flash(?!-)/g, "gemini-3-flash-preview")
  }
  if (provider === "google") {
    return model
      .replace(/gemini-3\.1-pro(?!-)/g, "gemini-3.1-pro-preview")
      .replace(/gemini-3-flash(?!-)/g, "gemini-3-flash-preview")
  }
  return model
})

import {
  clearPendingModelFallback,
  clearSessionFallbackChain,
  createModelFallbackHook,
  setSessionFallbackChain,
  setPendingModelFallback,
} from "./hook"

describe("model fallback hook", () => {
  beforeEach(() => {
    mock.restore()
    spyOn(connectedProvidersCache, "readConnectedProvidersCache").mockImplementation(() => readConnectedProvidersCacheMock())
    spyOn(connectedProvidersCache, "readProviderModelsCache").mockImplementation(() => readProviderModelsCacheMock())
    spyOn(providerModelTransform, "transformModelForProvider").mockImplementation((provider: string, model: string) =>
      transformModelForProviderMock(provider, model)
    )
    spyOn(modelAvailability, "readCachedModelCatalog").mockImplementation(() => readCachedModelCatalogMock())
    spyOn(modelAvailability, "resolveKnownCachedModel").mockImplementation((target: string, availableModels: Set<string>) =>
      resolveKnownCachedModelMock(target, availableModels)
    )
    spyOn(modelErrorClassifier, "shouldRetryError").mockImplementation((error: { message?: string } = {}) =>
      shouldRetryErrorMock(error)
    )
    spyOn(modelErrorClassifier, "shouldSwitchFallback").mockImplementation((error: { message?: string } = {}) =>
      shouldSwitchFallbackMock(error)
    )
    spyOn(modelErrorClassifier, "getNextFallback").mockImplementation((chain: Array<{ model: string }>, attempt: number) =>
      getNextFallbackMock(chain, attempt)
    )
    spyOn(modelErrorClassifier, "hasMoreFallbacks").mockImplementation((chain: Array<{ model: string }>, attempt: number) =>
      hasMoreFallbacksMock(chain, attempt)
    )
    spyOn(modelErrorClassifier, "selectFallbackProvider").mockImplementation((providers: string[], preferredProviderID?: string) =>
      selectFallbackProviderMock(providers, preferredProviderID)
    )

    readConnectedProvidersCacheMock.mockReturnValue(null)
    readProviderModelsCacheMock.mockReturnValue(null)
    readCachedModelCatalogMock.mockReturnValue(new Set())
    readConnectedProvidersCacheMock.mockClear()
    readProviderModelsCacheMock.mockClear()
    readCachedModelCatalogMock.mockClear()
    selectFallbackProviderMock.mockClear()
    shouldRetryErrorMock.mockClear()
    shouldSwitchFallbackMock.mockClear()
    getNextFallbackMock.mockClear()
    hasMoreFallbacksMock.mockClear()
    resolveKnownCachedModelMock.mockImplementation((_target: string, availableModels: Set<string>) => availableModels.size > 0 ? null : "known")

    clearPendingModelFallback("ses_model_fallback_main")
    clearPendingModelFallback("ses_model_fallback_ghcp")
    clearPendingModelFallback("ses_model_fallback_google")
    clearSessionFallbackChain("ses_model_fallback_main")
    clearSessionFallbackChain("ses_model_fallback_ghcp")
    clearSessionFallbackChain("ses_model_fallback_google")
  })

  afterEach(() => {
    mock.restore()
  })

  test("applies pending fallback on chat.message by overriding model", async () => {
    //#given
    const hook = createModelFallbackHook() as unknown as {
      "chat.message"?: (
        input: { sessionID: string },
        output: { message: Record<string, unknown>; parts: Array<{ type: string; text?: string }> },
      ) => Promise<void>
    }

    const set = setPendingModelFallback(
      "ses_model_fallback_main",
      "Sisyphus (Ultraworker)",
      "anthropic",
      "claude-opus-4-6-thinking",
    )
    expect(set).toBe(true)

    const output = {
      message: {
        model: { providerID: "anthropic", modelID: "claude-opus-4-6-thinking" },
        variant: "max",
      },
      parts: [{ type: "text", text: "continue" }],
    }

    //#when
    await hook["chat.message"]?.(
      { sessionID: "ses_model_fallback_main" },
      output,
    )

    //#then
    expect(output.message["model"]).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-4-6",
    })
  })

  test("skips unknown fallback models before applying the next valid fallback", async () => {
    readCachedModelCatalogMock.mockReturnValue(new Set([
      "openai/gpt-5.4",
    ]))
    resolveKnownCachedModelMock.mockImplementation((target: string, availableModels: Set<string>) =>
      availableModels.has(target) ? target : null
    )

    setSessionFallbackChain("ses_model_fallback_main", [
      { providers: ["opencode"], model: "qwen3.6-plus-free" },
      { providers: ["openai"], model: "gpt-5.4" },
    ])

    const hook = createModelFallbackHook() as unknown as {
      "chat.message"?: (
        input: { sessionID: string },
        output: { message: Record<string, unknown>; parts: Array<{ type: string; text?: string }> },
      ) => Promise<void>
    }

    const set = setPendingModelFallback(
      "ses_model_fallback_main",
      "Explore (Code Search)",
      "openai",
      "gpt-5.3-codex-spark",
    )
    expect(set).toBe(true)

    const output = {
      message: {
        model: { providerID: "openai", modelID: "gpt-5.3-codex-spark" },
      },
      parts: [{ type: "text", text: "continue" }],
    }

    await hook["chat.message"]?.({ sessionID: "ses_model_fallback_main" }, output)

    expect(output.message["model"]).toEqual({
      providerID: "openai",
      modelID: "gpt-5.4",
    })
  })

  test("preserves explicit session fallback chains even when cached catalog does not know the first model", async () => {
    readCachedModelCatalogMock.mockReturnValue(new Set([
      "quotio/kimi-k2.5",
    ]))
    resolveKnownCachedModelMock.mockImplementation((target: string, availableModels: Set<string>) =>
      availableModels.has(target) ? target : null
    )

    setSessionFallbackChain("ses_model_fallback_main", [
      { providers: ["quotio"], model: "gpt-5.2" },
      { providers: ["quotio"], model: "kimi-k2.5" },
    ], { trustUnknownModels: true })

    const hook = createModelFallbackHook() as unknown as {
      "chat.message"?: (
        input: { sessionID: string },
        output: { message: Record<string, unknown>; parts: Array<{ type: string; text?: string }> },
      ) => Promise<void>
    }

    const set = setPendingModelFallback(
      "ses_model_fallback_main",
      "Sisyphus (Ultraworker)",
      "quotio",
      "claude-opus-4-6",
    )
    expect(set).toBe(true)

    const output = {
      message: {
        model: { providerID: "quotio", modelID: "claude-opus-4-6" },
      },
      parts: [{ type: "text", text: "continue" }],
    }

    await hook["chat.message"]?.({ sessionID: "ses_model_fallback_main" }, output)

    expect(output.message["model"]).toEqual({
      providerID: "quotio",
      modelID: "gpt-5.2",
    })
  })

  test("preserves fallback progression across repeated session.error retries", async () => {
    //#given
    const hook = createModelFallbackHook() as unknown as {
      "chat.message"?: (
        input: { sessionID: string },
        output: { message: Record<string, unknown>; parts: Array<{ type: string; text?: string }> },
      ) => Promise<void>
    }
    const sessionID = "ses_model_fallback_main"

    expect(
      setPendingModelFallback(sessionID, "Sisyphus (Ultraworker)", "anthropic", "claude-opus-4-6-thinking"),
    ).toBe(true)

    const firstOutput = {
      message: {
        model: { providerID: "anthropic", modelID: "claude-opus-4-6-thinking" },
        variant: "max",
      },
      parts: [{ type: "text", text: "continue" }],
    }

    //#when - first retry is applied
    await hook["chat.message"]?.({ sessionID }, firstOutput)

    //#then
    expect(firstOutput.message["model"]).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-4-6",
    })

    //#when - second error re-arms fallback and should advance to next entry
    expect(
      setPendingModelFallback(sessionID, "Sisyphus (Ultraworker)", "anthropic", "claude-opus-4-6"),
    ).toBe(true)

    const secondOutput = {
      message: {
        model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
      },
      parts: [{ type: "text", text: "continue" }],
    }
    await hook["chat.message"]?.({ sessionID }, secondOutput)

    //#then - chain should progress to entry[1], not repeat entry[0]
    expect(secondOutput.message["model"]).toEqual({
      providerID: "opencode-go",
      modelID: "kimi-k2.5",
    })
    expect(secondOutput.message["variant"]).toBeUndefined()
  })

  test("does not re-arm fallback when one is already pending", () => {
    //#given
    const sessionID = "ses_model_fallback_pending_guard"
    clearPendingModelFallback(sessionID)

    //#when
    const firstSet = setPendingModelFallback(
      sessionID,
      "Sisyphus (Ultraworker)",
      "anthropic",
      "claude-opus-4-6-thinking",
    )
    const secondSet = setPendingModelFallback(
      sessionID,
      "Sisyphus (Ultraworker)",
      "anthropic",
      "claude-opus-4-6-thinking",
    )

    //#then
    expect(firstSet).toBe(true)
    expect(secondSet).toBe(false)
    clearPendingModelFallback(sessionID)
  })

  test("skips no-op fallback entries that resolve to same provider/model", async () => {
    //#given
    const sessionID = "ses_model_fallback_noop_skip"
    clearPendingModelFallback(sessionID)

    const hook = createModelFallbackHook() as unknown as {
      "chat.message"?: (
        input: { sessionID: string },
        output: { message: Record<string, unknown>; parts: Array<{ type: string; text?: string }> },
      ) => Promise<void>
    }

    setSessionFallbackChain(sessionID, [
      { providers: ["anthropic"], model: "claude-opus-4-6" },
      { providers: ["opencode"], model: "kimi-k2.5-free" },
    ])

    expect(
      setPendingModelFallback(
        sessionID,
        "Sisyphus (Ultraworker)",
        "anthropic",
        "claude-opus-4-6",
      ),
    ).toBe(true)

    const output = {
      message: {
        model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
      },
      parts: [{ type: "text", text: "continue" }],
    }

    //#when
    await hook["chat.message"]?.({ sessionID }, output)

    //#then
    expect(output.message["model"]).toEqual({
      providerID: "opencode",
      modelID: "kimi-k2.5-free",
    })
    clearPendingModelFallback(sessionID)
  })

  test("skips no-op fallback entries even when variant differs", async () => {
    //#given
    const sessionID = "ses_model_fallback_noop_variant_skip"
    clearPendingModelFallback(sessionID)

    const hook = createModelFallbackHook() as unknown as {
      "chat.message"?: (
        input: { sessionID: string },
        output: { message: Record<string, unknown>; parts: Array<{ type: string; text?: string }> },
      ) => Promise<void>
    }

    setSessionFallbackChain(sessionID, [
      { providers: ["quotio"], model: "claude-opus-4-6", variant: "max" },
      { providers: ["quotio"], model: "gpt-5.2" },
    ])

    expect(
      setPendingModelFallback(
        sessionID,
        "Sisyphus (Ultraworker)",
        "quotio",
        "claude-opus-4-6",
      ),
    ).toBe(true)

    const output = {
      message: {
        model: { providerID: "quotio", modelID: "claude-opus-4-6" },
        variant: "max",
      },
      parts: [{ type: "text", text: "continue" }],
    }

    //#when
    await hook["chat.message"]?.({ sessionID }, output)

    //#then
    expect(output.message["model"]).toEqual({
      providerID: "quotio",
      modelID: "gpt-5.2",
    })
    expect(output.message["variant"]).toBeUndefined()
    clearPendingModelFallback(sessionID)
  })

  test("uses connected preferred provider when fallback entry providers are disconnected", async () => {
    //#given
    const sessionID = "ses_model_fallback_preferred_provider"
    clearPendingModelFallback(sessionID)
    readConnectedProvidersCacheMock.mockReturnValue(["provider-x"])

    const hook = createModelFallbackHook() as unknown as {
      "chat.message"?: (
        input: { sessionID: string },
        output: { message: Record<string, unknown>; parts: Array<{ type: string; text?: string }> },
      ) => Promise<void>
    }

    setSessionFallbackChain(sessionID, [
      { providers: ["provider-y"], model: "fallback-model" },
    ])

    expect(
      setPendingModelFallback(
        sessionID,
        "Sisyphus (Ultraworker)",
        "provider-x",
        "current-model",
      ),
    ).toBe(true)

    const output = {
      message: {
        model: { providerID: "provider-x", modelID: "current-model" },
      },
      parts: [{ type: "text", text: "continue" }],
    }

    //#when
    await hook["chat.message"]?.({ sessionID }, output)

    //#then
    expect(output.message["model"]).toEqual({
      providerID: "provider-x",
      modelID: "fallback-model",
    })
    clearPendingModelFallback(sessionID)
  })

  test("shows toast when fallback is applied", async () => {
    //#given
    const toastCalls: Array<{ title: string; message: string }> = []
    const hook = createModelFallbackHook({
      toast: async ({ title, message }) => {
        toastCalls.push({ title, message })
      },
    }) as unknown as {
      "chat.message"?: (
        input: { sessionID: string },
        output: { message: Record<string, unknown>; parts: Array<{ type: string; text?: string }> },
      ) => Promise<void>
    }

    const set = setPendingModelFallback(
      "ses_model_fallback_toast",
      "Sisyphus (Ultraworker)",
      "anthropic",
      "claude-opus-4-6-thinking",
    )
    expect(set).toBe(true)

    const output = {
      message: {
        model: { providerID: "anthropic", modelID: "claude-opus-4-6-thinking" },
        variant: "max",
      },
      parts: [{ type: "text", text: "continue" }],
    }

    //#when
    await hook["chat.message"]?.({ sessionID: "ses_model_fallback_toast" }, output)

    //#then
    expect(toastCalls.length).toBe(1)
    expect(toastCalls[0]?.title).toBe("Model fallback")
  })

  test("transforms model names for github-copilot provider via fallback chain", async () => {
    //#given
    const sessionID = "ses_model_fallback_ghcp"
    clearPendingModelFallback(sessionID)

    const hook = createModelFallbackHook() as unknown as {
      "chat.message"?: (
        input: { sessionID: string },
        output: { message: Record<string, unknown>; parts: Array<{ type: string; text?: string }> },
      ) => Promise<void>
    }

    // Set a custom fallback chain that routes through github-copilot
    setSessionFallbackChain(sessionID, [
      { providers: ["github-copilot"], model: "claude-sonnet-4-6" },
    ])

    const set = setPendingModelFallback(
      sessionID,
      "Atlas (Plan Executor)",
      "github-copilot",
      "claude-sonnet-4-5",
    )
    expect(set).toBe(true)

    const output = {
      message: {
        model: { providerID: "github-copilot", modelID: "claude-sonnet-4-6" },
      },
      parts: [{ type: "text", text: "continue" }],
    }

    //#when
    await hook["chat.message"]?.({ sessionID }, output)

    //#then — model name should be transformed from hyphen to dot notation
    expect(output.message["model"]).toEqual({
      providerID: "github-copilot",
      modelID: "claude-sonnet-4.6",
    })

    clearPendingModelFallback(sessionID)
  })

  test("preserves canonical google preview model names via fallback chain", async () => {
    //#given
    const sessionID = "ses_model_fallback_google"
    clearPendingModelFallback(sessionID)

    const hook = createModelFallbackHook() as unknown as {
      "chat.message"?: (
        input: { sessionID: string },
        output: { message: Record<string, unknown>; parts: Array<{ type: string; text?: string }> },
      ) => Promise<void>
    }

    // Set a custom fallback chain that routes through google
    setSessionFallbackChain(sessionID, [
      { providers: ["google"], model: "gemini-3.1-pro-preview" },
    ])

    const set = setPendingModelFallback(
      sessionID,
      "Oracle",
      "google",
      "gemini-3.1-pro-preview",
    )
    expect(set).toBe(true)

    const output = {
      message: {
        model: { providerID: "google", modelID: "gemini-3.1-pro-preview" },
      },
      parts: [{ type: "text", text: "continue" }],
    }

    //#when
    await hook["chat.message"]?.({ sessionID }, output)

    //#then: model name should remain gemini-3.1-pro-preview because no google transform exists for this ID
    expect(output.message["model"]).toEqual({
      providerID: "google",
      modelID: "gemini-3.1-pro-preview",
    })

    clearPendingModelFallback(sessionID)
  })
})
