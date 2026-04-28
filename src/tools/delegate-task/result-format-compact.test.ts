/// <reference types="bun-types" />

import { describe, test, expect } from "bun:test"
import {
  formatSyncResult,
  formatBackgroundLaunch,
  formatBackgroundResult,
  formatFailedResult,
  formatTimeoutResult,
} from "./result-format-compact"

describe("compact result format — context efficiency guards", () => {
  describe("formatSyncResult", () => {
    test("textContent appears as the first thing in output (no header preamble)", () => {
      const result = formatSyncResult({
        textContent: "The answer is 42.",
        sessionID: "ses_abc123",
        duration: "3s",
      })
      expect(result.startsWith("The answer is 42.")).toBe(true)
    })

    test("total overhead (non-textContent) is under 80 chars", () => {
      const textContent = "X".repeat(100)
      const result = formatSyncResult({
        textContent,
        sessionID: "ses_abc123def456",
        duration: "12s",
      })
      const overhead = result.length - textContent.length
      expect(overhead).toBeLessThan(80)
    })

    test("contains session_id parseable by existing extractors", () => {
      const result = formatSyncResult({
        textContent: "done",
        sessionID: "ses_my_session_id",
        duration: "1s",
      })
      // Must match: <task_metadata>...session_id: ses_xxx...</task_metadata>
      const match = result.match(/<task_metadata>([\s\S]*?)<\/task_metadata>/)
      expect(match).not.toBeNull()
      expect(match![1]).toContain("session_id: ses_my_session_id")
    })

    test("task_metadata fits on a single line (no multi-line XML)", () => {
      const result = formatSyncResult({
        textContent: "done",
        sessionID: "ses_abc",
        duration: "1s",
      })
      const metaMatch = result.match(/<task_metadata>([\s\S]*?)<\/task_metadata>/)
      expect(metaMatch).not.toBeNull()
      // The content between tags should NOT contain newlines (compact)
      expect(metaMatch![1]).not.toContain("\n")
    })

    test("does NOT contain agent name (caller already knows)", () => {
      const result = formatSyncResult({
        textContent: "done",
        sessionID: "ses_abc",
        duration: "1s",
      })
      expect(result).not.toContain("Agent:")
      expect(result).not.toContain("sisyphus")
    })

    test("does NOT contain category (caller already knows)", () => {
      const result = formatSyncResult({
        textContent: "done",
        sessionID: "ses_abc",
        duration: "1s",
      })
      expect(result).not.toContain("category:")
      expect(result).not.toContain("Category:")
    })

    test("does NOT contain model info (internal detail)", () => {
      const result = formatSyncResult({
        textContent: "done",
        sessionID: "ses_abc",
        duration: "1s",
      })
      expect(result).not.toContain("model:")
      expect(result).not.toContain("anthropic/")
      expect(result).not.toContain("openai/")
    })

    test("does NOT contain verbose header like 'Task completed'", () => {
      const result = formatSyncResult({
        textContent: "done",
        sessionID: "ses_abc",
        duration: "1s",
      })
      expect(result).not.toContain("Task completed")
      expect(result).not.toContain("Task Result")
    })

    test("empty textContent renders placeholder", () => {
      const result = formatSyncResult({
        textContent: "",
        sessionID: "ses_abc",
        duration: "1s",
      })
      expect(result).toContain("(No output)")
    })
  })

  describe("formatBackgroundLaunch", () => {
    test("contains task_id for polling", () => {
      const result = formatBackgroundLaunch({
        taskId: "bg_task_99",
        sessionID: "ses_xyz",
      })
      expect(result).toContain("bg_task_99")
    })

    test("total output is under 200 chars", () => {
      const result = formatBackgroundLaunch({
        taskId: "bg_task_99",
        sessionID: "ses_xyz789012345",
      })
      expect(result.length).toBeLessThan(200)
    })

    test("does NOT contain agent name or verbose header", () => {
      const result = formatBackgroundLaunch({
        taskId: "bg_task_1",
        sessionID: "ses_abc",
      })
      expect(result).not.toContain("Agent:")
      expect(result).not.toContain("Background task launched")
    })

    test("contains instruction for checking status", () => {
      const result = formatBackgroundLaunch({
        taskId: "bg_task_1",
        sessionID: "ses_abc",
      })
      expect(result).toContain("background_output")
    })

    test("contains session_id and background_task_id in metadata", () => {
      const result = formatBackgroundLaunch({
        taskId: "bg_1",
        sessionID: "ses_launch_session",
      })
      expect(result).toContain("ses_launch_session")
      expect(result).toContain("background_task_id: bg_1")
    })

    test("always includes session_id — it is the root activity linkage", () => {
      const result = formatBackgroundLaunch({
        taskId: "bg_1",
        sessionID: "ses_always_present",
      })
      expect(result).toContain("session_id: ses_always_present")
      expect(result).toContain("background_task_id: bg_1")
    })
  })

  describe("formatBackgroundResult", () => {
    test("textContent appears first (no verbose header)", () => {
      const result = formatBackgroundResult({
        textContent: "Research complete.",
        taskId: "bg_42",
        sessionID: "ses_abc",
        duration: "45s",
      })
      expect(result.startsWith("Research complete.")).toBe(true)
    })

    test("total overhead under 100 chars", () => {
      const textContent = "Y".repeat(100)
      const result = formatBackgroundResult({
        textContent,
        taskId: "bg_123",
        sessionID: "ses_longid123456",
        duration: "1m 30s",
      })
      const overhead = result.length - textContent.length
      expect(overhead).toBeLessThan(100)
    })

    test("contains both task_id and session_id in metadata", () => {
      const result = formatBackgroundResult({
        textContent: "done",
        taskId: "bg_42",
        sessionID: "ses_myid",
        duration: "5s",
      })
      const match = result.match(/<task_metadata>([\s\S]*?)<\/task_metadata>/)
      expect(match).not.toBeNull()
      expect(match![1]).toContain("bg_42")
      expect(match![1]).toContain("ses_myid")
    })

    test("does NOT contain 'Task Result' header", () => {
      const result = formatBackgroundResult({
        textContent: "done",
        taskId: "bg_1",
        sessionID: "ses_abc",
        duration: "5s",
      })
      expect(result).not.toContain("Task Result")
      expect(result).not.toContain("Task completed")
    })
  })

  describe("formatFailedResult", () => {
    test("contains error info", () => {
      const result = formatFailedResult({
        status: "error",
        sessionID: "ses_abc",
        duration: "10s",
        error: "Model returned 500",
      })
      expect(result).toContain("error")
      expect(result).toContain("Model returned 500")
    })

    test("contains session_id for debugging", () => {
      const result = formatFailedResult({
        status: "interrupt",
        sessionID: "ses_xyz",
        duration: "5s",
      })
      expect(result).toContain("ses_xyz")
    })

    test("total output under 200 chars without error message", () => {
      const result = formatFailedResult({
        status: "error",
        sessionID: "ses_abc",
        duration: "10s",
      })
      expect(result.length).toBeLessThan(200)
    })

    test("is a single line (no multi-line output)", () => {
      const result = formatFailedResult({
        status: "error",
        sessionID: "ses_abc",
        duration: "10s",
      })
      expect(result.split("\n").length).toBe(1)
    })
  })

  describe("formatTimeoutResult", () => {
    test("indicates timeout", () => {
      const result = formatTimeoutResult({
        sessionID: "ses_abc",
        duration: "5m 0s",
      })
      expect(result).toMatch(/timeout/i)
    })

    test("contains session_id", () => {
      const result = formatTimeoutResult({
        sessionID: "ses_timeout1",
        duration: "5m",
      })
      expect(result).toContain("ses_timeout1")
    })

    test("total output under 100 chars", () => {
      const result = formatTimeoutResult({
        sessionID: "ses_abc",
        duration: "5m 0s",
      })
      expect(result.length).toBeLessThan(100)
    })

    test("is a single line", () => {
      const result = formatTimeoutResult({
        sessionID: "ses_abc",
        duration: "5m 0s",
      })
      expect(result.split("\n").length).toBe(1)
    })
  })
})

