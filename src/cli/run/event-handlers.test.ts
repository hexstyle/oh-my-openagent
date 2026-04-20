const { describe, it, expect, spyOn } = require("bun:test")
import type { RunContext } from "./types"
import { createEventState } from "./events"
import {
  handleSessionError,
  handleSessionStatus,
  handleMessagePartUpdated,
  handleMessageUpdated,
  handleToolExecute,
  handleTuiToast,
} from "./event-handlers"

const createMockContext = (sessionID: string = "test-session"): RunContext => ({
  sessionID,
} as RunContext)

describe("handleSessionStatus", () => {
  it("recognizes idle from session.status event (not just deprecated session.idle)", () => {
    //#given - state with mainSessionIdle=false
    const ctx = createMockContext("test-session")
    const state = createEventState()
    state.mainSessionIdle = false

    const payload = {
      type: "session.status",
      properties: {
        sessionID: "test-session",
        status: { type: "idle" as const },
      },
    }

    //#when - handleSessionStatus called with idle status
    handleSessionStatus(ctx, payload as any, state)

    //#then - state.mainSessionIdle === true
    expect(state.mainSessionIdle).toBe(true)
  })

  it("handleSessionStatus sets idle=false on busy", () => {
    //#given - state with mainSessionIdle=true
    const ctx = createMockContext("test-session")
    const state = createEventState()
    state.mainSessionIdle = true

    const payload = {
      type: "session.status",
      properties: {
        sessionID: "test-session",
        status: { type: "busy" as const },
      },
    }

    //#when - handleSessionStatus called with busy status
    handleSessionStatus(ctx, payload as any, state)

    //#then - state.mainSessionIdle === false
    expect(state.mainSessionIdle).toBe(false)
  })

  it("does nothing for different session ID", () => {
    //#given - state with mainSessionIdle=true
    const ctx = createMockContext("test-session")
    const state = createEventState()
    state.mainSessionIdle = true

    const payload = {
      type: "session.status",
      properties: {
        sessionID: "other-session",
        status: { type: "idle" as const },
      },
    }

    //#when - handleSessionStatus called with different session ID
    handleSessionStatus(ctx, payload as any, state)

    //#then - state.mainSessionIdle remains unchanged
    expect(state.mainSessionIdle).toBe(true)
  })

  it("recognizes idle from camelCase sessionId", () => {
    //#given - state with mainSessionIdle=false and payload using sessionId
    const ctx = createMockContext("test-session")
    const state = createEventState()
    state.mainSessionIdle = false

    const payload = {
      type: "session.status",
      properties: {
        sessionId: "test-session",
        status: { type: "idle" as const },
      },
    }

    //#when - handleSessionStatus called with camelCase sessionId
    handleSessionStatus(ctx, payload as any, state)

    //#then - state.mainSessionIdle === true
    expect(state.mainSessionIdle).toBe(true)
  })
})

describe("handleSessionError", () => {
  it("increments error sequence for repeated main-session errors", () => {
    //#given
    const ctx = createMockContext("test-session")
    const state = createEventState()
    const errorSpy = spyOn(console, "error").mockImplementation(() => {})
    const payload = {
      type: "session.error",
      properties: {
        sessionID: "test-session",
        error: { message: "Request not allowed" },
      },
    }

    //#when
    handleSessionError(ctx, payload as any, state)
    handleSessionError(ctx, payload as any, state)

    //#then
    expect(state.mainSessionError).toBe(true)
    expect(state.lastError).toContain("Request not allowed")
    expect(state.errorSequence).toBe(2)
    expect(typeof state.lastErrorTimestamp).toBe("number")
    errorSpy.mockRestore()
  })
})

