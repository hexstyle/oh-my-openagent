import { describe, it, expect, mock, spyOn } from "bun:test"
import type { RunContext, Todo, ChildSession, SessionStatus } from "./types"

const createMockContext = (overrides: {
  todo?: Todo[]
  childrenBySession?: Record<string, ChildSession[]>
  statuses?: Record<string, SessionStatus>
  messagesBySession?: Record<string, unknown[]>
} = {}): RunContext => {
  const {
    todo = [],
    childrenBySession = { "test-session": [] },
    statuses = {},
    messagesBySession = {
      "test-session": [
        { info: { id: "msg-user-root", role: "user" }, parts: [{ type: "text", text: "start-work" }] },
        {
          info: { id: "msg-assistant-root", role: "assistant", finish: "stop" },
          parts: [{ type: "text", text: "All tasks completed." }],
        },
      ],
    },
  } = overrides

  return {
    client: {
      session: {
        todo: mock(() => Promise.resolve({ data: todo })),
        children: mock((opts: { path: { id: string } }) =>
          Promise.resolve({ data: childrenBySession[opts.path.id] ?? [] })
        ),
        status: mock(() => Promise.resolve({ data: statuses })),
        messages: mock((opts: { path: { id: string } }) =>
          Promise.resolve({ data: messagesBySession[opts.path.id] ?? [] })
        ),
      },
    } as unknown as RunContext["client"],
    sessionID: "test-session",
    directory: "/test",
    abortController: new AbortController(),
  }
}

