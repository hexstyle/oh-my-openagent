declare const require: (name: string) => any
const { describe, expect, test, beforeEach, mock } = require("bun:test")

const readConnectedProvidersCacheMock = mock(() => null)

mock.module("./connected-providers-cache", () => ({
  readConnectedProvidersCache: readConnectedProvidersCacheMock,
}))

import { shouldRetryError, shouldSwitchFallback, selectFallbackProvider } from "./model-error-classifier"

describe("model-error-classifier", () => {
  beforeEach(() => {
    readConnectedProvidersCacheMock.mockReturnValue(null)
    readConnectedProvidersCacheMock.mockClear()
  })

  test("treats overloaded retry messages as retryable", () => {
    //#given
    const error = { message: "Provider is overloaded" }

    //#when
    const result = shouldRetryError(error)

    //#then
    expect(result).toBe(true)
  })

  test("treats certificate errors as retryable", () => {
    //#given
    const error = { message: "tls: unable to verify the first certificate" }

    //#when
    const result = shouldRetryError(error)

    //#then
    expect(result).toBe(true)
  })

  test("treats cooling-down auto-retry messages as retryable", () => {
    //#given
    const error = {
      message:
        "All credentials for model claude-opus-4-6-thinking are cooling down [retrying in ~5 days attempt #1]",
    }

    //#when
    const result = shouldRetryError(error)

    //#then
    expect(result).toBe(true)
  })

  test("selectFallbackProvider prefers first connected provider in preference order", () => {
    //#given
    readConnectedProvidersCacheMock.mockReturnValue(["anthropic", "nvidia"])

    //#when
    const provider = selectFallbackProvider(["anthropic", "nvidia"], "nvidia")

    //#then
    expect(provider).toBe("anthropic")
  })

  test("selectFallbackProvider falls back to next connected provider when first is disconnected", () => {
    //#given
    readConnectedProvidersCacheMock.mockReturnValue(["nvidia"])

    //#when
    const provider = selectFallbackProvider(["anthropic", "nvidia"])

    //#then
    expect(provider).toBe("nvidia")
  })

  test("selectFallbackProvider uses provider preference order when cache is missing", () => {
    //#given - no cache file

    //#when
    const provider = selectFallbackProvider(["anthropic", "nvidia"], "nvidia")

    //#then
    expect(provider).toBe("anthropic")
  })

  test("selectFallbackProvider uses connected preferred provider when fallback providers are unavailable", () => {
    //#given
    readConnectedProvidersCacheMock.mockReturnValue(["provider-x"])

    //#when
    const provider = selectFallbackProvider(["provider-y"], "provider-x")

    //#then
    expect(provider).toBe("provider-x")
  })

  test("treats FreeUsageLimitError (PascalCase name) as fallback-switchable by name", () => {
    //#given
    const error = { name: "FreeUsageLimitError" }

    //#when
    const result = shouldSwitchFallback(error)

    //#then
    expect(result).toBe(true)
  })

  test("treats freeusagelimiterror (lowercase name) as fallback-switchable by name", () => {
    //#given
    const error = { name: "freeusagelimiterror" }

    //#when
    const result = shouldSwitchFallback(error)

    //#then
    expect(result).toBe(true)
  })

  test("treats free period messages as fallback-switchable, not retryable", () => {
    //#given
    const error = { message: "Your free period has ended. Please wait until tomorrow to continue." }

    //#when
    const retry = shouldRetryError(error)
    const fallback = shouldSwitchFallback(error)

    //#then
    expect(retry).toBe(false)
    expect(fallback).toBe(true)
  })

  test("treats 'bad request' message as retryable (GitHub Copilot rolling update)", () => {
    //#given
    const error = { message: "400 Bad Request" }

    //#when
    const result = shouldRetryError(error)

    //#then
    expect(result).toBe(true)
  })

  test("treats 'bad request' lowercase as retryable", () => {
    //#given
    const error = { message: "bad request: model temporarily unavailable" }

    //#when
    const result = shouldRetryError(error)

    //#then
    expect(result).toBe(true)
  })

  test("treats 403 forbidden/request-not-allowed messages as retryable", () => {
    expect(shouldRetryError({ message: "403 Forbidden" })).toBe(true)
    expect(shouldRetryError({ message: "403 Request not allowed" })).toBe(true)
    expect(shouldSwitchFallback({ message: "403 Forbidden" })).toBe(false)
  })

  test("treats remote compact unexpected status 403 Forbidden as retryable", () => {
    expect(
      shouldRetryError({ message: "Error running remote compact task: unexpected status 403 Forbidden" }),
    ).toBe(true)
    expect(
      shouldSwitchFallback({ message: "Error running remote compact task: unexpected status 403 Forbidden" }),
    ).toBe(false)
  })
})