describe("handleMessagePartUpdated", () => {
  it("clears a transient main-session error when assistant output resumes", () => {
    //#given - transient session.error already fired, then assistant output resumes without busy status
    const ctx = createMockContext("ses_main")
    const state = createEventState()
    state.mainSessionError = true
    state.lastError = "unknown certificate verification error"
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true)

    const payload = {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_1",
          sessionID: "ses_main",
          messageID: "msg_1",
          type: "text",
          text: "Recovered output",
        },
      },
    }

    //#when
    handleMessagePartUpdated(ctx, payload as any, state)

    //#then
    expect(state.mainSessionError).toBe(false)
    expect(state.hasReceivedMeaningfulWork).toBe(true)
    stdoutSpy.mockRestore()
  })

  it("extracts sessionID from part (current OpenCode event structure)", () => {
    //#given - message.part.updated with sessionID in part, not info
    const ctx = createMockContext("ses_main")
    const state = createEventState()
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true)

    const payload = {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_1",
          sessionID: "ses_main",
          messageID: "msg_1",
          type: "text",
          text: "Hello world",
        },
      },
    }

    //#when
    handleMessagePartUpdated(ctx, payload as any, state)

    //#then
    expect(state.hasReceivedMeaningfulWork).toBe(true)
    expect(state.lastPartText).toBe("Hello world")
    expect(stdoutSpy).toHaveBeenCalled()
    stdoutSpy.mockRestore()
  })

  it("skips events for different session", () => {
    //#given - message.part.updated with different session
    const ctx = createMockContext("ses_main")
    const state = createEventState()

    const payload = {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_1",
          sessionID: "ses_other",
          messageID: "msg_1",
          type: "text",
          text: "Hello world",
        },
      },
    }

    //#when
    handleMessagePartUpdated(ctx, payload as any, state)

    //#then
    expect(state.hasReceivedMeaningfulWork).toBe(false)
    expect(state.lastPartText).toBe("")
  })

  it("handles tool part with running status", () => {
    //#given - tool part in running state
    const ctx = createMockContext("ses_main")
    const state = createEventState()
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true)

    const payload = {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_1",
          sessionID: "ses_main",
          messageID: "msg_1",
          type: "tool",
          tool: "read",
          state: { status: "running", input: { filePath: "/src/index.ts" } },
        },
      },
    }

    //#when
    handleMessagePartUpdated(ctx, payload as any, state)

    //#then
    expect(state.currentTool).toBe("read")
    expect(state.hasReceivedMeaningfulWork).toBe(true)
    stdoutSpy.mockRestore()
  })

  it("clears currentTool when tool completes", () => {
    //#given - tool part in completed state
    const ctx = createMockContext("ses_main")
    const state = createEventState()
    state.currentTool = "read"
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true)

    const payload = {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_1",
          sessionID: "ses_main",
          messageID: "msg_1",
          type: "tool",
          tool: "read",
          state: { status: "completed", input: {}, output: "file contents here" },
        },
      },
    }

    //#when
    handleMessagePartUpdated(ctx, payload as any, state)

    //#then
    expect(state.currentTool).toBeNull()
    stdoutSpy.mockRestore()
  })

  it("supports legacy info.sessionID for backward compatibility", () => {
    //#given - legacy event with sessionID in info
    const ctx = createMockContext("ses_legacy")
    const state = createEventState()
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true)

    const payload = {
      type: "message.part.updated",
      properties: {
        info: { sessionID: "ses_legacy", role: "assistant" },
        part: {
          type: "text",
          text: "Legacy text",
        },
      },
    }

    //#when
    handleMessagePartUpdated(ctx, payload as any, state)

    //#then
    expect(state.hasReceivedMeaningfulWork).toBe(true)
    expect(state.lastPartText).toBe("Legacy text")
    stdoutSpy.mockRestore()
  })

  it("does not clear a transient main-session error for patch-only bookkeeping after forbidden", () => {
    //#given - session.error fired and the only follow-up assistant part is a patch side effect
    const ctx = createMockContext("ses_main")
    const state = createEventState()
    state.mainSessionError = true
    state.lastError = "Forbidden: Request not allowed"

    const payload = {
      type: "message.part.updated",
      properties: {
        part: {
          id: "part_patch",
          sessionID: "ses_main",
          messageID: "msg_1",
          type: "patch",
        },
      },
    }

    //#when
    handleMessagePartUpdated(ctx, payload as any, state)

    //#then
    expect(state.mainSessionError).toBe(true)
    expect(state.hasReceivedMeaningfulWork).toBe(false)
  })

  it("prints completion metadata once when assistant text part is completed", () => {
    // given
    const nowSpy = spyOn(Date, "now").mockReturnValue(3400)

    const ctx = createMockContext("ses_main")
    const state = createEventState()
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true)

    handleMessageUpdated(
      ctx,
      {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_1",
            sessionID: "ses_main",
            role: "assistant",
            agent: "Sisyphus",
            modelID: "claude-sonnet-4-6",
          },
        },
      } as any,
      state,
    )
    state.messageStartedAtById["msg_1"] = 1000

    // when
    handleMessagePartUpdated(
      ctx,
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part_1",
            sessionID: "ses_main",
            messageID: "msg_1",
            type: "text",
            text: "done",
            time: { end: 1 },
          },
        },
      } as any,
      state,
    )

    handleMessagePartUpdated(
      ctx,
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part_1",
            sessionID: "ses_main",
            messageID: "msg_1",
            type: "text",
            text: "done",
            time: { end: 2 },
          },
        },
      } as any,
      state,
    )

    // then
    const output = stdoutSpy.mock.calls.map(call => String(call[0])).join("")
    const metaCount = output.split("Sisyphus · claude-sonnet-4-6 · 2.4s").length - 1
    expect(metaCount).toBe(1)
    expect(state.completionMetaPrintedByMessageId["msg_1"]).toBe(true)

    stdoutSpy.mockRestore()
    nowSpy.mockRestore()
  })
})

