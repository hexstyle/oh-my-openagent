import { describe, expect, test } from "bun:test"

import {
  assertSmokeSucceededOrSkippable,
  isSkippableProviderQuotaSmokeFailure,
} from "./verify-local-opencode-install"

describe("verify-local-opencode-install smoke handling", () => {
  test("treats provider quota exhaustion as skippable for install verification", () => {
    expect(
      isSkippableProviderQuotaSmokeFailure(
        "AI_APICallError: You're out of extra usage. Add more at claude.ai/settings/usage and keep going.",
      ),
    ).toBe(true)
    expect(
      isSkippableProviderQuotaSmokeFailure(
        "The usage limit has been reached. Please upgrade to continue.",
      ),
    ).toBe(true)
  })

  test("still fails smoke validation for non-quota failures", () => {
    expect(() =>
      assertSmokeSucceededOrSkippable({
        providerLabel: "Anthropic",
        result: {
          exitCode: 1,
          output: "Unexpected error, check log file at /tmp/log",
        },
      }),
    ).toThrow("Anthropic smoke test did not return OK")
  })

  test("accepts successful smoke output", () => {
    expect(() =>
      assertSmokeSucceededOrSkippable({
        providerLabel: "OpenAI",
        result: {
          exitCode: 0,
          output: "OK",
        },
      }),
    ).not.toThrow()
  })
})
