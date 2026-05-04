import { afterEach, beforeEach, describe, it, expect, mock, spyOn } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { RunContext, Todo, ChildSession, SessionStatus } from "./types"
import { createEventState } from "./events"
import { pollForCompletion } from "./poll-for-completion"
import { createTodoContinuationEnforcer } from "../../hooks/todo-continuation-enforcer"

const tempDirs: string[] = []

function createTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "omo-run-poll-"))
  tempDirs.push(directory)
  return directory
}

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

let consoleLogSpy: ReturnType<typeof spyOn>
let consoleErrorSpy: ReturnType<typeof spyOn>

function abortAfter(abortController: AbortController, delayMs: number): void {
  setTimeout(() => abortController.abort(), delayMs)
}

beforeEach(() => {
  consoleLogSpy = spyOn(console, "log").mockImplementation(() => {})
  consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {})
})

afterEach(() => {
  consoleLogSpy.mockRestore()
  consoleErrorSpy.mockRestore()
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop()
    if (directory) {
      rmSync(directory, { recursive: true, force: true })
    }
  }
})

describe("pollForCompletion", () => {
  it("requires consecutive stability checks before exiting - not immediate", async () => {
    //#given - 0 todos, 0 children, session idle, meaningful work done
    const ctx = createMockContext()
    const eventState = createEventState()
    eventState.mainSessionIdle = true
    eventState.hasReceivedMeaningfulWork = true
    const abortController = new AbortController()

    //#when
    const result = await pollForCompletion(ctx, eventState, abortController, {
      pollIntervalMs: 10,
      requiredConsecutive: 3,
      minStabilizationMs: 10,
    })

    //#then - exits with 0 but only after 3 consecutive checks
    expect(result).toBe(0)
    const todoCallCount = (ctx.client.session.todo as ReturnType<typeof mock>).mock.calls.length
    expect(todoCallCount).toBeGreaterThanOrEqual(3)
  })

  it("does not check completion during stabilization period after first meaningful work", async () => {
    //#given - session idle, meaningful work done, but stabilization period not elapsed
    const ctx = createMockContext()
    const eventState = createEventState()
    eventState.mainSessionIdle = true
    eventState.hasReceivedMeaningfulWork = true
    const abortController = new AbortController()

    //#when - abort after 50ms (within the 60ms stabilization period)
    abortAfter(abortController, 50)
    const result = await pollForCompletion(ctx, eventState, abortController, {
      pollIntervalMs: 10,
      requiredConsecutive: 3,
      minStabilizationMs: 60,
    })

    //#then - should be aborted, not completed (stabilization blocked completion check)
    expect(result).toBe(130)
    const todoCallCount = (ctx.client.session.todo as ReturnType<typeof mock>).mock.calls.length
    expect(todoCallCount).toBe(0)
  })

  it("does not exit when currentTool is set - resets consecutive counter", async () => {
    //#given
    const ctx = createMockContext()
    const eventState = createEventState()
    eventState.mainSessionIdle = true
    eventState.hasReceivedMeaningfulWork = true
    eventState.currentTool = "task"
    const abortController = new AbortController()

    //#when - abort after enough time to verify it didn't exit
    abortAfter(abortController, 100)
    const result = await pollForCompletion(ctx, eventState, abortController, {
      pollIntervalMs: 10,
      requiredConsecutive: 3,
      minStabilizationMs: 500,
    })

    //#then - should be aborted, not completed (tool blocked exit)
    expect(result).toBe(130)
    const todoCallCount = (ctx.client.session.todo as ReturnType<typeof mock>).mock.calls.length
    expect(todoCallCount).toBe(0)
  })

  it("does not exit while a child session has no status entry and no settled transcript", async () => {
    //#given - root is idle, but an active child exists with missing status and no terminal transcript
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
    const eventState = createEventState()
    eventState.mainSessionIdle = true
    eventState.hasReceivedMeaningfulWork = true
    const abortController = new AbortController()

    //#when - abort after enough time to prove the poller didn't terminate early
    abortAfter(abortController, 80)
    const result = await pollForCompletion(ctx, eventState, abortController, {
      pollIntervalMs: 10,
      requiredConsecutive: 1,
      minStabilizationMs: 10,
    })

    //#then - run should remain active because the child is still unresolved
    expect(result).toBe(130)
  })

  it("does not exit while a child session reports idle but its latest assistant message still has an open step", async () => {
    //#given - child status flickered to idle, but transcript shows execution still in progress
    const ctx = createMockContext({
      childrenBySession: {
        "test-session": [{ id: "child-1" }],
        "child-1": [],
      },
      statuses: {
        "child-1": { type: "idle" },
      },
      messagesBySession: {
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
    const eventState = createEventState()
    eventState.mainSessionIdle = true
    eventState.hasReceivedMeaningfulWork = true
    const abortController = new AbortController()

    //#when
    abortAfter(abortController, 80)
    const result = await pollForCompletion(ctx, eventState, abortController, {
      pollIntervalMs: 10,
      requiredConsecutive: 1,
      minStabilizationMs: 10,
    })

    //#then
    expect(result).toBe(130)
  })

  it("does not exit while the root session transcript is still unfinished", async () => {
    //#given - root session looks idle, but latest assistant message still has an open step
    const ctx = createMockContext({
      messagesBySession: {
        "test-session": [
          { info: { id: "msg-user", role: "user" }, parts: [{ type: "text", text: "start-work" }] },
          {
            info: { id: "msg-assistant", role: "assistant" },
            parts: [
              { type: "text", text: "Waiting on the remaining evidence check." },
              { type: "step-start" },
            ],
          },
        ],
      },
    })
    const eventState = createEventState()
    eventState.mainSessionIdle = true
    eventState.hasReceivedMeaningfulWork = true
    const abortController = new AbortController()

    //#when
    abortAfter(abortController, 80)
    const result = await pollForCompletion(ctx, eventState, abortController, {
      pollIntervalMs: 10,
      requiredConsecutive: 1,
      minStabilizationMs: 10,
    })

    //#then
    expect(result).toBe(130)
  })

  it("does not exit while the root transcript still has active background tasks", async () => {
    //#given - root emitted a terminal stop message, but background task lineage is still active
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
            parts: [{ type: "text", text: "I'm waiting for the background inspection." }],
          },
        ],
      },
    })
    const eventState = createEventState()
    eventState.mainSessionIdle = true
    eventState.hasReceivedMeaningfulWork = true
    const abortController = new AbortController()

    //#when
    abortAfter(abortController, 80)
    const result = await pollForCompletion(ctx, eventState, abortController, {
      pollIntervalMs: 10,
      requiredConsecutive: 1,
      minStabilizationMs: 10,
    })

    //#then
    expect(result).toBe(130)
  })

  it("resets consecutive counter when session becomes busy between checks", async () => {
    //#given
    const ctx = createMockContext()
    const eventState = createEventState()
    eventState.mainSessionIdle = true
    eventState.hasReceivedMeaningfulWork = true
    const abortController = new AbortController()
    let todoCallCount = 0
    let busyInserted = false

    ;(ctx.client.session as any).todo = mock(async () => {
      todoCallCount++
      if (todoCallCount === 1 && !busyInserted) {
        busyInserted = true
        eventState.mainSessionIdle = false
        setTimeout(() => { eventState.mainSessionIdle = true }, 15)
      }
      return { data: [] }
    })
    ;(ctx.client.session as any).children = mock(() =>
      Promise.resolve({ data: [] })
    )
    ;(ctx.client.session as any).status = mock(() =>
      Promise.resolve({ data: {} })
    )

    //#when
    const startMs = Date.now()
    const result = await pollForCompletion(ctx, eventState, abortController, {
      pollIntervalMs: 10,
      requiredConsecutive: 3,
      minStabilizationMs: 10,
    })
    const elapsedMs = Date.now() - startMs

    //#then - took longer than 3 polls because busy interrupted the streak
    expect(result).toBe(0)
    expect(elapsedMs).toBeGreaterThan(30)
  })

  it("returns 1 on session error", async () => {
    //#given
    const ctx = createMockContext()
    const eventState = createEventState()
    eventState.mainSessionIdle = true
    eventState.mainSessionError = true
    eventState.lastError = "Test error"
    const abortController = new AbortController()

    //#when
    const result = await pollForCompletion(ctx, eventState, abortController, {
      pollIntervalMs: 10,
      requiredConsecutive: 3,
      minStabilizationMs: 500,
    })

    //#then
    expect(result).toBe(1)
  })

  it("does not fail on transient session error when status has already recovered to busy", async () => {
    //#given - recoverable abort surfaced as session.error, but session status already resumed
    let statusCalls = 0
    const ctx = createMockContext({
      statuses: {},
    })
    ;(ctx.client.session as any).status = mock(async () => {
      statusCalls += 1
      return {
        data: {
          "test-session": {
            type: statusCalls === 1 ? "busy" : "idle",
          },
        },
      }
    })

    const eventState = createEventState()
    eventState.mainSessionIdle = true
    eventState.mainSessionError = true
    eventState.lastError = "Aborted"
    eventState.hasReceivedMeaningfulWork = true
    const abortController = new AbortController()

    //#when
    const result = await pollForCompletion(ctx, eventState, abortController, {
      pollIntervalMs: 10,
      requiredConsecutive: 1,
      minStabilizationMs: 10,
    })

    //#then - recovered busy status clears the transient error and run completes
    expect(result).toBe(0)
    expect(eventState.mainSessionError).toBe(false)
  })

  it("waits out delayed same-model retry errors before failing the run", async () => {
    //#given - gateway/proxy 403 is recoverable, but the retry does not flip session status immediately
    let statusCalls = 0
    const ctx = createMockContext({
      statuses: {},
    })
    ;(ctx.client.session as any).status = mock(async () => {
      statusCalls += 1
      if (statusCalls < 5) {
        return { data: {} }
      }
      return {
        data: {
          "test-session": {
            type: statusCalls === 5 ? "busy" : "idle",
          },
        },
      }
    })

    const eventState = createEventState()
    eventState.mainSessionIdle = true
    eventState.mainSessionError = true
    eventState.lastError =
      "Forbidden: request was blocked by a gateway or proxy. You may not have permission to access this resource."
    eventState.hasReceivedMeaningfulWork = true
    const abortController = new AbortController()

    //#when
    const result = await pollForCompletion(ctx, eventState, abortController, {
      pollIntervalMs: 10,
      requiredConsecutive: 1,
      minStabilizationMs: 10,
      delayedRetryErrorGraceMs: 60,
    })

    //#then - the poller should wait for the delayed retry handoff instead of failing after 3 short cycles
    expect(result).toBe(0)
    expect(eventState.mainSessionError).toBe(false)
    expect(statusCalls).toBeGreaterThanOrEqual(5)
  })

  it("waits out cross-model quota fallback errors before failing the run", async () => {
    //#given - paid model quota errors trigger limit_fallback, but the next model does not flip busy immediately
    let statusCalls = 0
    const ctx = createMockContext({
      statuses: {},
    })
    ;(ctx.client.session as any).status = mock(async () => {
      statusCalls += 1
      if (statusCalls < 5) {
        return { data: {} }
      }
      return {
        data: {
          "test-session": {
            type: statusCalls === 5 ? "busy" : "idle",
          },
        },
      }
    })

    const eventState = createEventState()
    eventState.mainSessionIdle = true
    eventState.mainSessionError = true
    eventState.lastError =
      "You're out of extra usage. Add more at claude.ai/settings/usage and keep going."
    eventState.hasReceivedMeaningfulWork = true
    const abortController = new AbortController()

    //#when
    const result = await pollForCompletion(ctx, eventState, abortController, {
      pollIntervalMs: 10,
      requiredConsecutive: 1,
      minStabilizationMs: 10,
      delayedRetryErrorGraceMs: 60,
    })

    //#then - cross-model handoff gets the same grace as same-model transient recovery
    expect(result).toBe(0)
    expect(eventState.mainSessionError).toBe(false)
    expect(statusCalls).toBeGreaterThanOrEqual(5)
  })

  it("restarts delayed retry grace when a new transient 403 arrives during recovery", async () => {
    //#given - first delayed-retry error fires, recovery retries, then a second 403 arrives and must reset grace
    let statusCalls = 0
    let recovered = false
    let busyReturned = false
    const ctx = createMockContext({
      statuses: {},
    })
    ;(ctx.client.session as any).status = mock(async () => {
      statusCalls += 1
      if (!recovered) {
        return { data: {} }
      }
      return {
        data: {
          "test-session": {
            type: busyReturned ? "idle" : (busyReturned = true, "busy"),
          },
        },
      }
    })

    const eventState = createEventState()
    eventState.mainSessionIdle = true
    eventState.mainSessionError = true
    eventState.lastError = "Forbidden: Request not allowed"
    eventState.errorSequence = 1
    eventState.lastErrorTimestamp = Date.now()
    eventState.hasReceivedMeaningfulWork = true
    const abortController = new AbortController()

    setTimeout(() => {
      eventState.mainSessionError = true
      eventState.lastError = "Forbidden: Request not allowed"
      eventState.errorSequence = 2
      eventState.lastErrorTimestamp = Date.now()
    }, 20)

    setTimeout(() => {
      recovered = true
    }, 105)

    //#when
    const result = await pollForCompletion(ctx, eventState, abortController, {
      pollIntervalMs: 10,
      requiredConsecutive: 1,
      minStabilizationMs: 10,
      delayedRetryErrorGraceMs: 80,
    })

    //#then - the second transient 403 should restart grace instead of inheriting the first window and failing
    expect(result).toBe(0)
    expect(eventState.mainSessionError).toBe(false)
    expect(statusCalls).toBeGreaterThan(0)
  })

  it("does not exit while a recoverable same-model retry is pending but the session still looks temporarily settled", async () => {
    //#given - root session hit a recoverable 403, recovery child has not materialized in API yet, and transcript still looks settled
    const ctx = createMockContext()
    const eventState = createEventState()
    eventState.mainSessionIdle = true
    eventState.hasReceivedMeaningfulWork = true
    eventState.mainSessionError = false
    eventState.lastError = "Forbidden: Request not allowed"
    eventState.errorSequence = 1
    eventState.lastErrorTimestamp = Date.now()
    eventState.pendingSameModelRecovery = true
    eventState.pendingSameModelRecoverySequence = 1
    eventState.pendingSameModelRecoveryStartedAt = Date.now()
    eventState.lastMeaningfulWorkTimestamp = Date.now() - 1000
    const abortController = new AbortController()

    //#when - abort before the transient recovery window expires
    abortAfter(abortController, 80)
    const result = await pollForCompletion(ctx, eventState, abortController, {
      pollIntervalMs: 10,
      requiredConsecutive: 1,
      minStabilizationMs: 10,
      delayedRetryErrorGraceMs: 500,
    })

    //#then - poller should keep waiting instead of exiting successfully on a transiently-settled root
    expect(result).toBe(130)
  })

  it("clears pending same-model recovery once completion probes observe active work again", async () => {
    //#given - pending recovery initially hides behind a settled transcript, then child work appears
    let childVisible = false
    const ctx = createMockContext({
      childrenBySession: {
        "test-session": [],
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
          { info: { id: "msg-user-child", role: "user" }, parts: [{ type: "text", text: "recover" }] },
          {
            info: { id: "msg-assistant-child", role: "assistant" },
            parts: [{ type: "step-start" }],
          },
        ],
      },
    })
    ;(ctx.client.session as any).children = mock(async (opts: { path: { id: string } }) => {
      if (opts.path.id === "test-session") {
        return { data: childVisible ? [{ id: "child-1" }] : [] }
      }
      return { data: [] }
    })
    ;(ctx.client.session as any).status = mock(async () => ({
      data: childVisible
        ? { "child-1": { type: "busy" } }
        : {},
    }))

    const eventState = createEventState()
    eventState.mainSessionIdle = true
    eventState.hasReceivedMeaningfulWork = true
    eventState.lastError = "Forbidden: Request not allowed"
    eventState.errorSequence = 1
    eventState.lastErrorTimestamp = Date.now()
    eventState.pendingSameModelRecovery = true
    eventState.pendingSameModelRecoverySequence = 1
    eventState.pendingSameModelRecoveryStartedAt = Date.now()
    eventState.lastMeaningfulWorkTimestamp = Date.now() - 1000
    const abortController = new AbortController()

    setTimeout(() => {
      childVisible = true
    }, 25)

    setTimeout(() => {
      ;(ctx.client.session as any).messages = mock(async (opts: { path: { id: string } }) => {
        if (opts.path.id === "child-1") {
          return {
            data: [
              { info: { id: "msg-user-child", role: "user" }, parts: [{ type: "text", text: "recover" }] },
              {
                info: { id: "msg-assistant-child", role: "assistant", finish: "stop" },
                parts: [{ type: "text", text: "Recovered" }],
              },
            ],
          }
        }
        return {
          data: [
            { info: { id: "msg-user-root", role: "user" }, parts: [{ type: "text", text: "start-work" }] },
            {
              info: { id: "msg-assistant-root", role: "assistant", finish: "stop" },
              parts: [{ type: "text", text: "All tasks completed." }],
            },
          ],
        }
      })
      ;(ctx.client.session as any).status = mock(async () => ({
        data: { "child-1": { type: "idle" } },
      }))
    }, 60)

    //#when
    const result = await pollForCompletion(ctx, eventState, abortController, {
      pollIntervalMs: 10,
      requiredConsecutive: 1,
      minStabilizationMs: 10,
      delayedRetryErrorGraceMs: 500,
    })

    //#then - once active child work appears, pending recovery should clear and completion can finish normally
    expect(result).toBe(0)
    expect(eventState.pendingSameModelRecovery).toBe(false)
  })

  it("does not fail when assistant activity clears a transient error before busy status appears", async () => {
    //#given - session.error fires, but assistant output resumes before status flips to busy/retry
    let statusCalls = 0
    const ctx = createMockContext({
      statuses: {},
    })
    ;(ctx.client.session as any).status = mock(async () => {
      statusCalls += 1
      return { data: {} }
    })

    const eventState = createEventState()
    eventState.mainSessionIdle = true
    eventState.mainSessionError = true
    eventState.lastError = "unknown certificate verification error"
    eventState.errorSequence = 1
    eventState.lastErrorTimestamp = Date.now()
    eventState.hasReceivedMeaningfulWork = true
    const abortController = new AbortController()

    setTimeout(() => {
      eventState.mainSessionError = false
      eventState.messageCount += 1
      eventState.hasReceivedMeaningfulWork = true
    }, 35)

    //#when
    const result = await pollForCompletion(ctx, eventState, abortController, {
      pollIntervalMs: 10,
      requiredConsecutive: 1,
      minStabilizationMs: 10,
      delayedRetryErrorGraceMs: 40,
    })

    //#then - recovered assistant output should prevent terminal failure even without a busy status edge
    expect(result).toBe(0)
    expect(statusCalls).toBeGreaterThanOrEqual(3)
  })

  it("waits out unknown certificate verification errors before failing the run", async () => {
    //#given - transport TLS error is recoverable and busy status appears after a short delay
    let statusCalls = 0
    const ctx = createMockContext({
      statuses: {},
    })
    ;(ctx.client.session as any).status = mock(async () => {
      statusCalls += 1
      if (statusCalls < 5) {
        return { data: {} }
      }
      return {
        data: {
          "test-session": {
            type: statusCalls === 5 ? "busy" : "idle",
          },
        },
      }
    })

    const eventState = createEventState()
    eventState.mainSessionIdle = true
    eventState.mainSessionError = true
    eventState.lastError = "unknown certificate verification error"
    eventState.errorSequence = 1
    eventState.lastErrorTimestamp = Date.now()
    eventState.hasReceivedMeaningfulWork = true
    const abortController = new AbortController()

    //#when
    const result = await pollForCompletion(ctx, eventState, abortController, {
      pollIntervalMs: 10,
      requiredConsecutive: 1,
      minStabilizationMs: 10,
      delayedRetryErrorGraceMs: 60,
    })

    //#then - same session recovery should keep the run alive until busy/idle settles
    expect(result).toBe(0)
    expect(eventState.mainSessionError).toBe(false)
    expect(statusCalls).toBeGreaterThanOrEqual(5)
  })

  it("returns 130 when aborted", async () => {
    //#given
    const ctx = createMockContext()
    const eventState = createEventState()
    const abortController = new AbortController()

    //#when
    abortAfter(abortController, 50)
    const result = await pollForCompletion(ctx, eventState, abortController, {
      pollIntervalMs: 10,
      requiredConsecutive: 3,
    })

    //#then
    expect(result).toBe(130)
  })

  it("does not check completion when hasReceivedMeaningfulWork is false", async () => {
    //#given
    const ctx = createMockContext()
    const eventState = createEventState()
    eventState.mainSessionIdle = true
    eventState.hasReceivedMeaningfulWork = false
    const abortController = new AbortController()

    //#when
    abortAfter(abortController, 100)
    const result = await pollForCompletion(ctx, eventState, abortController, {
      pollIntervalMs: 10,
      requiredConsecutive: 3,
    })

    //#then
    expect(result).toBe(130)
    const todoCallCount = (ctx.client.session.todo as ReturnType<typeof mock>).mock.calls.length
    expect(todoCallCount).toBe(0)
  })

  it("falls back to session.status API when idle event is missing", async () => {
    //#given - mainSessionIdle not set by events, but status API says idle
    const ctx = createMockContext({
      statuses: {
        "test-session": { type: "idle" },
      },
    })
    const eventState = createEventState()
    eventState.mainSessionIdle = false
    eventState.hasReceivedMeaningfulWork = true
    const abortController = new AbortController()

    //#when
    const result = await pollForCompletion(ctx, eventState, abortController, {
      pollIntervalMs: 10,
      requiredConsecutive: 2,
      minStabilizationMs: 10,
    })

    //#then - completion succeeds without idle event
    expect(result).toBe(0)
  })

  it("allows silent completion after stabilization when no meaningful work is received", async () => {
    //#given - session is idle and stable but no assistant message/tool event arrived
    const ctx = createMockContext()
    const eventState = createEventState()
    eventState.mainSessionIdle = true
    eventState.hasReceivedMeaningfulWork = false
    const abortController = new AbortController()

    //#when
    const result = await pollForCompletion(ctx, eventState, abortController, {
      pollIntervalMs: 10,
      requiredConsecutive: 1,
      minStabilizationMs: 30,
    })

    //#then - completion succeeds after stabilization window
    expect(result).toBe(0)
  })

  it("uses default stabilization to avoid indefinite wait when no meaningful work arrives", async () => {
    //#given - idle with no meaningful work and no explicit minStabilization override
    const ctx = createMockContext()
    const eventState = createEventState()
    eventState.mainSessionIdle = true
    eventState.hasReceivedMeaningfulWork = false
    const abortController = new AbortController()

    //#when
    const result = await pollForCompletion(ctx, eventState, abortController, {
      pollIntervalMs: 10,
      requiredConsecutive: 1,
    })

    //#then - command exits without manual Ctrl+C
    expect(result).toBe(0)
  })

  it("coerces non-positive stabilization values to default stabilization", async () => {
    //#given - explicit zero stabilization should still wait for default window
    const ctx = createMockContext()
    const eventState = createEventState()
    eventState.mainSessionIdle = true
    eventState.hasReceivedMeaningfulWork = false
    const abortController = new AbortController()

    //#when - abort before default 1s window elapses
    abortAfter(abortController, 100)
    const result = await pollForCompletion(ctx, eventState, abortController, {
      pollIntervalMs: 10,
      requiredConsecutive: 1,
      minStabilizationMs: 0,
    })

    //#then - should not complete early
    expect(result).toBe(130)
  })

  it("simulates race condition: brief idle with 0 todos does not cause immediate exit", async () => {
    //#given - simulate Sisyphus outputting text, session goes idle briefly, then tool fires
    const ctx = createMockContext()
    const eventState = createEventState()
    eventState.mainSessionIdle = true
    eventState.hasReceivedMeaningfulWork = true
    const abortController = new AbortController()
    let pollTick = 0

    ;(ctx.client.session as any).todo = mock(async () => {
      pollTick++
      if (pollTick === 2) {
        eventState.currentTool = "task"
      }
      return { data: [] }
    })
    ;(ctx.client.session as any).children = mock(() =>
      Promise.resolve({ data: [] })
    )
    ;(ctx.client.session as any).status = mock(() =>
      Promise.resolve({ data: {} })
    )

    //#when - abort after tool stays in-flight
    abortAfter(abortController, 200)
    const result = await pollForCompletion(ctx, eventState, abortController, {
      pollIntervalMs: 10,
      requiredConsecutive: 3,
    })

    //#then - should NOT have exited with 0 (tool blocked it, then aborted)
    expect(result).toBe(130)
  })

  it("does not exit while todo continuation countdown is active", async () => {
    //#given - run session goes idle with incomplete todos and todo continuation hook arms countdown
    const directory = createTempDir()
    const sessionID = "test-session"
    const hook = createTodoContinuationEnforcer(
      {
        directory,
        client: {
          session: {
            todo: async () => ({
              data: [
                { id: "todo-1", content: "Continue working", status: "pending", priority: "high" },
              ],
            }),
            messages: async () => ({ data: [] }),
            promptAsync: async () => ({}),
          },
          tui: {
            showToast: async () => ({}),
          },
        },
      } as any,
      {},
    )
    await hook.handler({
      event: { type: "session.idle", properties: { sessionID } },
    })

    const ctx = createMockContext()
    ctx.sessionID = sessionID
    ctx.directory = directory
    const eventState = createEventState()
    eventState.mainSessionIdle = true
    eventState.hasReceivedMeaningfulWork = true
    const abortController = new AbortController()

    //#when - poll runs during the countdown window
    abortAfter(abortController, 100)
    const result = await pollForCompletion(ctx, eventState, abortController, {
      pollIntervalMs: 10,
      requiredConsecutive: 1,
      minStabilizationMs: 10,
    })

    //#then - active continuation must keep run alive
    expect(result).toBe(130)
  })

  it("returns 1 when session errors while not idle (error not masked by idle gate)", async () => {
    //#given - mainSessionIdle=false, mainSessionError=true, lastError="crash"
    const ctx = createMockContext()
    const eventState = createEventState()
    eventState.mainSessionIdle = false
    eventState.mainSessionError = true
    eventState.lastError = "crash"
    eventState.hasReceivedMeaningfulWork = true
    const abortController = new AbortController()

    //#when - pollForCompletion runs
    const result = await pollForCompletion(ctx, eventState, abortController, {
      pollIntervalMs: 10,
      requiredConsecutive: 3,
    })

    //#then - returns 1 (not 130/timeout), error message printed
    expect(result).toBe(1)
    const errorCalls = (console.error as ReturnType<typeof mock>).mock.calls
    expect(errorCalls.some((call: unknown[]) => String(call[0] ?? "").includes("Session ended with error"))).toBe(true)
  })

  it("returns 1 when session errors while tool is active (error not masked by tool gate)", async () => {
    //#given - mainSessionIdle=true, currentTool="bash", mainSessionError=true
    const ctx = createMockContext()
    const eventState = createEventState()
    eventState.mainSessionIdle = true
    eventState.currentTool = "bash"
    eventState.mainSessionError = true
    eventState.lastError = "error during tool"
    eventState.hasReceivedMeaningfulWork = true
    const abortController = new AbortController()

    //#when
    const result = await pollForCompletion(ctx, eventState, abortController, {
      pollIntervalMs: 10,
      requiredConsecutive: 3,
    })

    //#then - returns 1
    expect(result).toBe(1)
  })

})