describe("checkCompletionConditions", () => {
  it("returns true when no todos and no children", async () => {
    // given
    spyOn(console, "log").mockImplementation(() => {})
    const ctx = createMockContext({
      messagesBySession: {
        "test-session": [
          { info: { id: "msg-user", role: "user" }, parts: [{ type: "text", text: "start-work" }] },
          {
            info: { id: "msg-assistant", role: "assistant", finish: "stop" },
            parts: [{ type: "text", text: "All tasks completed." }],
          },
        ],
      },
    })
    const { checkCompletionConditions } = await import("./completion")

    // when
    const result = await checkCompletionConditions(ctx)

    // then
    expect(result).toBe(true)
  })

  it("returns false when incomplete todos exist", async () => {
    // given
    spyOn(console, "log").mockImplementation(() => {})
    const ctx = createMockContext({
      todo: [
        { id: "1", content: "Done", status: "completed", priority: "high" },
        { id: "2", content: "WIP", status: "in_progress", priority: "high" },
      ],
    })
    const { checkCompletionConditions } = await import("./completion")

    // when
    const result = await checkCompletionConditions(ctx)

    // then
    expect(result).toBe(false)
  })

  it("returns true when all todos completed or cancelled", async () => {
    // given
    spyOn(console, "log").mockImplementation(() => {})
    const ctx = createMockContext({
      todo: [
        { id: "1", content: "Done", status: "completed", priority: "high" },
        { id: "2", content: "Skip", status: "cancelled", priority: "medium" },
      ],
      messagesBySession: {
        "test-session": [
          { info: { id: "msg-user", role: "user" }, parts: [{ type: "text", text: "start-work" }] },
          {
            info: { id: "msg-assistant", role: "assistant", finish: "stop" },
            parts: [{ type: "text", text: "All tasks completed." }],
          },
        ],
      },
    })
    const { checkCompletionConditions } = await import("./completion")

    // when
    const result = await checkCompletionConditions(ctx)

    // then
    expect(result).toBe(true)
  })

  it("returns false when child session is busy", async () => {
    // given
    spyOn(console, "log").mockImplementation(() => {})
    const ctx = createMockContext({
      childrenBySession: {
        "test-session": [{ id: "child-1" }],
        "child-1": [],
      },
      statuses: { "child-1": { type: "busy" } },
    })
    const { checkCompletionConditions } = await import("./completion")

    // when
    const result = await checkCompletionConditions(ctx)

    // then
    expect(result).toBe(false)
  })

  it("returns true when all children idle", async () => {
    // given
    spyOn(console, "log").mockImplementation(() => {})
    const ctx = createMockContext({
      childrenBySession: {
        "test-session": [{ id: "child-1" }, { id: "child-2" }],
        "child-1": [],
        "child-2": [],
      },
      statuses: {
        "child-1": { type: "idle" },
        "child-2": { type: "idle" },
      },
      messagesBySession: {
        "test-session": [
          { info: { id: "msg-user", role: "user" }, parts: [{ type: "text", text: "start-work" }] },
          {
            info: { id: "msg-assistant", role: "assistant", finish: "stop" },
            parts: [{ type: "text", text: "All tasks completed." }],
          },
        ],
      },
    })
    const { checkCompletionConditions } = await import("./completion")

    // when
    const result = await checkCompletionConditions(ctx)

    // then
    expect(result).toBe(true)
  })

  it("returns false when grandchild is busy (recursive)", async () => {
    // given
    spyOn(console, "log").mockImplementation(() => {})
    const ctx = createMockContext({
      childrenBySession: {
        "test-session": [{ id: "child-1" }],
        "child-1": [{ id: "grandchild-1" }],
        "grandchild-1": [],
      },
      statuses: {
        "child-1": { type: "idle" },
        "grandchild-1": { type: "busy" },
      },
    })
    const { checkCompletionConditions } = await import("./completion")

    // when
    const result = await checkCompletionConditions(ctx)

    // then
    expect(result).toBe(false)
  })

  it("returns false when child status is missing and the child transcript is not settled", async () => {
    // given
    spyOn(console, "log").mockImplementation(() => {})
    const ctx = createMockContext({
      childrenBySession: {
        "test-session": [{ id: "child-1" }],
        "child-1": [],
      },
      statuses: {},
      messagesBySession: {
        "child-1": [
          { info: { id: "msg-user", role: "user" }, parts: [{ type: "text", text: "inspect plans" }] },
        ],
      },
    })
    const { checkCompletionConditions } = await import("./completion")

    // when
    const result = await checkCompletionConditions(ctx)

    // then
    expect(result).toBe(false)
  })

  it("returns true when child session is interrupted", async () => {
    // given
    spyOn(console, "log").mockImplementation(() => {})
    const ctx = createMockContext({
      childrenBySession: {
        "test-session": [{ id: "child-1" }],
        "child-1": [],
      },
      statuses: { "child-1": { type: "interrupted" } },
      messagesBySession: {
        "test-session": [
          { info: { id: "msg-user", role: "user" }, parts: [{ type: "text", text: "start-work" }] },
          {
            info: { id: "msg-assistant", role: "assistant", finish: "stop" },
            parts: [{ type: "text", text: "All tasks completed." }],
          },
        ],
      },
    })
    const { checkCompletionConditions } = await import("./completion")

    // when
    const result = await checkCompletionConditions(ctx)

    // then
    expect(result).toBe(true)
  })

  it("returns true when child session has unknown non-active status", async () => {
    // given
    spyOn(console, "log").mockImplementation(() => {})
    const ctx = createMockContext({
      childrenBySession: {
        "test-session": [{ id: "child-1" }],
        "child-1": [],
      },
      statuses: { "child-1": { type: "mystery" } },
      messagesBySession: {
        "test-session": [
          { info: { id: "msg-user", role: "user" }, parts: [{ type: "text", text: "start-work" }] },
          {
            info: { id: "msg-assistant", role: "assistant", finish: "stop" },
            parts: [{ type: "text", text: "All tasks completed." }],
          },
        ],
      },
    })
    const { checkCompletionConditions } = await import("./completion")

    // when
    const result = await checkCompletionConditions(ctx)

    // then
    expect(result).toBe(true)
  })

  it("returns true when child status is missing but the child has a terminal assistant finish", async () => {
    // given
    spyOn(console, "log").mockImplementation(() => {})
    const ctx = createMockContext({
      childrenBySession: {
        "test-session": [{ id: "child-1" }],
        "child-1": [],
      },
      statuses: {},
      messagesBySession: {
        "test-session": [
          { info: { id: "msg-user-root", role: "user" }, parts: [{ type: "text", text: "start-work" }] },
          {
            info: { id: "msg-assistant-root", role: "assistant", finish: "stop" },
            parts: [{ type: "text", text: "All tasks completed." }],
          },
        ],
        "child-1": [
          { info: { id: "msg-user", role: "user" }, parts: [{ type: "text", text: "inspect plans" }] },
          {
            info: { id: "msg-assistant", role: "assistant", finish: "stop" },
            parts: [{ type: "text", text: "All plans inspected." }],
          },
        ],
      },
    })
    const { checkCompletionConditions } = await import("./completion")

    // when
    const result = await checkCompletionConditions(ctx)

    // then
    expect(result).toBe(true)
  })

  it("returns true when child status is missing but the child already emitted visible assistant content", async () => {
    // given
    spyOn(console, "log").mockImplementation(() => {})
    const ctx = createMockContext({
      childrenBySession: {
        "test-session": [{ id: "child-1" }],
        "child-1": [],
      },
      statuses: {},
      messagesBySession: {
        "test-session": [
          { info: { id: "msg-user-root", role: "user" }, parts: [{ type: "text", text: "start-work" }] },
          {
            info: { id: "msg-assistant-root", role: "assistant", finish: "stop" },
            parts: [{ type: "text", text: "All tasks completed." }],
          },
        ],
        "child-1": [
          { info: { id: "msg-user", role: "user" }, parts: [{ type: "text", text: "inspect plans" }] },
          {
            info: { id: "msg-assistant", role: "assistant" },
            parts: [{ type: "text", text: "I found one incomplete plan." }],
          },
        ],
      },
    })
    const { checkCompletionConditions } = await import("./completion")

    // when
    const result = await checkCompletionConditions(ctx)

    // then
    expect(result).toBe(true)
  })

  it("returns false when child status is missing but the latest assistant message still has an open step", async () => {
    // given
    spyOn(console, "log").mockImplementation(() => {})
    const ctx = createMockContext({
      childrenBySession: {
        "test-session": [{ id: "child-1" }],
        "child-1": [],
      },
      statuses: {},
      messagesBySession: {
        "test-session": [
          { info: { id: "msg-user-root", role: "user" }, parts: [{ type: "text", text: "start-work" }] },
          {
            info: { id: "msg-assistant-root", role: "assistant", finish: "stop" },
            parts: [{ type: "text", text: "All tasks completed." }],
          },
        ],
        "child-1": [
          { info: { id: "msg-user", role: "user" }, parts: [{ type: "text", text: "inspect plans" }] },
          {
            info: { id: "msg-assistant", role: "assistant" },
            parts: [
              { type: "text", text: "I found one incomplete plan." },
              { type: "step-start" },
            ],
          },
        ],
      },
    })
    const { checkCompletionConditions } = await import("./completion")

    // when
    const result = await checkCompletionConditions(ctx)

    // then
    expect(result).toBe(false)
  })

  it("returns false when child status is idle but the latest assistant message still has an open step", async () => {
    // given
    spyOn(console, "log").mockImplementation(() => {})
    const ctx = createMockContext({
      childrenBySession: {
        "test-session": [{ id: "child-1" }],
        "child-1": [],
      },
      statuses: {
        "child-1": { type: "idle" },
      },
      messagesBySession: {
        "test-session": [
          { info: { id: "msg-user-root", role: "user" }, parts: [{ type: "text", text: "start-work" }] },
          {
            info: { id: "msg-assistant-root", role: "assistant", finish: "stop" },
            parts: [{ type: "text", text: "All tasks completed." }],
          },
        ],
        "child-1": [
          { info: { id: "msg-user", role: "user" }, parts: [{ type: "text", text: "inspect plans" }] },
          {
            info: { id: "msg-assistant", role: "assistant" },
            parts: [
              { type: "reasoning", text: "Checking evidence completeness" },
              { type: "step-start" },
            ],
          },
        ],
      },
    })
    const { checkCompletionConditions } = await import("./completion")

    // when
    const result = await checkCompletionConditions(ctx)

    // then
    expect(result).toBe(false)
  })

  it("returns true when child status is idle and the latest assistant content is a stale settled tail", async () => {
    // given
    spyOn(console, "log").mockImplementation(() => {})
    const ctx = createMockContext({
      childrenBySession: {
        "test-session": [{ id: "child-1" }],
        "child-1": [],
      },
      statuses: {
        "child-1": { type: "idle" },
      },
      messagesBySession: {
        "test-session": [
          { info: { id: "msg-user-root", role: "user" }, parts: [{ type: "text", text: "start-work" }] },
          {
            info: { id: "msg-assistant-root", role: "assistant", finish: "stop" },
            parts: [{ type: "text", text: "All tasks completed." }],
          },
        ],
        "child-1": [
          { info: { id: "msg-user", role: "user" }, parts: [{ type: "text", text: "inspect plans" }] },
          {
            info: { id: "msg-assistant", role: "assistant" },
            parts: [{ type: "text", text: "All plans inspected." }],
          },
        ],
      },
    })
    const { checkCompletionConditions } = await import("./completion")

    // when
    const result = await checkCompletionConditions(ctx)

    // then
    expect(result).toBe(true)
  })

  it("returns false when descendant is busy even if parent status is missing", async () => {
    // given
    spyOn(console, "log").mockImplementation(() => {})
    const ctx = createMockContext({
      childrenBySession: {
        "test-session": [{ id: "child-1" }],
        "child-1": [{ id: "grandchild-1" }],
        "grandchild-1": [],
      },
      statuses: {
        "grandchild-1": { type: "busy" },
      },
      messagesBySession: {
        "test-session": [
          { info: { id: "msg-user-root", role: "user" }, parts: [{ type: "text", text: "start-work" }] },
          {
            info: { id: "msg-assistant-root", role: "assistant", finish: "stop" },
            parts: [{ type: "text", text: "All tasks completed." }],
          },
        ],
      },
    })
    const { checkCompletionConditions } = await import("./completion")

    // when
    const result = await checkCompletionConditions(ctx)

    // then
    expect(result).toBe(false)
  })

  it("returns true when all descendants idle (recursive)", async () => {
    // given
    spyOn(console, "log").mockImplementation(() => {})
    const ctx = createMockContext({
      childrenBySession: {
        "test-session": [{ id: "child-1" }],
        "child-1": [{ id: "grandchild-1" }],
        "grandchild-1": [{ id: "great-grandchild-1" }],
        "great-grandchild-1": [],
      },
      statuses: {
        "child-1": { type: "idle" },
        "grandchild-1": { type: "idle" },
        "great-grandchild-1": { type: "idle" },
      },
      messagesBySession: {
        "test-session": [
          { info: { id: "msg-user-root", role: "user" }, parts: [{ type: "text", text: "start-work" }] },
          {
            info: { id: "msg-assistant-root", role: "assistant", finish: "stop" },
            parts: [{ type: "text", text: "All tasks completed." }],
          },
        ],
      },
    })
    const { checkCompletionConditions } = await import("./completion")

    // when
    const result = await checkCompletionConditions(ctx)

    // then
    expect(result).toBe(true)
  })

  it("returns false when the root session transcript is not settled", async () => {
    // given
    spyOn(console, "log").mockImplementation(() => {})
    const ctx = createMockContext({
      messagesBySession: {
        "test-session": [
          { info: { id: "msg-user", role: "user" }, parts: [{ type: "text", text: "start-work" }] },
          {
            info: { id: "msg-assistant", role: "assistant" },
            parts: [{ type: "text", text: "Still checking..." }, { type: "step-start" }],
          },
        ],
      },
    })
    const { checkCompletionConditions } = await import("./completion")

    // when
    const result = await checkCompletionConditions(ctx)

    // then
    expect(result).toBe(false)
  })

  it("returns false when the root transcript launched background tasks but all-complete was never emitted", async () => {
    // given
    spyOn(console, "log").mockImplementation(() => {})
    const ctx = createMockContext({
      messagesBySession: {
        "test-session": [
          { info: { id: "msg-user", role: "user" }, parts: [{ type: "text", text: "start-work" }] },
          {
            info: { id: "msg-assistant-tools", role: "assistant", finish: "tool-calls" },
            parts: [
              {
                type: "tool",
                tool: "task",
                state: {
                  status: "completed",
                  output:
                    "Background task launched.\n\nBackground Task ID: bg_plan_1\nDescription: Inspect plans",
                },
              },
            ],
          },
          {
            info: { id: "msg-system", role: "assistant" },
            parts: [
              {
                type: "text",
                text:
                  "<system-reminder>\n[BACKGROUND TASK STATUS]\n**Active background tasks:** 1\n\n- `bg_plan_1`: Inspect plans [RUNNING]\n</system-reminder>",
              },
            ],
          },
          {
            info: { id: "msg-assistant-final", role: "assistant", finish: "stop" },
            parts: [{ type: "text", text: "I'm gathering the remaining evidence in parallel." }],
          },
        ],
      },
    })
    const { checkCompletionConditions } = await import("./completion")

    // when
    const result = await checkCompletionConditions(ctx)

    // then
    expect(result).toBe(false)
  })

  it("returns true when background tasks launched earlier were later cleared by all-complete", async () => {
    // given
    spyOn(console, "log").mockImplementation(() => {})
    const ctx = createMockContext({
      messagesBySession: {
        "test-session": [
          { info: { id: "msg-user", role: "user" }, parts: [{ type: "text", text: "start-work" }] },
          {
            info: { id: "msg-assistant-tools", role: "assistant", finish: "tool-calls" },
            parts: [
              {
                type: "tool",
                tool: "task",
                state: {
                  status: "completed",
                  output:
                    "Background task launched.\n\nBackground Task ID: bg_plan_1\nDescription: Inspect plans",
                },
              },
            ],
          },
          {
            info: { id: "msg-system-complete", role: "assistant" },
            parts: [
              {
                type: "text",
                text:
                  "<system-reminder>\n[ALL BACKGROUND TASKS COMPLETE]\n\n**Completed:**\n- `bg_plan_1`: Inspect plans\n</system-reminder>",
              },
            ],
          },
          {
            info: { id: "msg-assistant-final", role: "assistant", finish: "stop" },
            parts: [{ type: "text", text: "All prerequisite inspection finished." }],
          },
        ],
      },
    })
    const { checkCompletionConditions } = await import("./completion")

    // when
    const result = await checkCompletionConditions(ctx)

    // then
    expect(result).toBe(true)
  })
})
