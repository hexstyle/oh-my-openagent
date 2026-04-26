const { describe, test, expect, beforeEach } = require("bun:test")
const { resetMessageCursor } = require("../../shared/session-cursor")

type ProcessMessages = typeof import("./message-processor").processMessages

async function importProcessMessages(): Promise<ProcessMessages> {
  const module = await import("./message-processor")
  return module.processMessages
}

type SDKMessage = {
  info?: { role?: string; time?: { created?: number } }
  parts?: Array<{ type: string; text?: string; content?: string | Array<{ type: string; text?: string }> }>
}

function createCtx(messages: SDKMessage[]) {
  return {
    client: {
      session: {
        messages: async () => ({ data: messages }),
      },
    },
  } as never
}

describe("processMessages", () => {
  beforeEach(() => {
    resetMessageCursor()
  })

  test("extracts text from assistant messages only", async () => {
    const processMessages = await importProcessMessages()
    const messages: SDKMessage[] = [
      { info: { role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "find files" }] },
      { info: { role: "assistant", time: { created: 2 } }, parts: [{ type: "text", text: "Found 3 files." }] },
    ]

    const result = await processMessages("ses-text-only", createCtx(messages))
    expect(result).toBe("Found 3 files.")
  })

  test("extracts reasoning parts from assistant messages", async () => {
    const processMessages = await importProcessMessages()
    const messages: SDKMessage[] = [
      {
        info: { role: "assistant", time: { created: 1 } },
        parts: [
          { type: "reasoning", text: "Let me think about this..." },
          { type: "text", text: "The answer is 42." },
        ],
      },
    ]

    const result = await processMessages("ses-reasoning", createCtx(messages))
    expect(result).toContain("Let me think about this...")
    expect(result).toContain("The answer is 42.")
  })

  test("excludes tool_result parts from output", async () => {
    const processMessages = await importProcessMessages()
    const messages: SDKMessage[] = [
      {
        info: { role: "tool", time: { created: 1 } },
        parts: [{ type: "tool_result", text: "", content: "grep output with <system-reminder> tags" }],
      },
      {
        info: { role: "assistant", time: { created: 2 } },
        parts: [{ type: "text", text: "I found the relevant code." }],
      },
    ]

    const result = await processMessages("ses-no-tool-result", createCtx(messages))
    expect(result).toBe("I found the relevant code.")
    expect(result).not.toContain("system-reminder")
    expect(result).not.toContain("grep output")
  })

  test("excludes tool role messages entirely", async () => {
    const processMessages = await importProcessMessages()
    const messages: SDKMessage[] = [
      {
        info: { role: "tool", time: { created: 1 } },
        parts: [{ type: "text", text: "raw bash output with escape codes \x1b[31m" }],
      },
      {
        info: { role: "assistant", time: { created: 2 } },
        parts: [{ type: "text", text: "Command completed successfully." }],
      },
    ]

    const result = await processMessages("ses-no-tool-role", createCtx(messages))
    expect(result).toBe("Command completed successfully.")
    expect(result).not.toContain("escape codes")
  })

  test("throws when no assistant messages exist", async () => {
    const processMessages = await importProcessMessages()
    const messages: SDKMessage[] = [
      { info: { role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "hello" }] },
      { info: { role: "tool", time: { created: 2 } }, parts: [{ type: "tool_result", content: "result data" }] },
    ]

    expect(processMessages("ses-no-assistant", createCtx(messages))).rejects.toThrow(
      "No assistant response found"
    )
  })

  test("joins multiple assistant messages with double newline", async () => {
    const processMessages = await importProcessMessages()
    const messages: SDKMessage[] = [
      { info: { role: "assistant", time: { created: 1 } }, parts: [{ type: "text", text: "First response." }] },
      { info: { role: "assistant", time: { created: 2 } }, parts: [{ type: "text", text: "Second response." }] },
    ]

    const result = await processMessages("ses-multi", createCtx(messages))
    expect(result).toBe("First response.\n\nSecond response.")
  })

  test("sorts assistant messages by time ascending", async () => {
    const processMessages = await importProcessMessages()
    const messages: SDKMessage[] = [
      { info: { role: "assistant", time: { created: 300 } }, parts: [{ type: "text", text: "later" }] },
      { info: { role: "assistant", time: { created: 100 } }, parts: [{ type: "text", text: "earlier" }] },
    ]

    const result = await processMessages("ses-sort", createCtx(messages))
    expect(result).toBe("earlier\n\nlater")
  })

  test("skips assistant parts that are not text or reasoning", async () => {
    const processMessages = await importProcessMessages()
    const messages: SDKMessage[] = [
      {
        info: { role: "assistant", time: { created: 1 } },
        parts: [
          { type: "tool_use", text: "calling grep..." },
          { type: "text", text: "Clean output." },
        ],
      },
    ]

    const result = await processMessages("ses-skip-tool-use", createCtx(messages))
    expect(result).toBe("Clean output.")
  })
})

export {}
