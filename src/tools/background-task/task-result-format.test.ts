/// <reference types="bun-types" />

import { describe, test, expect, beforeEach } from "bun:test"
import { formatTaskResult } from "./task-result-format"
import type { BackgroundTask } from "../../features/background-agent"
import type { BackgroundOutputClient, BackgroundOutputMessage } from "./clients"
import { resetMessageCursor } from "../../shared/session-cursor"

function createTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: "task-1",
    sessionID: "ses-1",
    parentSessionID: "main-1",
    parentMessageID: "msg-1",
    description: "test task",
    prompt: "do work",
    agent: "test-agent",
    status: "completed",
    startedAt: new Date("2026-04-26T10:00:00Z"),
    completedAt: new Date("2026-04-26T10:00:05Z"),
    ...overrides,
  }
}

function createClient(messages: BackgroundOutputMessage[]): BackgroundOutputClient {
  return {
    session: {
      messages: async () => ({ data: messages }),
    },
  }
}

describe("formatTaskResult", () => {
  beforeEach(() => {
    resetMessageCursor()
  })

  test("extracts only assistant text, not tool results", async () => {
    const task = createTask({ sessionID: "ses-no-tool" })
    const messages: BackgroundOutputMessage[] = [
      {
        info: { role: "tool", time: { created: 1 } },
        parts: [{ type: "tool_result", content: "<system-reminder>internal tag</system-reminder>" }],
      },
      {
        info: { role: "assistant", time: { created: 2 } },
        parts: [{ type: "text", text: "Here is the summary." }],
      },
    ]

    const result = await formatTaskResult(task, createClient(messages))
    expect(result).toContain("Here is the summary.")
    expect(result).not.toContain("system-reminder")
    expect(result).not.toContain("internal tag")
  })

  test("extracts reasoning parts from assistant messages", async () => {
    const task = createTask({ sessionID: "ses-reasoning" })
    const messages: BackgroundOutputMessage[] = [
      {
        info: { role: "assistant", time: { created: 1 } },
        parts: [
          { type: "reasoning", text: "Thinking step..." },
          { type: "text", text: "Final answer." },
        ],
      },
    ]

    const result = await formatTaskResult(task, createClient(messages))
    expect(result).toContain("Thinking step...")
    expect(result).toContain("Final answer.")
  })

  test("excludes tool role messages entirely", async () => {
    const task = createTask({ sessionID: "ses-tool-excl" })
    const messages: BackgroundOutputMessage[] = [
      {
        info: { role: "tool", time: { created: 1 } },
        parts: [{ type: "text", text: "raw grep output\x1b[31mred text\x1b[0m" }],
      },
      {
        info: { role: "assistant", time: { created: 2 } },
        parts: [{ type: "text", text: "Clean result." }],
      },
    ]

    const result = await formatTaskResult(task, createClient(messages))
    expect(result).toContain("Clean result.")
    expect(result).not.toContain("grep output")
    expect(result).not.toContain("\x1b")
  })

  test("returns no-assistant-response when only tool messages exist", async () => {
    const task = createTask({ sessionID: "ses-tool-only" })
    const messages: BackgroundOutputMessage[] = [
      { info: { role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "prompt" }] },
      { info: { role: "tool", time: { created: 2 } }, parts: [{ type: "tool_result", content: "data" }] },
    ]

    const result = await formatTaskResult(task, createClient(messages))
    expect(result).toContain("(No assistant response found)")
  })

  test("excludes tool_result parts within assistant messages", async () => {
    const task = createTask({ sessionID: "ses-mixed-parts" })
    const messages: BackgroundOutputMessage[] = [
      {
        info: { role: "assistant", time: { created: 1 } },
        parts: [
          { type: "tool_result", content: "should not appear" },
          { type: "text", text: "Only this should appear." },
        ],
      },
    ]

    const result = await formatTaskResult(task, createClient(messages))
    expect(result).toContain("Only this should appear.")
    expect(result).not.toContain("should not appear")
  })

  test("returns no-text-output when assistant has no text parts", async () => {
    const task = createTask({ sessionID: "ses-empty-text" })
    const messages: BackgroundOutputMessage[] = [
      {
        info: { role: "assistant", time: { created: 1 } },
        parts: [{ type: "tool_use", text: "calling tool" }],
      },
    ]

    const result = await formatTaskResult(task, createClient(messages))
    expect(result).toContain("(No output)")
  })

  test("includes task metadata in output header", async () => {
    const task = createTask({ id: "task-42", description: "my task", sessionID: "ses-meta" })
    const messages: BackgroundOutputMessage[] = [
      { info: { role: "assistant", time: { created: 1 } }, parts: [{ type: "text", text: "done" }] },
    ]

    const result = await formatTaskResult(task, createClient(messages))
    expect(result).toContain("<task_metadata>")
    expect(result).toContain("session_id: ses-meta")
    expect(result).toContain("task_id: task-42")
    expect(result).toContain("done")
  })
})