describe("handleMessageUpdated", () => {
  it("does not clear a transient main-session error for assistant bookkeeping updates without visible output", () => {
    //#given - session.error fired and the assistant message metadata refreshes, but no real recovery output arrived yet
    const ctx = createMockContext("ses_main")
    const state = createEventState()
    state.mainSessionError = true
    state.lastError = "Forbidden: Request not allowed"

    const payload = {
      type: "message.updated",
      properties: {
        info: {
          id: "msg_1",
          sessionID: "ses_main",
          role: "assistant",
          agent: "Prometheus (Plan Builder)",
          modelID: "claude-opus-4-6",
        },
      },
    }

    //#when
    handleMessageUpdated(ctx, payload as any, state)

    //#then
    expect(state.mainSessionError).toBe(true)
    expect(state.currentMessageId).toBe("msg_1")
    expect(state.currentAgent).toBe("Prometheus (Plan Builder)")
  })
})

describe("handleToolExecute", () => {
  it("clears a transient main-session error when tool execution resumes", () => {
    //#given - session.error fired but the same session resumed with a real tool execution
    const ctx = createMockContext("ses_main")
    const state = createEventState()
    state.mainSessionError = true
    state.lastError = "Forbidden: Request not allowed"
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(() => true)

    const payload = {
      type: "tool.execute",
      properties: {
        sessionID: "ses_main",
        name: "read",
        input: { filePath: "/tmp/foo.ts" },
      },
    }

    //#when
    handleToolExecute(ctx, payload as any, state)

    //#then
    expect(state.mainSessionError).toBe(false)
    expect(state.currentTool).toBe("read")
    stdoutSpy.mockRestore()
  })
})

describe("handleTuiToast", () => {
  it("marks main session as error when toast variant is error", () => {
    //#given - toast error payload
    const ctx = createMockContext("test-session")
    const state = createEventState()

    const payload = {
      type: "tui.toast.show",
      properties: {
        title: "Auth",
        message: "Invalid API key",
        variant: "error" as const,
      },
    }

    //#when
    handleTuiToast(ctx, payload as any, state)

    //#then
    expect(state.mainSessionError).toBe(true)
    expect(state.lastError).toBe("Auth: Invalid API key")
  })

  it("does not mark session error for warning toast", () => {
    //#given - toast warning payload
    const ctx = createMockContext("test-session")
    const state = createEventState()

    const payload = {
      type: "tui.toast.show",
      properties: {
        message: "Retrying provider",
        variant: "warning" as const,
      },
    }

    //#when
    handleTuiToast(ctx, payload as any, state)

    //#then
    expect(state.mainSessionError).toBe(false)
    expect(state.lastError).toBe(null)
  })
})
