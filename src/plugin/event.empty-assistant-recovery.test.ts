declare const require: (name: string) => any
const { afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } = require("bun:test")
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const fixEmptyMessagesWithSDKMock = mock(async () => ({
  fixed: true,
  fixedMessageIds: ["msg_empty"],
  scannedEmptyCount: 1,
}))

import { _resetEventRecoveryStateForTesting, createEventHandler } from "./event"
import { _resetForTesting } from "../features/claude-code-session-state"
import { readContinuationMarker } from "../features/run-continuation-state"
import * as connectedProvidersCache from "../shared/connected-providers-cache"
import * as emptyContentRecoverySdk from "../hooks/anthropic-context-window-limit-recovery/empty-content-recovery-sdk"
import * as loggerModule from "../shared/logger"

const promptAsyncMock = mock(async () => ({}))
const tempDirs: string[] = []

function createTempDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "omo-event-empty-recovery-"))
  tempDirs.push(directory)
  return directory
}

function createHandler(messages: Array<Record<string, unknown>>, directory = "/tmp") {
  return createEventHandler({
    ctx: {
      directory,
      client: {
        session: {
          messages: async () => ({ data: messages }),
          abort: async () => ({}),
          prompt: async () => ({}),
          promptAsync: promptAsyncMock,
          summarize: async () => ({}),
        },
        tui: {
          showToast: async () => ({}),
        },
      },
    } as any,
    pluginConfig: {
      experimental: {
        auto_resume: true,
      },
    } as any,
    firstMessageVariantGate: {
      markSessionCreated: () => {},
      clear: () => {},
    },
    managers: {
      tmuxSessionManager: {
        onSessionCreated: async () => {},
        onSessionDeleted: async () => {},
      },
      skillMcpManager: {
        disconnectSession: async () => {},
      },
    } as any,
    hooks: {
      stopContinuationGuard: { isStopped: () => false },
    } as any,
  })
}

