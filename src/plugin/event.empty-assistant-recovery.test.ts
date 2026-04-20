declare const require: (name: string) => any
const { afterEach, beforeEach, describe, expect, mock, spyOn, test } = require("bun:test")

const fixEmptyMessagesWithSDKMock = mock(async () => ({
  fixed: true,
  fixedMessageIds: ["msg_empty"],
  scannedEmptyCount: 1,
}))

import { createEventHandler } from "./event"
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
    _resetForTesting()
    fixEmptyMessagesWithSDKMock.mockClear()
    promptAsyncMock.mockClear()
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

  test("does not recover when idle session ends with a reasoning-only assistant turn", async () => {
    //#given
    const handler = createHandler([
      {
        info: {
          id: "msg_user_reasoning_only",
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
          id: "msg_reasoning_only",
          role: "assistant",
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
          sessionID: "ses_reasoning_only",
          status: { type: "idle" },
        },
      },
    })

    //#then
    expect(fixEmptyMessagesWithSDKMock).not.toHaveBeenCalled()
    expect(promptAsyncMock).not.toHaveBeenCalled()
  })
})
