declare const require: (name: string) => any
const { afterEach, describe, expect, mock, test } = require("bun:test")

mock.module("../shared/connected-providers-cache", () => ({
  readConnectedProvidersCache: () => null,
  readProviderModelsCache: () => null,
}))

const fixEmptyMessagesWithSDKMock = mock(async () => ({
  fixed: true,
  fixedMessageIds: ["msg_empty"],
  scannedEmptyCount: 1,
}))

const resumeSessionMock = mock(async () => true)

mock.module("../hooks/anthropic-context-window-limit-recovery/empty-content-recovery-sdk", () => ({
  fixEmptyMessagesWithSDK: fixEmptyMessagesWithSDKMock,
}))

mock.module("../hooks/session-recovery/resume", () => ({
  findLastUserMessage: (messages: Array<{ info?: { role?: string } }>) => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.info?.role === "user") {
        return messages[index]
      }
    }
    return undefined
  },
  extractResumeConfig: (
    userMessage: { info?: { agent?: string; model?: { providerID: string; modelID: string }; tools?: Record<string, boolean> } } | undefined,
    sessionID: string,
  ) => ({
    sessionID,
    agent: userMessage?.info?.agent,
    model: userMessage?.info?.model,
    tools: userMessage?.info?.tools,
  }),
  resumeSession: resumeSessionMock,
}))

import { createEventHandler } from "./event"
import { _resetForTesting } from "../features/claude-code-session-state"

function createHandler(messages: Array<Record<string, unknown>>) {
  return createEventHandler({
    ctx: {
      directory: "/tmp",
      client: {
        session: {
          messages: async () => ({ data: messages }),
          abort: async () => ({}),
          prompt: async () => ({}),
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
  afterEach(() => {
    _resetForTesting()
    fixEmptyMessagesWithSDKMock.mockClear()
    resumeSessionMock.mockClear()
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
    expect(resumeSessionMock).toHaveBeenCalledWith(
      expect.anything(),
      {
        sessionID: "ses_empty",
        agent: "Prometheus (Plan Builder)",
        model: {
          providerID: "anthropic",
          modelID: "claude-opus-4-6",
        },
        tools: undefined,
      },
    )
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
    expect(resumeSessionMock).toHaveBeenCalledTimes(1)
  })
})