describe("createEventHandler idle empty assistant recovery", () => {
  beforeEach(() => {
    spyOn(connectedProvidersCache, "readConnectedProvidersCache").mockReturnValue(null)
    spyOn(connectedProvidersCache, "readProviderModelsCache").mockReturnValue(null)
    spyOn(emptyContentRecoverySdk, "fixEmptyMessagesWithSDK").mockImplementation(fixEmptyMessagesWithSDKMock)
  })

  afterEach(() => {
    _resetEventRecoveryStateForTesting()
    _resetForTesting()
    fixEmptyMessagesWithSDKMock.mockClear()
    promptAsyncMock.mockClear()
    while (tempDirs.length > 0) {
      const directory = tempDirs.pop()
      if (directory) {
        rmSync(directory, { recursive: true, force: true })
      }
    }
    try {
      jest.clearAllTimers()
      jest.useRealTimers()
    } catch {}
    mock.restore()
  })

  test("recovers and resumes when idle session ends with an empty assistant turn", async () => {
    //#given
    const handler = createHandler([
      {
        info: {
          id: "msg_user",
          role: "user",
          agent: "Prometheus (Plan Builder)",
          model: {
            providerID: "anthropic",
            modelID: "claude-opus-4-6",
          },
        },
        parts: [{ type: "text", text: "continue" }],
      },
      {
        info: {
          id: "msg_empty",
          role: "assistant",
        },
        parts: [],
      },
    ])

    //#when
    await handler({
      event: {
        type: "session.status",
        properties: {
          sessionID: "ses_empty",
          status: { type: "idle" },
        },
      },
    })

    //#then
    expect(fixEmptyMessagesWithSDKMock).toHaveBeenCalledTimes(1)
    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    expect(promptAsyncMock).toHaveBeenCalledWith({
      path: { id: "ses_empty" },
      body: expect.objectContaining({
        agent: "Prometheus (Plan Builder)",
        model: {
          providerID: "anthropic",
          modelID: "claude-opus-4-6",
        },
      }),
      query: { directory: "/tmp" },
    })
  })

  test("does not re-run recovery for repeated idle events on the same empty assistant message", async () => {
    //#given
    const handler = createHandler([
      {
        info: {
          id: "msg_user",
          role: "user",
          agent: "Prometheus (Plan Builder)",
          model: {
            providerID: "anthropic",
            modelID: "claude-opus-4-6",
          },
        },
        parts: [{ type: "text", text: "continue" }],
      },
      {
        info: {
          id: "msg_empty_dedup",
          role: "assistant",
        },
        parts: [],
      },
    ])

    //#when
    await handler({
      event: {
        type: "session.status",
        properties: {
          sessionID: "ses_empty_dedup",
          status: { type: "idle" },
        },
      },
    })
    await handler({
      event: {
        type: "session.status",
        properties: {
          sessionID: "ses_empty_dedup",
          status: { type: "idle" },
        },
      },
    })

    //#then
    expect(fixEmptyMessagesWithSDKMock).toHaveBeenCalledTimes(1)
    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
  })

  test("dedupes delayed empty assistant recovery across multiple handler instances for the same message", async () => {
    jest.useFakeTimers()
    const directory = createTempDir()

    const messages = [
      {
        info: {
          id: "msg_user_shared_delay",
          role: "user",
          agent: "Atlas (Plan Executor)",
          model: {
            providerID: "openai",
            modelID: "gpt-5.4",
          },
        },
        parts: [{ type: "text", text: "continue" }],
      },
      {
        info: {
          id: "msg_empty_shared_delay",
          role: "assistant",
          agent: "Atlas (Plan Executor)",
        },
        parts: [],
      },
    ]

    const handlerA = createHandler(messages, directory)
    const handlerB = createHandler(messages, directory)
    const event = {
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_empty_shared_delay",
            sessionID: "ses_empty_shared_delay",
            role: "assistant",
            agent: "Atlas (Plan Executor)",
          },
        },
      },
    } as const

    await handlerA(event)
    await handlerB(event)

    expect(readContinuationMarker(directory, "ses_empty_shared_delay")?.sources.recovery?.state).toBe("active")

    if (typeof jest.advanceTimersByTimeAsync === "function") {
      await jest.advanceTimersByTimeAsync(5001)
    } else {
      jest.advanceTimersByTime(5001)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    }

    expect(fixEmptyMessagesWithSDKMock).toHaveBeenCalledTimes(1)
    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    expect(readContinuationMarker(directory, "ses_empty_shared_delay")).toBeNull()
  })

  test("does not recover when an assistant turn starts with internal parts but later streams visible object deltas", async () => {
    jest.useFakeTimers()

    const handler = createHandler([
      {
        info: {
          id: "msg_user_object_delta",
          role: "user",
          agent: "Atlas (Plan Executor)",
          model: {
            providerID: "openai",
            modelID: "gpt-5.4",
          },
        },
        parts: [{ type: "text", text: "continue" }],
      },
      {
        info: {
          id: "msg_object_delta",
          role: "assistant",
          agent: "Atlas (Plan Executor)",
        },
        parts: [],
      },
    ])

    await handler({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_object_delta",
            sessionID: "ses_object_delta",
            role: "assistant",
            agent: "Atlas (Plan Executor)",
          },
        },
      },
    } as const)

    await handler({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part_reasoning_object_delta",
            sessionID: "ses_object_delta",
            messageID: "msg_object_delta",
            type: "reasoning",
            text: "",
          },
        },
      },
    } as const)

    await handler({
      event: {
        type: "message.part.delta",
        properties: {
          sessionID: "ses_object_delta",
          messageID: "msg_object_delta",
          partID: "part_reasoning_object_delta",
          field: "text",
          delta: { text: "Visible streamed answer content" },
        },
      },
    } as const)

    if (typeof jest.advanceTimersByTimeAsync === "function") {
      await jest.advanceTimersByTimeAsync(5001)
    } else {
      jest.advanceTimersByTime(5001)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    }

    expect(fixEmptyMessagesWithSDKMock).not.toHaveBeenCalled()
    expect(promptAsyncMock).not.toHaveBeenCalled()
  })

  test("recovers delayed compaction-only assistant turns for non-planner agents", async () => {
    jest.useFakeTimers()

    const handler = createHandler([
      {
        info: {
          id: "msg_user_compaction_only_non_planner",
          role: "user",
          agent: "Sisyphus Junior (Focused Executor)",
          model: {
            providerID: "openai",
            modelID: "gpt-5.4",
          },
        },
        parts: [{ type: "text", text: "continue execution" }],
      },
      {
        info: {
          id: "msg_compaction_only_non_planner",
          role: "assistant",
          agent: "Sisyphus Junior (Focused Executor)",
        },
        parts: [{ type: "compaction" }],
      },
    ])

    await handler({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_compaction_only_non_planner",
            sessionID: "ses_compaction_only_non_planner",
            role: "assistant",
            agent: "Sisyphus Junior (Focused Executor)",
          },
        },
      },
    } as const)

    await handler({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part_compaction_only_non_planner",
            sessionID: "ses_compaction_only_non_planner",
            messageID: "msg_compaction_only_non_planner",
            type: "compaction",
          },
        },
      },
    } as const)

    if (typeof jest.advanceTimersByTimeAsync === "function") {
      await jest.advanceTimersByTimeAsync(5001)
    } else {
      jest.advanceTimersByTime(5001)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    }

    expect(fixEmptyMessagesWithSDKMock).toHaveBeenCalledTimes(1)
    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    expect(promptAsyncMock).toHaveBeenCalledWith({
      path: { id: "ses_compaction_only_non_planner" },
      body: expect.objectContaining({
        agent: "Sisyphus Junior (Focused Executor)",
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
      }),
      query: { directory: "/tmp" },
    })
  })

  test("does not recover when idle session ends with a reasoning-only assistant turn", async () => {
    //#given
    const handler = createHandler([
      {
        info: {
          id: "msg_user_reasoning_only_non_planner",
          role: "user",
          agent: "Atlas (Plan Executor)",
          model: {
            providerID: "anthropic",
            modelID: "claude-opus-4-6",
          },
        },
        parts: [{ type: "text", text: "continue" }],
      },
      {
        info: {
          id: "msg_reasoning_only_non_planner",
          role: "assistant",
          agent: "Atlas (Plan Executor)",
          finish: "other",
        },
        parts: [
          {
            type: "reasoning",
            text: "I have all prerequisite findings and can now synthesize them into the plan.",
          },
          {
            type: "step-finish",
            reason: "other",
          },
        ],
      },
    ])

    //#when
    await handler({
      event: {
        type: "session.status",
        properties: {
          sessionID: "ses_reasoning_only_non_planner",
          status: { type: "idle" },
        },
      },
    })

    //#then
    expect(fixEmptyMessagesWithSDKMock).not.toHaveBeenCalled()
    expect(promptAsyncMock).not.toHaveBeenCalled()
  })

  test("recovers and resumes when idle prometheus session ends with a reasoning-only assistant turn", async () => {
    //#given
    const handler = createHandler([
      {
        info: {
          id: "msg_user_reasoning_only_planner",
          role: "user",
          agent: "Prometheus (Plan Builder)",
          model: {
            providerID: "anthropic",
            modelID: "claude-opus-4-6",
          },
        },
        parts: [{ type: "text", text: "finish the plan" }],
      },
      {
        info: {
          id: "msg_reasoning_only_planner",
          role: "assistant",
          agent: "Prometheus (Plan Builder)",
          finish: "other",
        },
        parts: [
          {
            type: "reasoning",
            text: "I have enough information to write the plan but need to continue the generation flow.",
          },
          {
            type: "step-finish",
            reason: "other",
          },
        ],
      },
    ])

    //#when
    await handler({
      event: {
        type: "session.status",
        properties: {
          sessionID: "ses_reasoning_only_planner",
          status: { type: "idle" },
        },
      },
    })

    //#then
    expect(fixEmptyMessagesWithSDKMock).not.toHaveBeenCalled()
    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    expect(promptAsyncMock).toHaveBeenCalledWith({
      path: { id: "ses_reasoning_only_planner" },
      body: expect.objectContaining({
        agent: "Prometheus (Plan Builder)",
        model: {
          providerID: "anthropic",
          modelID: "claude-opus-4-6",
        },
      }),
      query: { directory: "/tmp" },
    })
  })

  test("recovers and resumes when idle prometheus session ends with a raw-shape reasoning-only assistant turn", async () => {
    //#given
    const handler = createHandler([
      {
        id: "msg_user_reasoning_only_planner_raw",
        role: "user",
        agent: "Prometheus (Plan Builder)",
        model: {
          providerID: "anthropic",
          modelID: "claude-opus-4-6",
        },
        parts: [{ type: "text", text: "finish the plan" }],
      },
      {
        id: "msg_reasoning_only_planner_raw",
        role: "assistant",
        agent: "Prometheus (Plan Builder)",
        finish: "other",
        parts: [
          {
            type: "reasoning",
            text: "I now have enough information to consolidate the final plan.",
          },
          {
            type: "step-finish",
            reason: "other",
          },
        ],
      },
    ])

    //#when
    await handler({
      event: {
        type: "session.status",
        properties: {
          sessionID: "ses_reasoning_only_planner_raw",
          status: { type: "idle" },
        },
      },
    })

    //#then
    expect(fixEmptyMessagesWithSDKMock).not.toHaveBeenCalled()
    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    expect(promptAsyncMock).toHaveBeenCalledWith({
      path: { id: "ses_reasoning_only_planner_raw" },
      body: expect.objectContaining({
        agent: "Prometheus (Plan Builder)",
        model: {
          providerID: "anthropic",
          modelID: "claude-opus-4-6",
        },
        parts: expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("Do not stop at reasoning."),
          }),
        ]),
      }),
      query: { directory: "/tmp" },
    })
  })

  test("recovers planner reasoning-only idle turns when session.status uses camelCase sessionId", async () => {
    //#given
    const handler = createHandler([
      {
        id: "msg_user_reasoning_only_planner_raw_camel",
        role: "user",
        agent: "Prometheus (Plan Builder)",
        providerID: "anthropic",
        modelID: "claude-opus-4-6",
        parts: [{ type: "text", text: "finish the plan" }],
      },
      {
        id: "msg_reasoning_only_planner_raw_camel",
        role: "assistant",
        agent: "Prometheus (Plan Builder)",
        finish: "other",
        parts: [
          {
            type: "reasoning",
            text: "I have enough context and should now write the final plan.",
          },
          {
            type: "step-finish",
            reason: "other",
          },
        ],
      },
    ])

    //#when
    await handler({
      event: {
        type: "session.status",
        properties: {
          sessionId: "ses_reasoning_only_planner_raw_camel",
          status: { type: "idle" },
        },
      },
    })

    //#then
    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    expect(promptAsyncMock).toHaveBeenCalledWith({
      path: { id: "ses_reasoning_only_planner_raw_camel" },
      body: expect.objectContaining({
        agent: "Prometheus (Plan Builder)",
        model: {
          providerID: "anthropic",
          modelID: "claude-opus-4-6",
        },
        parts: expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("TodoWrite"),
          }),
        ]),
      }),
      query: { directory: "/tmp" },
    })
  })

  test("logs delayed empty assistant recovery scheduling only once for repeated refreshes of the same message", async () => {
    jest.useFakeTimers()

    const logCalls: Array<{ message: string; data?: unknown }> = []
    spyOn(loggerModule, "log").mockImplementation((message: string, data?: unknown) => {
      logCalls.push({ message, data })
    })

    const handler = createHandler([
      {
        info: {
          id: "msg_user_prometheus_delay",
          role: "user",
          agent: "Prometheus (Plan Builder)",
          model: {
            providerID: "anthropic",
            modelID: "claude-opus-4-6",
          },
        },
        parts: [{ type: "text", text: "continue" }],
      },
      {
        info: {
          id: "msg_prometheus_delay",
          role: "assistant",
          agent: "Prometheus (Plan Builder)",
        },
        parts: [],
      },
    ])

    const event = {
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_prometheus_delay",
            sessionID: "ses_prometheus_delay",
            role: "assistant",
            agent: "Prometheus (Plan Builder)",
          },
        },
      },
    } as const

    await handler(event)
    await handler(event)
    await handler(event)

    const scheduledRecoveryLogs = logCalls.filter(
      ({ message }) => message === "[event] scheduled delayed empty assistant recovery",
    )

    expect(scheduledRecoveryLogs).toHaveLength(1)
    expect(scheduledRecoveryLogs[0]).toEqual({
      message: "[event] scheduled delayed empty assistant recovery",
      data: {
        sessionID: "ses_prometheus_delay",
        messageID: "msg_prometheus_delay",
        delayMs: 5000,
      },
    })
  })
})
