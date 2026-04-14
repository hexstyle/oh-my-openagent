declare const require: (name: string) => any
import { createSessionRecoveryHook } from "./hook"
import type { MessageData } from "./types"
import { registerThinkingPrependTests } from "./index.thinking-prepend.test-helper"

const { describe, expect, it, mock } = require("bun:test")

registerThinkingPrependTests()

type RecoveryCase = {
  name: string
  sessionID: string
  failedMessageID: string
  failedParts: RecoveryPart[]
  expectedDeleteIDs: string[]
}

type RecoveryPart = NonNullable<MessageData["parts"]>[number] & {
  signature?: string
}

const finalBlockError = {
  message: "messages.1: The final block in an assistant message cannot be thinking.",
}

function createMessages(testCase: RecoveryCase): MessageData[] {
  return [
    {
      info: { id: `${testCase.failedMessageID}_history`, role: "assistant" },
      parts: [{ id: "prt_0_prev", type: "thinking", thinking: "plan", signature: "sig-prev" }],
    },
    {
      info: { id: testCase.failedMessageID, role: "assistant" },
      parts: testCase.failedParts,
    },
  ]
}

function createRecoveryHarness(messages: MessageData[]) {
  const fetchMock = mock((input: string | URL | Request, init?: RequestInit) => {
    void input
    void init
    return Promise.resolve(new Response(null, { status: 200 }))
  })
  const originalFetch = global.fetch
  const originalAbortTimeout = AbortSignal.timeout
  global.fetch = fetchMock
  Object.defineProperty(AbortSignal, "timeout", {
    configurable: true,
    value: () => new AbortController().signal,
  })
  process.env.OPENCODE_SERVER_PASSWORD = "testpassword"
  process.env.OPENCODE_SERVER_USERNAME = "opencode"

  const hook = createSessionRecoveryHook({
    client: {
      _client: { getConfig: () => ({ baseUrl: "https://api.example.com" }) },
      session: {
        abort: mock(() => Promise.resolve({})),
        messages: mock(() => Promise.resolve({ data: messages })),
      },
      tui: { showToast: mock(() => Promise.resolve({})) },
    },
    directory: "/tmp/session-recovery-tests",
  } as never)

  return {
    hook,
    fetchMock,
    restore: (): void => {
      global.fetch = originalFetch
      Object.defineProperty(AbortSignal, "timeout", {
        configurable: true,
        value: originalAbortTimeout,
      })
      delete process.env.OPENCODE_SERVER_PASSWORD
      delete process.env.OPENCODE_SERVER_USERNAME
    },
  }
}

describe("createSessionRecoveryHook trailing-thinking recovery", () => {
  for (const testCase of [
    {
      name: "strips multiple trailing thinking blocks instead of patching around them",
      sessionID: "ses_trailing_thinking_multi",
      failedMessageID: "msg_failed_multi",
      failedParts: [
        { id: "prt_a_text_multi", type: "text", text: "tool result summary" },
        { id: "prt_b_tail_multi_a", type: "thinking", thinking: "late thought a", signature: "sig-a" },
        { id: "prt_c_tail_multi_b", type: "thinking", thinking: "late thought b", signature: "sig-b" },
      ],
      expectedDeleteIDs: ["prt_b_tail_multi_a", "prt_c_tail_multi_b"],
    },
    {
      name: "strips only the final thinking block when the message already starts with thinking",
      sessionID: "ses_trailing_thinking_both_ends",
      failedMessageID: "msg_failed_both_ends",
      failedParts: [
        { id: "prt_leading_both_ends", type: "thinking", thinking: "keep this", signature: "sig-leading" },
        { id: "prt_text_both_ends", type: "text", text: "continue" },
        { id: "prt_tail_both_ends", type: "thinking", thinking: "remove this", signature: "sig-trailing" },
      ],
      expectedDeleteIDs: ["prt_tail_both_ends"],
    },
    {
      name: "strips a thinking-only assistant message after the final-block API error",
      sessionID: "ses_trailing_thinking_only",
      failedMessageID: "msg_failed_only",
      failedParts: [{ id: "prt_only_tail", type: "thinking", thinking: "only trailing block", signature: "sig-only" }],
      expectedDeleteIDs: ["prt_only_tail"],
    },
  ] satisfies RecoveryCase[]) {
    it(testCase.name, async () => {
      const { hook, fetchMock, restore } = createRecoveryHarness(createMessages(testCase))

      try {
        expect(await hook.handleSessionRecovery({
          id: testCase.failedMessageID,
          role: "assistant",
          sessionID: testCase.sessionID,
          error: finalBlockError,
        })).toBe(true)

        for (const partID of testCase.expectedDeleteIDs) {
          expect(fetchMock).toHaveBeenCalledWith(
            `https://api.example.com/session/${testCase.sessionID}/message/${testCase.failedMessageID}/part/${partID}`,
            expect.objectContaining({ method: "DELETE" }),
          )
        }
      } finally {
        restore()
      }
    })
  }
})
