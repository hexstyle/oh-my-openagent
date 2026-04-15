import { describe, expect, test } from "bun:test"

import {
  resolveExternalWatchdogAgent,
  selectExternalWatchdogModel,
} from "./auto-retry"

describe("runtime fallback external watchdog helpers", () => {
  test("uses the next distinct fallback model when the stalled session is still on its primary model", () => {
    expect(
      selectExternalWatchdogModel("anthropic/claude-opus-4-6", [
        "anthropic/claude-opus-4-6",
        "openai/gpt-5.4",
        "openai/gpt-5.3-codex-spark",
      ], {
        originalModel: "anthropic/claude-opus-4-6",
      }),
    ).toBe("openai/gpt-5.4")
  })

  test("skips variant-only aliases of the same stalled primary model", () => {
    expect(
      selectExternalWatchdogModel("anthropic/claude-opus-4-6(max)", [
        "anthropic/claude-opus-4-6",
        "openai/gpt-5.4(xhigh)",
        "openai/gpt-5.3-codex-spark",
      ], {
        originalModel: "anthropic/claude-opus-4-6(max)",
      }),
    ).toBe("openai/gpt-5.4(xhigh)")
  })

  test("reuses the current fallback model instead of preemptively downgrading again", () => {
    expect(
      selectExternalWatchdogModel("openai/gpt-5.4(xhigh)", [
        "openai/gpt-5.4(xhigh)",
        "openai/gpt-5.3-codex-spark",
        "opencode/nemotron-3-super-free",
      ]),
    ).toBe("openai/gpt-5.4(xhigh)")
  })

  test("falls back to the first configured model only when the current model is missing", () => {
    expect(
      selectExternalWatchdogModel("", [
        "openai/gpt-5.4(xhigh)",
        "openai/gpt-5.3-codex-spark",
      ]),
    ).toBe("openai/gpt-5.4(xhigh)")
  })

  test("uses the runtime-safe explore key for internal cli retries", () => {
    expect(resolveExternalWatchdogAgent("Explore (Code Search)")).toBe("explore")
    expect(resolveExternalWatchdogAgent("prometheus")).toBe("Prometheus (Plan Builder)")
  })
})
