declare const require: (name: string) => any
const { afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } = require("bun:test")

const fixEmptyMessagesWithSDKMock = mock(async () => ({
  fixed: true,
  fixedMessageIds: ["msg_empty"],
  scannedEmptyCount: 1,
}))

import { _resetEventRecoveryStateForTesting, createEventHandler } from "./event"
import { _resetForTesting } from "../features/claude-code-session-state"
import * as connectedProvidersCache from "../shared/connected-providers-cache"
import * as emptyContentRecoverySdk from "../hooks/anthropic-context-window-limit-recovery/empty-content-recovery-sdk"

const promptAsyncMock = mock(async () => ({}))

function createHandler(messages: Array<Record<string, unknown>>) {
  return createEventHandler({
    ctx: {
      directory: "/tmp",
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

    const handlerA = createHandler(messages)
    const handlerB = createHandler(messages)
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
})
