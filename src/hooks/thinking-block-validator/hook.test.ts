declare const require: (name: string) => any
import { createThinkingBlockValidatorHook } from "./hook"

const { describe, expect, it } = require("bun:test")

type TestPart = {
  type: string
  text?: string
  thinking?: string
  signature?: string
  synthetic?: boolean
}

type TestMessage = {
  info: { role: "assistant" | "user" }
  parts: TestPart[]
}

const assistant = (...parts: TestPart[]): TestMessage => ({ info: { role: "assistant" }, parts })
const text = (value: string): TestPart => ({ type: "text", text: value })
const toolUse = (): TestPart => ({ type: "tool_use" })
const signedThinking = (signature: string, thinking = "plan"): TestPart => ({
  type: "thinking",
  thinking,
  signature,
})
const redactedThinking = (signature: string): TestPart => ({
  type: "redacted_thinking",
  signature,
})

async function runTransform(messages: TestMessage[]): Promise<void> {
  const transform = createThinkingBlockValidatorHook()["experimental.chat.messages.transform"]
  if (!transform) throw new Error("missing thinking block validator transform")
  await transform({}, { messages: messages as never })
}

describe("createThinkingBlockValidatorHook", () => {
  for (const { name, historyPart, targetPart } of [
    {
      name: "injects signed thinking history verbatim",
      historyPart: signedThinking("signed-thinking"),
      targetPart: text("continue"),
    },
    {
      name: "injects signed redacted_thinking history verbatim",
      historyPart: redactedThinking("signed-redacted-thinking"),
      targetPart: toolUse(),
    },
  ]) {
    it(name, async () => {
      const messages = [assistant(historyPart), assistant(targetPart)] satisfies TestMessage[]
      await runTransform(messages)
      expect(messages[1]?.parts[0]).toBe(historyPart)
    })
  }

  for (const { name, historyPart } of [
    {
      name: "skips hook when history contains reasoning only",
      historyPart: { type: "reasoning", text: "internal reasoning" } satisfies TestPart,
    },
    {
      name: "skips hook when no signed history exists",
      historyPart: { type: "thinking", thinking: "draft" } satisfies TestPart,
    },
    {
      name: "skips hook when history contains synthetic signed blocks only",
      historyPart: {
        type: "thinking",
        thinking: "synthetic",
        signature: "synthetic-signature",
        synthetic: true,
      } satisfies TestPart,
    },
  ]) {
    it(name, async () => {
      const messages = [assistant(historyPart), assistant(text("continue"))] satisfies TestMessage[]
      await runTransform(messages)
      expect(messages[1]?.parts).toEqual([text("continue")])
    })
  }

  it("does not reinject when the message already starts with redacted_thinking", async () => {
    const existingLeadingPart = redactedThinking("existing-redacted-thinking")
    const messages = [
      assistant(signedThinking("signed-thinking")),
      assistant(existingLeadingPart, text("continue")),
    ] satisfies TestMessage[]
    await runTransform(messages)
    expect(messages[1]?.parts[0]).toBe(existingLeadingPart)
    expect(messages[1]?.parts).toHaveLength(2)
  })

  for (const createCase of [
    () => {
      const prior = signedThinking("signed-thinking", "prior plan")
      return {
        name: "strips multiple trailing thinking blocks after prepending the missing leading thinking block",
        messages: [
          assistant(prior),
          assistant(
            toolUse(),
            signedThinking("signed-trailing-a", "late thought A"),
            signedThinking("signed-trailing-b", "late thought B"),
          ),
        ] satisfies TestMessage[],
        expected: [prior, toolUse()],
      }
    },
    () => {
      const leading = signedThinking("signed-leading", "keep this leading block")
      return {
        name: "strips the final thinking block but preserves a valid leading thinking block",
        messages: [
          assistant(signedThinking("signed-history", "history")),
          assistant(leading, text("continue"), signedThinking("signed-trailing", "remove this trailing block")),
        ] satisfies TestMessage[],
        expected: [leading, text("continue")],
      }
    },
    () => ({
      name: "strips a thinking-only assistant message before submission",
      messages: [
        assistant(signedThinking("signed-history", "history")),
        assistant(signedThinking("signed-only-thinking", "final trailing thinking")),
      ] satisfies TestMessage[],
      expected: [] as TestPart[],
    }),
  ]) {
    it(createCase().name, async () => {
      const { messages, expected } = createCase()
      await runTransform(messages)
      expect(messages[1]?.parts).toEqual(expected)
    })
  }
})
