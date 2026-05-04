declare const require: (name: string) => any
const { describe, expect, test } = require("bun:test")
import { extractResumeConfig, findLastUserMessage, resumeSession } from "./resume"
import { OMO_INTERNAL_INITIATOR_MARKER } from "../../shared/internal-initiator-marker"
import type { MessageData } from "./types"

describe("session-recovery resume", () => {
  test("extractResumeConfig carries tools from last user message", () => {
    // given
    const userMessage: MessageData = {
      info: {
        agent: "Hephaestus",
        model: { providerID: "openai", modelID: "gpt-5.3-codex" },
        tools: { question: false, bash: true },
      },
    }

    // when
    const config = extractResumeConfig(userMessage, "ses_resume_tools")

    // then
    expect(config.tools).toEqual({ question: false, bash: true })
  })

  test("resumeSession sends inherited tools with continuation prompt", async () => {
    // given
    let promptInput: Record<string, unknown> | undefined
    const client = {
      session: {
        promptAsync: async (input: Record<string, unknown>) => {
          promptInput = input
          return {}
        },
      },
    }

    // when
    const ok = await resumeSession(client as never, {
      sessionID: "ses_resume_prompt",
      directory: "/tmp/resume",
      agent: "Hephaestus",
      model: { providerID: "openai", modelID: "gpt-5.3-codex" },
      tools: { question: false, bash: true },
    })

    // then
    expect(ok).toBe(true)
    expect(promptInput?.query).toEqual({ directory: "/tmp/resume" })
    const promptBody = promptInput?.body as Record<string, unknown> | undefined
    expect(promptBody?.agent).toBe("Hephaestus (Deep Agent)")
    expect(promptBody?.tools).toEqual({ question: false, bash: true })
    expect(Array.isArray(promptBody?.parts)).toBe(true)
    const firstPart = (promptBody?.parts as Array<{ text?: string }>)?.[0]
    expect(firstPart?.text).toContain(OMO_INTERNAL_INITIATOR_MARKER)
  })

  test("resumeSession normalizes the reserved explore display name back to the runtime key", async () => {
    // given
    let promptBody: Record<string, unknown> | undefined
    const client = {
      session: {
        promptAsync: async (input: { body: Record<string, unknown> }) => {
          promptBody = input.body
          return {}
        },
      },
    }

    // when
    const ok = await resumeSession(client as never, {
      sessionID: "ses_resume_explore",
      agent: "Explore (Code Search)",
      model: undefined,
      tools: undefined,
    })

    // then
    expect(ok).toBe(true)
    expect(promptBody?.agent).toBe("explore")
  })

  test("resumeSession falls back to prompt when promptAsync fails", async () => {
    // given
    const promptCalls: Array<Record<string, unknown>> = []
    const client = {
      session: {
        promptAsync: async () => {
          throw new Error("server is disposing")
        },
        prompt: async (input: Record<string, unknown>) => {
          promptCalls.push(input)
          return {}
        },
      },
    }

    // when
    const ok = await resumeSession(client as never, {
      sessionID: "ses_resume_prompt_fallback",
      directory: "/tmp/resume-fallback",
      agent: "Prometheus (Plan Builder)",
      model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
      tools: { write: true, read: true },
      continuationText: "[recovered]",
    })

    // then
    expect(ok).toBe(true)
    expect(promptCalls).toHaveLength(1)
    expect(promptCalls[0]?.query).toEqual({ directory: "/tmp/resume-fallback" })
    const promptBody = promptCalls[0]?.body as Record<string, unknown> | undefined
    expect(promptBody?.agent).toBe("Prometheus (Plan Builder)")
    expect(promptBody?.tools).toEqual({ write: true, read: true })
  })

  test("resumeSession retries with the runtime agent key when the display-name agent is not resolvable", async () => {
    // given
    const promptAsyncCalls: Array<Record<string, unknown>> = []
    const client = {
      session: {
        promptAsync: async (input: Record<string, unknown>) => {
          promptAsyncCalls.push(input)
          const promptBody = input.body as { agent?: string } | undefined
          if (promptBody?.agent === "Prometheus (Plan Builder)") {
            throw new Error('default agent "Prometheus (Plan Builder)" not found')
          }
          return {}
        },
      },
    }

    // when
    const ok = await resumeSession(client as never, {
      sessionID: "ses_resume_agent_key_retry",
      directory: "/tmp/agent-key-retry",
      agent: "Prometheus (Plan Builder)",
      model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
      tools: { write: true, read: true },
    })

    // then
    expect(ok).toBe(true)
    expect(promptAsyncCalls).toHaveLength(2)
    expect((promptAsyncCalls[0]?.body as { agent?: string } | undefined)?.agent).toBe("Prometheus (Plan Builder)")
    expect((promptAsyncCalls[1]?.body as { agent?: string } | undefined)?.agent).toBe("prometheus")
  })

  test("resumeSession retries promptAsync while the session is still busy after abort", async () => {
    // given
    const promptAsyncCalls: Array<Record<string, unknown>> = []
    const client = {
      session: {
        promptAsync: async (input: Record<string, unknown>) => {
          promptAsyncCalls.push(input)
          if (promptAsyncCalls.length < 3) {
            throw new Error("session is not idle yet after abort")
          }
          return {}
        },
      },
    }

    // when
    const ok = await resumeSession(client as never, {
      sessionID: "ses_resume_retry_after_abort",
      directory: "/tmp/retry-after-abort",
      agent: "Prometheus (Plan Builder)",
      model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
      tools: { write: true, read: true },
      continuationText: "[recovered after abort]",
    })

    // then
    expect(ok).toBe(true)
    expect(promptAsyncCalls).toHaveLength(3)
    expect(promptAsyncCalls[0]?.query).toEqual({ directory: "/tmp/retry-after-abort" })
  })

  test("resumeSession tolerates a longer busy-after-abort window before retry succeeds", async () => {
    // given
    const promptAsyncCalls: Array<Record<string, unknown>> = []
    const client = {
      session: {
        promptAsync: async (input: Record<string, unknown>) => {
          promptAsyncCalls.push(input)
          if (promptAsyncCalls.length < 9) {
            throw new Error("session is not idle yet after abort")
          }
          return {}
        },
      },
    }

    // when
    const ok = await resumeSession(client as never, {
      sessionID: "ses_resume_long_retry_after_abort",
      directory: "/tmp/long-retry-after-abort",
      agent: "Prometheus (Plan Builder)",
      model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
      tools: { write: true, read: true },
      continuationText: "[recovered after a long abort window]",
    })

    // then
    expect(ok).toBe(true)
    expect(promptAsyncCalls).toHaveLength(9)
    expect(promptAsyncCalls[0]?.query).toEqual({ directory: "/tmp/long-retry-after-abort" })
  })

  test("resumeSession retries when the SDK throws a plain object busy error after abort", async () => {
    // given
    const promptAsyncCalls: Array<Record<string, unknown>> = []
    const client = {
      session: {
        promptAsync: async (input: Record<string, unknown>) => {
          promptAsyncCalls.push(input)
          if (promptAsyncCalls.length < 4) {
            throw {
              data: { message: "session is not idle yet after abort" },
            }
          }
          return {}
        },
      },
    }

    // when
    const ok = await resumeSession(client as never, {
      sessionID: "ses_resume_object_retry_after_abort",
      directory: "/tmp/object-retry-after-abort",
      agent: "Prometheus (Plan Builder)",
      model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
      tools: { write: true, read: true },
      continuationText: "[recovered after object abort error]",
    })

    // then
    expect(ok).toBe(true)
    expect(promptAsyncCalls).toHaveLength(4)
    expect(promptAsyncCalls[0]?.query).toEqual({ directory: "/tmp/object-retry-after-abort" })
  })

  test("resumeSession succeeds against clients that require query.directory on recovery prompts", async () => {
    // given
    const promptAsyncCalls: Array<Record<string, unknown>> = []
    const client = {
      session: {
        promptAsync: async (input: Record<string, unknown>) => {
          promptAsyncCalls.push(input)
          const query = input.query as { directory?: string } | undefined
          if (!query?.directory) {
            throw new Error("directory required")
          }
          return {}
        },
      },
    }

    // when
    const ok = await resumeSession(client as never, {
      sessionID: "ses_resume_requires_directory",
      directory: "/tmp/requires-directory",
      agent: "Prometheus (Plan Builder)",
      model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
    })

    // then
    expect(ok).toBe(true)
    expect(promptAsyncCalls).toHaveLength(1)
    expect(promptAsyncCalls[0]?.query).toEqual({ directory: "/tmp/requires-directory" })
  })

  test("findLastUserMessage supports raw SDK message shape", () => {
    // given
    const messages = [
      {
        role: "assistant",
        agent: "Prometheus (Plan Builder)",
      },
      {
        role: "user",
        agent: "Prometheus (Plan Builder)",
        providerID: "anthropic",
        modelID: "claude-opus-4-6",
      },
    ] as MessageData[]

    // when
    const result = findLastUserMessage(messages)

    // then
    expect(result).toBe(messages[1])
  })

  test("extractResumeConfig supports raw SDK message shape", () => {
    // given
    const userMessage = {
      agent: "Prometheus (Plan Builder)",
      providerID: "anthropic",
      modelID: "claude-opus-4-6",
      tools: { write: true, read: true },
    } as MessageData

    // when
    const config = extractResumeConfig(userMessage, "ses_resume_raw")

    // then
    expect(config.agent).toBe("Prometheus (Plan Builder)")
    expect(config.model).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-4-6",
    })
    expect(config.tools).toEqual({ write: true, read: true })
  })
})
