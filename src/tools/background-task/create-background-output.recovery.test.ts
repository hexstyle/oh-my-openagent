/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test"
import type { ToolContext } from "@opencode-ai/plugin/tool"

import { createBackgroundOutput } from "./create-background-output"
import type { BackgroundOutputClient, BackgroundOutputManager, BackgroundOutputMessage } from "./clients"

const toolContext = {
  sessionID: "main-1",
  messageID: "msg-parent",
  agent: "Prometheus (Plan Builder)",
  directory: "/tmp",
  worktree: "/tmp",
  abort: new AbortController().signal,
  metadata: () => {},
  ask: async () => {},
} as unknown as ToolContext

function createClient(messagesBySession: Record<string, BackgroundOutputMessage[]>): BackgroundOutputClient {
  return {
    session: {
      messages: async ({ path }: { path: { id: string } }) => ({
        data: messagesBySession[path.id] ?? [],
      }),
    },
  }
}

describe("createBackgroundOutput restart recovery", () => {
  test("recovers a completed task from parent session history when in-memory manager state is gone", async () => {
    //#given
    const manager: BackgroundOutputManager = {
      getTask: () => undefined,
    }
    const client = createClient({
      "main-1": [
        {
          id: "msg_launch",
          info: { role: "assistant", time: "2026-01-01T00:00:00.000Z" },
          parts: [
            {
              type: "tool_result",
              content: `Background task launched.

Task ID: bg_resume
Description: Write root AGENTS.md
Agent: Prometheus (Plan Builder)

<task_metadata>
session_id: ses_child_1
task_id: bg_resume
background_task_id: bg_resume
subagent: Prometheus (Plan Builder)
</task_metadata>`,
            },
          ],
        },
      ],
      "ses_child_1": [
        {
          id: "msg_child_1",
          info: {
            role: "assistant",
            time: "2026-01-01T00:00:01.000Z",
            agent: "Prometheus (Plan Builder)",
          },
          parts: [
            { type: "text", text: "Recovered child output" },
          ],
        },
      ],
    })
    const tool = createBackgroundOutput(manager, client)

    //#when
    const result = await tool.execute({ task_id: "bg_resume" }, toolContext)

    //#then
    expect(result).toContain("Recovered child output")
    expect(result).toContain("session_id: ses_child_1")
    expect(result).not.toContain("Task not found")
  })
})
