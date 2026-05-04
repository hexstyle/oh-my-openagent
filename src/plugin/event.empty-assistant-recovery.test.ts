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

  test("recovers and resumes when idle sisyphus CI session ends with a reasoning-only assistant turn", async () => {
    const handler = createHandler([
      {
        info: {
          id: "msg_user_reasoning_only_sisyphus_ci",
          role: "user",
          agent: "Atlas (Plan Executor)",
          model: {
            providerID: "openai",
            modelID: "gpt-5.4",
          },
        },
        parts: [{
          type: "text",
          text: "CI FAST PATH — ACTIVE\nRead only `.sisyphus/evidence/` and update `ci-loop-checkpoint.md` plus `repair-log.md`.",
        }],
      },
      {
        info: {
          id: "msg_reasoning_only_sisyphus_ci",
          role: "assistant",
          agent: "Sisyphus (Ultraworker)",
          finish: "other",
        },
        parts: [
          {
            type: "reasoning",
            text: "I have the live failing set and tracker drift and can now write the evidence updates.",
          },
          {
            type: "step-finish",
            reason: "other",
          },
        ],
      },
    ])

    await handler({
      event: {
        type: "session.status",
        properties: {
          sessionID: "ses_reasoning_only_sisyphus_ci",
          status: { type: "idle" },
        },
      },
    })

    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    expect(promptAsyncMock).toHaveBeenCalledWith({
      path: { id: "ses_reasoning_only_sisyphus_ci" },
      body: expect.objectContaining({
        agent: "Atlas (Plan Executor)",
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
        parts: [
          expect.objectContaining({
            text: expect.stringContaining("evidence-gated CI"),
          }),
        ],
      }),
      query: { directory: "/tmp" },
    })
  })

  test("recovers and resumes when idle sisyphus CI session ends with a pending empty bash tool call", async () => {
    const handler = createHandler([
      {
        info: {
          id: "msg_user_empty_bash_sisyphus_ci",
          role: "user",
          agent: "Atlas (Plan Executor)",
          model: {
            providerID: "openai",
            modelID: "gpt-5.4",
          },
        },
        parts: [{
          type: "text",
          text: "CI FAST PATH — ACTIVE\nCurrent build evidence is on disk; continue the unified edit batch and bounded rerun.",
        }],
      },
      {
        info: {
          id: "msg_empty_bash_sisyphus_ci",
          role: "assistant",
          agent: "Sisyphus (Ultraworker)",
          finish: "tool-calls",
        },
        parts: [
          {
            type: "step-start",
          },
          {
            type: "reasoning",
            text: "I should now run the bounded verify wrapper for the current unified batch.",
          },
          {
            type: "tool",
            tool: "bash",
            raw: "",
            state: { status: "pending", input: {} },
          },
        ],
      },
    ])

    await handler({
      event: {
        type: "session.status",
        properties: {
          sessionID: "ses_empty_bash_sisyphus_ci",
          status: { type: "idle" },
        },
      },
    })

    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    expect(promptAsyncMock).toHaveBeenCalledWith({
      path: { id: "ses_empty_bash_sisyphus_ci" },
      body: expect.objectContaining({
        agent: "Atlas (Plan Executor)",
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
        parts: expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("previous CI tool call was emitted without the required arguments"),
          }),
        ]),
      }),
      query: { directory: "/tmp" },
    })
  })

  test("recovers delayed sisyphus CI reasoning-only turns even when persisted message role is omitted", async () => {
    jest.useFakeTimers()

    const handler = createHandler([
      {
        info: {
          id: "msg_user_reasoning_only_sisyphus_ci_raw",
          role: "user",
          agent: "Atlas (Plan Executor)",
          model: {
            providerID: "openai",
            modelID: "gpt-5.4",
          },
        },
        parts: [{
          type: "text",
          text: "CI FAST PATH — ACTIVE\nCurrent build evidence is on disk; continue the unified edit batch.",
        }],
      },
      {
        id: "msg_reasoning_only_sisyphus_ci_raw",
        agent: "Sisyphus (Ultraworker)",
        parts: [
          {
            type: "step-start",
          },
          {
            type: "reasoning",
            text: "I have the stale plan rebased and should now move into the next constrained edit batch.",
          },
        ],
      },
    ])

    await handler({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_reasoning_only_sisyphus_ci_raw",
            sessionID: "ses_reasoning_only_sisyphus_ci_raw",
            role: "assistant",
            agent: "Sisyphus (Ultraworker)",
          },
        },
      },
    } as const)

    await handler({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part_reasoning_only_sisyphus_ci_raw",
            sessionID: "ses_reasoning_only_sisyphus_ci_raw",
            messageID: "msg_reasoning_only_sisyphus_ci_raw",
            type: "reasoning",
            text: "I have the stale plan rebased and should now move into the next constrained edit batch.",
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

    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    expect(promptAsyncMock).toHaveBeenCalledWith({
      path: { id: "ses_reasoning_only_sisyphus_ci_raw" },
      body: expect.objectContaining({
        agent: "Atlas (Plan Executor)",
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
        parts: expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("evidence-gated CI"),
          }),
        ]),
      }),
      query: { directory: "/tmp" },
    })
  })

  test("recovers delayed sisyphus CI empty-reasoning prelude turns", async () => {
    jest.useFakeTimers()

    const handler = createHandler([
      {
        info: {
          id: "msg_user_empty_reasoning_sisyphus_ci",
          role: "user",
          agent: "Atlas (Plan Executor)",
          model: {
            providerID: "openai",
            modelID: "gpt-5.4",
          },
        },
        parts: [{
          type: "text",
          text: "CI FAST PATH — ACTIVE\nCurrent build evidence is on disk; continue the unified edit batch.",
        }],
      },
      {
        id: "msg_empty_reasoning_sisyphus_ci",
        role: "assistant",
        agent: "Sisyphus Junior (Focused Executor)",
        parts: [
          {
            type: "step-start",
          },
          {
            type: "reasoning",
            text: "",
          },
        ],
      },
    ])

    await handler({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_empty_reasoning_sisyphus_ci",
            sessionID: "ses_empty_reasoning_sisyphus_ci",
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
            id: "part_empty_reasoning_sisyphus_ci",
            sessionID: "ses_empty_reasoning_sisyphus_ci",
            messageID: "msg_empty_reasoning_sisyphus_ci",
            type: "reasoning",
            text: "",
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

    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    expect(promptAsyncMock).toHaveBeenCalledWith({
      path: { id: "ses_empty_reasoning_sisyphus_ci" },
      body: expect.objectContaining({
        agent: "Atlas (Plan Executor)",
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
        parts: expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("evidence-gated CI"),
          }),
        ]),
      }),
      query: { directory: "/tmp" },
    })
  })

  test("recovers delayed sisyphus CI guardrail tool errors into the next concrete step", async () => {
    jest.useFakeTimers()

    const handler = createHandler([
      {
        info: {
          id: "msg_user_guardrail_sisyphus_ci",
          role: "user",
          agent: "Atlas (Plan Executor)",
          model: {
            providerID: "openai",
            modelID: "gpt-5.4",
          },
        },
        parts: [{
          type: "text",
          text: "CI FAST PATH — ACTIVE\nCurrent build evidence is on disk; continue the unified edit batch.",
        }],
      },
      {
        id: "msg_guardrail_tool_error_sisyphus_ci",
        role: "assistant",
        agent: "Sisyphus Junior (Focused Executor)",
        parts: [
          {
            type: "tool",
            tool: "grep",
            state: {
              status: "error",
              error: "[tool-execute-before] Post-dirty-batch exploration budget is exhausted for CI fast-path session ses_guardrail_tool_error_sisyphus_ci. grep would be exploration step 7 since the current dirty-batch inspection.",
            },
          },
        ],
      },
      {
        id: "msg_after_guardrail_tool_error_sisyphus_ci",
        role: "assistant",
        agent: "Sisyphus Junior (Focused Executor)",
        parts: [
          {
            type: "step-start",
          },
          {
            type: "reasoning",
            text: "",
          },
        ],
      },
    ])

    await handler({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_after_guardrail_tool_error_sisyphus_ci",
            sessionID: "ses_guardrail_tool_error_sisyphus_ci",
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
            id: "part_after_guardrail_tool_error_sisyphus_ci",
            sessionID: "ses_guardrail_tool_error_sisyphus_ci",
            messageID: "msg_after_guardrail_tool_error_sisyphus_ci",
            type: "reasoning",
            text: "",
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

    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    expect(promptAsyncMock).toHaveBeenCalledWith({
      path: { id: "ses_guardrail_tool_error_sisyphus_ci" },
      body: expect.objectContaining({
        agent: "Atlas (Plan Executor)",
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
        parts: expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("runtime guard"),
          }),
        ]),
      }),
      query: { directory: "/tmp" },
    })
  })

  test("recovers sisyphus CI guardrail tool errors immediately on the blocked tool turn", async () => {
    const handler = createHandler([
      {
        info: {
          id: "msg_user_guardrail_tool_error_sisyphus_ci_immediate",
          role: "user",
          agent: "Atlas (Plan Executor)",
          model: {
            providerID: "openai",
            modelID: "gpt-5.4",
          },
        },
        parts: [{
          type: "text",
          text: "CI FAST PATH — ACTIVE\nCurrent evidence is in .sisyphus/evidence/ and the unified batch must continue.",
        }],
      },
      {
        id: "msg_guardrail_tool_error_sisyphus_ci_immediate",
        role: "assistant",
        agent: "Sisyphus Junior (Focused Executor)",
        parts: [
          {
            type: "step-start",
          },
          {
            type: "reasoning",
            text: "Let me inspect one more source slice before the rerun.",
          },
          {
            type: "tool",
            tool: "grep",
            state: {
              status: "error",
              input: {
                pattern: "WaitForNavigation",
                path: "/Users/redff00xx/eurochemeopt/Optimizer.PlaywrightTests",
              },
              error: "[tool-execute-before] Post-dirty-batch exploration budget is exhausted for CI fast-path session ses_guardrail_tool_error_sisyphus_ci_immediate.",
            },
          },
        ],
      },
    ])

    await handler({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_guardrail_tool_error_sisyphus_ci_immediate",
            sessionID: "ses_guardrail_tool_error_sisyphus_ci_immediate",
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
            id: "part_guardrail_tool_error_sisyphus_ci_immediate",
            sessionID: "ses_guardrail_tool_error_sisyphus_ci_immediate",
            messageID: "msg_guardrail_tool_error_sisyphus_ci_immediate",
            type: "tool",
            tool: "grep",
            state: {
              status: "error",
              input: {
                pattern: "WaitForNavigation",
                path: "/Users/redff00xx/eurochemeopt/Optimizer.PlaywrightTests",
              },
              error: "[tool-execute-before] Post-dirty-batch exploration budget is exhausted for CI fast-path session ses_guardrail_tool_error_sisyphus_ci_immediate.",
            },
          },
        },
      },
    } as const)

    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    expect(promptAsyncMock).toHaveBeenCalledWith({
      path: { id: "ses_guardrail_tool_error_sisyphus_ci_immediate" },
      body: expect.objectContaining({
        agent: "Atlas (Plan Executor)",
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
        parts: expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("runtime guard"),
          }),
        ]),
      }),
      query: { directory: "/tmp" },
    })
  })

  test("recovers planner CI bootstrap reread guardrails immediately on the blocked tool turn", async () => {
    const handler = createHandler([
      {
        info: {
          id: "msg_user_planner_ci_guardrail_immediate",
          role: "user",
          agent: "Prometheus (Plan Builder)",
          model: {
            providerID: "anthropic",
            modelID: "claude-opus-4-6",
          },
        },
        parts: [{
          type: "text",
          text: "CI FAST PATH — ACTIVE\nThe current CI state is already materialized under .sisyphus/evidence/.",
        }],
      },
      {
        id: "msg_planner_ci_guardrail_immediate",
        role: "assistant",
        agent: "Prometheus (Plan Builder)",
        parts: [
          {
            type: "step-start",
          },
          {
            type: "reasoning",
            text: "Let me read the canonical CI evidence set before delegating the next batch.",
          },
          {
            type: "tool",
            tool: "read",
            state: {
              status: "error",
              input: {
                filePath: "/Users/redff00xx/eurochemeopt/.sisyphus/evidence/ci-loop-checkpoint.md",
              },
              error: "[tool-execute-before] Core CI evidence rereads are blocked for session ses_planner_ci_guardrail_immediate.",
            },
          },
        ],
      },
    ])

    await handler({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_planner_ci_guardrail_immediate",
            sessionID: "ses_planner_ci_guardrail_immediate",
            role: "assistant",
            agent: "Prometheus (Plan Builder)",
          },
        },
      },
    } as const)

    await handler({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part_planner_ci_guardrail_immediate",
            sessionID: "ses_planner_ci_guardrail_immediate",
            messageID: "msg_planner_ci_guardrail_immediate",
            type: "tool",
            tool: "read",
            state: {
              status: "error",
              input: {
                filePath: "/Users/redff00xx/eurochemeopt/.sisyphus/evidence/ci-loop-checkpoint.md",
              },
              error: "[tool-execute-before] Core CI evidence rereads are blocked for session ses_planner_ci_guardrail_immediate.",
            },
          },
        },
      },
    } as const)

    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    const plannerRecoveryCall = promptAsyncMock.mock.calls[0]?.[0] as Record<string, any>
    expect(plannerRecoveryCall?.path).toEqual({ id: "ses_planner_ci_guardrail_immediate" })
    expect(plannerRecoveryCall?.query).toEqual({ directory: "/tmp" })
    expect(plannerRecoveryCall?.body?.agent).toBe("Prometheus (Plan Builder)")
    expect(plannerRecoveryCall?.body?.model?.providerID).toBe("anthropic")
    expect(plannerRecoveryCall?.body?.model?.modelID).toBe("claude-opus-4-6")
    expect(plannerRecoveryCall?.body?.parts?.[0]?.text).toContain("core evidence files")
  })

  test("recovers idle planner CI visible summary turns that stop before delegation", async () => {
    const handler = createHandler([
      {
        info: {
          id: "msg_user_planner_ci_visible_summary",
          role: "user",
          agent: "Prometheus (Plan Builder)",
          model: {
            providerID: "anthropic",
            modelID: "claude-opus-4-6",
          },
        },
        parts: [{
          type: "text",
          text: "CI FAST PATH — ACTIVE\nCurrent CI state is already materialized under .sisyphus/evidence/. Continue the loop.",
        }],
      },
      {
        info: {
          id: "msg_planner_ci_visible_summary",
          role: "assistant",
          agent: "Prometheus (Plan Builder)",
        },
        parts: [
          {
            type: "text",
            text: "Canonical state verified — no plan churn, no rebase needed. Holding strict planner discipline per CI FAST PATH directive.",
          },
        ],
      },
    ])

    await handler({
      event: {
        type: "session.status",
        properties: {
          sessionID: "ses_planner_ci_visible_summary",
          status: { type: "idle" },
        },
      },
    } as const)

    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    const plannerVisibleSummaryCall = promptAsyncMock.mock.calls[0]?.[0] as Record<string, any>
    expect(plannerVisibleSummaryCall?.path).toEqual({ id: "ses_planner_ci_visible_summary" })
    expect(plannerVisibleSummaryCall?.query).toEqual({ directory: "/tmp" })
    expect(plannerVisibleSummaryCall?.body?.agent).toBe("Prometheus (Plan Builder)")
    expect(plannerVisibleSummaryCall?.body?.model?.providerID).toBe("anthropic")
    expect(plannerVisibleSummaryCall?.body?.model?.modelID).toBe("claude-opus-4-6")
    expect(plannerVisibleSummaryCall?.body?.parts?.[0]?.text).toContain("task delegation")
  })

  test("recovers delayed atlas pending empty task calls in ci fast-path", async () => {
    jest.useFakeTimers()

    const handler = createHandler([
      {
        info: {
          id: "msg_user_atlas_pending_task_ci",
          role: "user",
          agent: "Atlas (Plan Executor)",
          model: {
            providerID: "openai",
            modelID: "gpt-5.4",
          },
        },
        parts: [{
          type: "text",
          text: "CI FAST PATH — ACTIVE\nDelegate the unified CI task and continue the current loop.",
        }],
      },
      {
        id: "msg_atlas_pending_task_ci",
        role: "assistant",
        agent: "Atlas (Plan Executor)",
        parts: [
          {
            type: "tool",
            tool: "task",
            raw: "",
            state: { status: "pending", input: {} },
          },
        ],
      },
    ])

    await handler({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_atlas_pending_task_ci",
            sessionID: "ses_atlas_pending_task_ci",
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
            id: "part_atlas_pending_task_ci",
            sessionID: "ses_atlas_pending_task_ci",
            messageID: "msg_atlas_pending_task_ci",
            type: "tool",
            tool: "task",
            raw: "",
            state: { status: "pending", input: {} },
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

    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    expect(promptAsyncMock).toHaveBeenCalledWith({
      path: { id: "ses_atlas_pending_task_ci" },
      body: expect.objectContaining({
        agent: "Atlas (Plan Executor)",
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
        parts: expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("tool call was emitted without the required arguments"),
          }),
        ]),
      }),
      query: { directory: "/tmp" },
    })
  })

  test("recovers idle sisyphus CI visible summary turns after dirty-batch inspection", async () => {
    const handler = createHandler([
      {
        info: {
          id: "msg_user_visible_summary_sisyphus_ci",
          role: "user",
          agent: "Atlas (Plan Executor)",
          model: {
            providerID: "openai",
            modelID: "gpt-5.4",
          },
        },
        parts: [{
          type: "text",
          text: "CI FAST PATH — ACTIVE\nCurrent build evidence is on disk; continue the unified edit batch and bounded rerun.",
        }],
      },
      {
        info: {
          id: "msg_visible_summary_sisyphus_ci",
          role: "assistant",
          agent: "Sisyphus (Ultraworker)",
          finish: "other",
        },
        parts: [
          {
            type: "text",
            text: "I have clear next steps and can proceed. Next I would move into the edit batch and bounded rerun.",
          },
          {
            type: "step-finish",
            reason: "other",
          },
        ],
      },
    ])

    await handler({
      event: {
        type: "session.status",
        properties: {
          sessionID: "ses_visible_summary_sisyphus_ci",
          status: { type: "idle" },
        },
      },
    })

    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    expect(promptAsyncMock).toHaveBeenCalledWith({
      path: { id: "ses_visible_summary_sisyphus_ci" },
      body: expect.objectContaining({
        agent: "Atlas (Plan Executor)",
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
        parts: expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("resume the active evidence-gated CI verify chain now"),
          }),
        ]),
      }),
      query: { directory: "/tmp" },
    })
  })

  test("recovers delayed sisyphus CI pending empty bash tool calls", async () => {
    jest.useFakeTimers()

    const handler = createHandler([
      {
        info: {
          id: "msg_user_empty_bash_sisyphus_ci_delayed",
          role: "user",
          agent: "Atlas (Plan Executor)",
          model: {
            providerID: "openai",
            modelID: "gpt-5.4",
          },
        },
        parts: [{
          type: "text",
          text: "CI FAST PATH — ACTIVE\nCurrent build evidence is on disk; continue the unified edit batch and bounded rerun.",
        }],
      },
      {
        id: "msg_empty_bash_sisyphus_ci_delayed",
        agent: "Sisyphus (Ultraworker)",
        parts: [
          {
            type: "step-start",
          },
          {
            type: "reasoning",
            text: "I should now run the bounded verify wrapper for the current unified batch.",
          },
          {
            type: "tool",
            tool: "bash",
            raw: "",
            state: { status: "pending", input: {} },
          },
        ],
      },
    ])

    await handler({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_empty_bash_sisyphus_ci_delayed",
            sessionID: "ses_empty_bash_sisyphus_ci_delayed",
            role: "assistant",
            agent: "Sisyphus (Ultraworker)",
          },
        },
      },
    } as const)

    await handler({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part_reasoning_empty_bash_sisyphus_ci_delayed",
            sessionID: "ses_empty_bash_sisyphus_ci_delayed",
            messageID: "msg_empty_bash_sisyphus_ci_delayed",
            type: "reasoning",
            text: "I should now run the bounded verify wrapper for the current unified batch.",
          },
        },
      },
    } as const)

    await handler({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part_empty_bash_sisyphus_ci_delayed",
            sessionID: "ses_empty_bash_sisyphus_ci_delayed",
            messageID: "msg_empty_bash_sisyphus_ci_delayed",
            type: "tool",
            tool: "bash",
            raw: "",
            state: { status: "pending", input: {} },
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

    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    expect(promptAsyncMock).toHaveBeenCalledWith({
      path: { id: "ses_empty_bash_sisyphus_ci_delayed" },
      body: expect.objectContaining({
        agent: "Atlas (Plan Executor)",
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
        parts: expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("previous CI tool call was emitted without the required arguments"),
          }),
        ]),
      }),
      query: { directory: "/tmp" },
    })
  })

  test("recovers sisyphus CI aborted tool wrappers and resumes the bounded rerun chain", async () => {
    const handler = createHandler([
      {
        info: {
          id: "msg_user_sisyphus_ci_aborted_wrapper",
          role: "user",
          agent: "Atlas (Plan Executor)",
          model: {
            providerID: "openai",
            modelID: "gpt-5.4",
          },
        },
        parts: [{
          type: "text",
          text: "CI FAST PATH — ACTIVE\nCurrent build evidence is on disk; continue the unified edit batch and bounded rerun.",
        }],
      },
      {
        info: {
          id: "msg_pending_bash_sisyphus_ci_aborted_wrapper",
          role: "assistant",
          agent: "Sisyphus (Ultraworker)",
          finish: "tool-calls",
        },
        parts: [
          {
            type: "step-start",
          },
          {
            type: "reasoning",
            text: "I should now run the bounded verify wrapper for the current unified batch.",
          },
          {
            type: "tool",
            tool: "bash",
            raw: "",
            state: { status: "pending", input: {} },
          },
        ],
      },
      {
        info: {
          id: "msg_aborted_wrapper_sisyphus_ci",
          role: "assistant",
          agent: "Sisyphus (Ultraworker)",
          error: {
            name: "MessageAbortedError",
            message: "Aborted",
          },
        },
        parts: [],
      },
    ])

    await handler({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_aborted_wrapper_sisyphus_ci",
            sessionID: "ses_aborted_wrapper_sisyphus_ci",
            role: "assistant",
            agent: "Sisyphus (Ultraworker)",
            error: {
              name: "MessageAbortedError",
              message: "Aborted",
            },
          },
        },
      },
    } as const)

    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    expect(promptAsyncMock).toHaveBeenCalledWith({
      path: { id: "ses_aborted_wrapper_sisyphus_ci" },
      body: expect.objectContaining({
        agent: "Atlas (Plan Executor)",
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
        parts: expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("previous CI tool call was emitted without the required arguments"),
          }),
        ]),
      }),
      query: { directory: "/tmp" },
    })
  })

  test("recovers sisyphus CI interrupted visible turns and resumes the verify chain", async () => {
    const handler = createHandler([
      {
        info: {
          id: "msg_user_sisyphus_ci_interrupted_visible",
          role: "user",
          agent: "Atlas (Plan Executor)",
          model: {
            providerID: "openai",
            modelID: "gpt-5.4",
          },
        },
        parts: [{
          type: "text",
          text: "CI FAST PATH — ACTIVE\nCurrent build evidence is on disk; continue the unified edit batch and bounded rerun.",
        }],
      },
      {
        info: {
          id: "msg_sisyphus_ci_interrupted_visible",
          role: "assistant",
          agent: "Sisyphus (Ultraworker)",
          finish: "other",
        },
        parts: [
          {
            type: "step-start",
          },
          {
            type: "text",
            text: "Discovery is closed: the dirty five-file batch is LSP-clean and still maps one-to-one onto the four live runtime clusters, so I’m spending the single verify wave on the current batch exactly as requested.",
          },
        ],
      },
    ])

    await handler({
      event: {
        type: "session.status",
        properties: {
          sessionID: "ses_sisyphus_ci_interrupted_visible",
          status: { type: "idle" },
        },
      },
    })

    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    expect(promptAsyncMock).toHaveBeenCalledWith({
      path: { id: "ses_sisyphus_ci_interrupted_visible" },
      body: expect.objectContaining({
        agent: "Atlas (Plan Executor)",
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
        parts: expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("resume the active evidence-gated CI verify chain now"),
          }),
        ]),
      }),
      query: { directory: "/tmp" },
    })
  })

  test("recovers sisyphus CI aborted verify waves after the bounded rerun was already launched", async () => {
    const handler = createHandler([
      {
        info: {
          id: "msg_user_sisyphus_ci_aborted_verify_wave",
          role: "user",
          agent: "Atlas (Plan Executor)",
          model: {
            providerID: "openai",
            modelID: "gpt-5.4",
          },
        },
        parts: [{
          type: "text",
          text: "CI FAST PATH — ACTIVE\nCurrent build evidence is on disk; continue the unified edit batch and bounded rerun.",
        }],
      },
      {
        info: {
          id: "msg_sisyphus_ci_aborted_verify_wave",
          role: "assistant",
          agent: "Sisyphus (Ultraworker)",
          finish: "tool-calls",
        },
        parts: [
          {
            type: "text",
            text: "The wrapper is validated; I am launching the bounded verify wave now.",
          },
          {
            type: "tool",
            tool: "bash",
            raw: "RERUN_START bounded-iteration15\nRERUN_PRECHECK auditing lingering dotnet test, testhost.dll, headless_shell, run-driver processes",
            state: {
              status: "pending",
              input: {
                command: "RERUN_START && RERUN_PRECHECK && /opt/homebrew/opt/dotnet@8/libexec/dotnet test Optimizer.PlaywrightTests/Optimizer.PlaywrightTests.csproj --results-directory Optimizer.PlaywrightTests/TestResults/iteration15",
              },
            },
          },
        ],
      },
      {
        info: {
          id: "msg_sisyphus_ci_aborted_verify_wave_error",
          role: "assistant",
          agent: "Sisyphus (Ultraworker)",
          error: {
            name: "MessageAbortedError",
            message: "Aborted",
          },
        },
        parts: [],
      },
    ])

    await handler({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_sisyphus_ci_aborted_verify_wave_error",
            sessionID: "ses_sisyphus_ci_aborted_verify_wave",
            role: "assistant",
            agent: "Sisyphus (Ultraworker)",
            error: {
              name: "MessageAbortedError",
              message: "Aborted",
            },
          },
        },
      },
    } as const)

    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    expect(promptAsyncMock).toHaveBeenCalledWith({
      path: { id: "ses_sisyphus_ci_aborted_verify_wave" },
      body: expect.objectContaining({
        agent: "Atlas (Plan Executor)",
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
        parts: expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("resume the launched evidence-gated CI verify wave now"),
          }),
        ]),
      }),
      query: { directory: "/tmp" },
    })
  })

  test("recovers delayed sisyphus CI reasoning-only turns even after an internal compaction user message", async () => {
    jest.useFakeTimers()

    const handler = createHandler([
      {
        info: {
          id: "msg_user_reasoning_only_sisyphus_ci_compaction",
          role: "user",
          agent: "Atlas (Plan Executor)",
          model: {
            providerID: "openai",
            modelID: "gpt-5.4",
          },
        },
        parts: [{
          type: "text",
          text: "CI FAST PATH — ACTIVE\nCurrent build evidence is on disk; continue the unified edit batch.",
        }],
      },
      {
        id: "msg_internal_compaction_user",
        role: "user",
        parts: [{
          type: "compaction",
        }],
      },
      {
        id: "msg_reasoning_only_sisyphus_ci_after_compaction",
        role: "assistant",
        agent: "Sisyphus (Ultraworker)",
        parts: [
          {
            type: "step-start",
          },
          {
            type: "reasoning",
            text: "I have the next constrained edit batch ready and should continue with tool work now.",
          },
          {
            type: "text",
            text: "",
          },
        ],
      },
    ])

    await handler({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_reasoning_only_sisyphus_ci_after_compaction",
            sessionID: "ses_reasoning_only_sisyphus_ci_after_compaction",
            role: "assistant",
            agent: "Sisyphus (Ultraworker)",
          },
        },
      },
    } as const)

    await handler({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part_reasoning_only_sisyphus_ci_after_compaction",
            sessionID: "ses_reasoning_only_sisyphus_ci_after_compaction",
            messageID: "msg_reasoning_only_sisyphus_ci_after_compaction",
            type: "reasoning",
            text: "I have the next constrained edit batch ready and should continue with tool work now.",
          },
        },
      },
    } as const)

    await handler({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part_empty_text_only_sisyphus_ci_after_compaction",
            sessionID: "ses_reasoning_only_sisyphus_ci_after_compaction",
            messageID: "msg_reasoning_only_sisyphus_ci_after_compaction",
            type: "text",
            text: "",
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

    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    expect(promptAsyncMock).toHaveBeenCalledWith({
      path: { id: "ses_reasoning_only_sisyphus_ci_after_compaction" },
      body: expect.objectContaining({
        agent: "Atlas (Plan Executor)",
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
        parts: expect.arrayContaining([
          expect.objectContaining({
            text: expect.stringContaining("evidence-gated CI"),
          }),
        ]),
      }),
      query: { directory: "/tmp" },
    })
  })

  test("keeps delayed sisyphus CI recovery armed when reasoning streams through part.delta text", async () => {
    jest.useFakeTimers()

    const handler = createHandler([
      {
        info: {
          id: "msg_user_sisyphus_delta_reasoning",
          role: "user",
          agent: "Atlas (Plan Executor)",
          model: {
            providerID: "openai",
            modelID: "gpt-5.4",
          },
        },
        parts: [{
          type: "text",
          text: "CI FAST PATH — ACTIVE\nContinue the current bounded rerun and evidence-gated CI loop.",
        }],
      },
      {
        info: {
          id: "msg_sisyphus_delta_reasoning",
          role: "assistant",
          agent: "Sisyphus (Ultraworker)",
        },
        parts: [
          { type: "step-start" },
        ],
      },
    ])

    await handler({
      event: {
        type: "message.updated",
        properties: {
          info: {
            id: "msg_sisyphus_delta_reasoning",
            sessionID: "ses_sisyphus_delta_reasoning",
            role: "assistant",
            agent: "Sisyphus (Ultraworker)",
          },
        },
      },
    } as const)

    await handler({
      event: {
        type: "message.part.updated",
        properties: {
          part: {
            id: "part_sisyphus_delta_reasoning_start",
            sessionID: "ses_sisyphus_delta_reasoning",
            messageID: "msg_sisyphus_delta_reasoning",
            type: "step-start",
          },
        },
      },
    } as const)

    await handler({
      event: {
        type: "message.part.delta",
        properties: {
          sessionID: "ses_sisyphus_delta_reasoning",
          messageID: "msg_sisyphus_delta_reasoning",
          delta: {
            text: "I have the current tracker set and should now run the bounded 8-test verify wrapper.",
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

    expect(promptAsyncMock).toHaveBeenCalledTimes(1)
    expect(promptAsyncMock).toHaveBeenCalledWith({
      path: { id: "ses_sisyphus_delta_reasoning" },
      body: expect.objectContaining({
        agent: "Atlas (Plan Executor)",
        model: {
          providerID: "openai",
          modelID: "gpt-5.4",
        },
        parts: expect.any(Array),
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