describe("compact result format — metadata contract compatibility", () => {
  test("sync result: session_id extractable by <task_metadata> regex", () => {
    const result = formatSyncResult({
      textContent: "done",
      sessionID: "ses_compat_test",
      duration: "1s",
    })
    // Pattern from task-metadata-contract.ts and subagent-session-id.ts
    const blocks = [...result.matchAll(/<task_metadata>([\s\S]*?)<\/task_metadata>/gi)]
    const lastBlock = blocks.at(-1)?.[1]
    expect(lastBlock).toBeDefined()
    const sessionMatch = lastBlock!.match(/session_id:\s*(ses_[a-zA-Z0-9_-]+)/i)
    expect(sessionMatch?.[1]).toBe("ses_compat_test")
  })

  test("background result: session_id and task_id extractable", () => {
    const result = formatBackgroundResult({
      textContent: "done",
      taskId: "bg_compat",
      sessionID: "ses_bg_compat",
      duration: "5s",
    })
    const blocks = [...result.matchAll(/<task_metadata>([\s\S]*?)<\/task_metadata>/gi)]
    const lastBlock = blocks.at(-1)?.[1]
    expect(lastBlock).toBeDefined()
    expect(lastBlock!.match(/session_id:\s*(ses_[a-zA-Z0-9_-]+)/i)?.[1]).toBe("ses_bg_compat")
    expect(lastBlock!.match(/task_id:\s*([^\s<]+)/i)?.[1]).toBe("bg_compat")
  })

  test("background launch: session_id discoverable via inline pattern", () => {
    const result = formatBackgroundLaunch({
      taskId: "bg_launch_test",
      sessionID: "ses_launch_compat",
    })
    // Pattern from updated extractExplicitSessionId: /(?:Session ID|session_id):\s*(ses_[...])/
    const match = result.match(/(?:Session ID|session_id):\s*(ses_[a-zA-Z0-9_-]+)/i)
    expect(match?.[1]).toBe("ses_launch_compat")
  })
})
