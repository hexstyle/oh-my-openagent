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
    messagesBySession = {},
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
    const ctx = createMockContext()
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
    })
    const { checkCompletionConditions } = await import("./completion")

    // when
    const result = await checkCompletionConditions(ctx)

    // then
    expect(result).toBe(true)
  })
})
