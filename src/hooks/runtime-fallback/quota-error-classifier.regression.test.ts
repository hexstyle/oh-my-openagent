import { describe, expect, test } from "bun:test"

import { classifyErrorType, isRetryableError } from "./error-classifier"

describe("runtime-fallback quota error regressions", () => {
  test("classifies subscription quota errors as quota_exceeded and triggers fallback", () => {
    //#given
    const error = {
      name: "AI_APICallError",
      message: "Subscription quota exceeded. You can continue using free models.",
    }

    //#when
    const errorType = classifyErrorType(error)
    const retryable = isRetryableError(error, [429, 500, 502, 503, 504])

    //#then
    expect(errorType).toBe("quota_exceeded")
    // Quota errors are retryable to trigger cross-provider fallback
    // (e.g., Anthropic quota exhausted → try OpenAI)
    expect(retryable).toBe(true)
  })

  test("treats HTTP 402 payment required as retryable for fallback", () => {
    //#given
    const error = { statusCode: 402, message: "Payment Required" }

    //#when
    const retryable = isRetryableError(error, [429, 500, 502, 503, 504])

    //#then
    // 402 triggers quota_exceeded classification → retryable for fallback chain
    expect(retryable).toBe(true)
  })

  test("keeps HTTP 429 rate limit retryable", () => {
    //#given
    const error = { statusCode: 429, message: "Too Many Requests: rate limit reached" }

    //#when
    const retryable = isRetryableError(error, [429, 500, 502, 503, 504])

    //#then
    expect(retryable).toBe(true)
  })

  test("classifies quota error names as quota_exceeded and triggers fallback", () => {
    //#given
    const error = { name: "QuotaExceededError", message: "Request failed." }

    //#when
    const errorType = classifyErrorType(error)
    const retryable = isRetryableError(error, [429, 500, 502, 503, 504])

    //#then
    expect(errorType).toBe("quota_exceeded")
    // QuotaExceededError triggers fallback to try a different provider
    expect(retryable).toBe(true)
  })
})
