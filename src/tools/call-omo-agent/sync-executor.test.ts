const { describe, test, expect, mock, beforeEach, afterEach } = require("bun:test")

const realCompletionPoller = require("./completion-poller")
const realMessageProcessor = require("./message-processor")

const waitForCompletionMock = mock(async () => {})
const processMessagesMock = mock(async () => "agent response")

beforeEach(() => {
  waitForCompletionMock.mockClear()
  processMessagesMock.mockClear()

  mock.module("./completion-poller", () => ({
    waitForCompletion: waitForCompletionMock,
  }))

  mock.module("./message-processor", () => ({
    processMessages: processMessagesMock,
  }))
})

afterEach(() => {
  mock.module("./completion-poller", () => ({ ...realCompletionPoller }))
  mock.module("./message-processor", () => ({ ...realMessageProcessor }))
})

describe("executeSync", () => {
  test("passes question=false via tools parameter to block question tool", async () => {
    //#given
    const { executeSync } = require("./sync-executor")

    let promptArgs: any
    const promptAsync = mock(async (input: any) => {
      promptArgs = input
      return { data: {} }
    })

    const args = {
      subagent_type: "explore",
      description: "test task",
      prompt: "find something",
      session_id: "ses-test-123",
    }

    const toolContext = {
      sessionID: "parent-session",
      messageID: "msg-1",
      agent: "sisyphus",
      abort: new AbortController().signal,
      metadata: mock(async () => {}),
    }

    const ctx = {
      client: {
        session: {
          promptAsync,
          get: mock(async () => ({ data: { id: "ses-test-123" } })),
        },
      },
    }

    //#when
    await executeSync(args, toolContext, ctx as any)

    //#then
    expect(promptAsync).toHaveBeenCalled()
    expect(promptArgs.body.tools.question).toBe(false)
  })

  test("passes task=false via tools parameter", async () => {
    //#given
    const { executeSync } = require("./sync-executor")

    let promptArgs: any
    const promptAsync = mock(async (input: any) => {
      promptArgs = input
      return { data: {} }
    })

    const args = {
      subagent_type: "librarian",
      description: "search docs",
      prompt: "find docs",
      session_id: "ses-test-123",
    }

    const toolContext = {
      sessionID: "parent-session",
      messageID: "msg-2",
      agent: "sisyphus",
      abort: new AbortController().signal,
      metadata: mock(async () => {}),
    }

    const ctx = {
      client: {
        session: {
          promptAsync,
          get: mock(async () => ({ data: { id: "ses-test-123" } })),
        },
      },
    }

    //#when
    await executeSync(args, toolContext, ctx as any)

    //#then
    expect(promptAsync).toHaveBeenCalled()
    expect(promptArgs.body.tools.task).toBe(false)
  })
})
