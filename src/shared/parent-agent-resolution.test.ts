import { describe, expect, test } from "bun:test"

import { resolveParentAgent } from "./parent-agent-resolution"

describe("resolveParentAgent", () => {
  test("prefers the stored session agent over a stale tool-context agent", () => {
    expect(
      resolveParentAgent({
        sessionAgent: "Sisyphus Junior (Focused Executor)",
        toolAgent: "Prometheus (Plan Builder)",
        firstMessageAgent: "Sisyphus Junior (Focused Executor)",
        previousMessageAgent: "Sisyphus Junior (Focused Executor)",
      }),
    ).toBe("Sisyphus Junior (Focused Executor)")
  })

  test("falls back through tool, first-message, then previous-message agents", () => {
    expect(
      resolveParentAgent({
        toolAgent: "Atlas (Plan Executor)",
        firstMessageAgent: "Prometheus (Plan Builder)",
        previousMessageAgent: "Sisyphus (Ultraworker)",
      }),
    ).toBe("Atlas (Plan Executor)")

    expect(
      resolveParentAgent({
        firstMessageAgent: "Atlas (Plan Executor)",
        previousMessageAgent: "Sisyphus (Ultraworker)",
      }),
    ).toBe("Atlas (Plan Executor)")

    expect(
      resolveParentAgent({
        previousMessageAgent: "Sisyphus (Ultraworker)",
      }),
    ).toBe("Sisyphus (Ultraworker)")
  })
})
