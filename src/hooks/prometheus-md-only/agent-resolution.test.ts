import { beforeEach, describe, expect, it, mock } from "bun:test"

const readBoulderStateMock = mock(() => null)
const getSessionAgentMock = mock(() => undefined)
const findFirstMessageWithAgentMock = mock(() => undefined)
const findNearestMessageWithFieldsMock = mock(() => undefined)
const findFirstMessageWithAgentFromSDKMock = mock(async () => undefined)
const findNearestMessageWithFieldsFromSDKMock = mock(async () => undefined)

mock.module("../../features/hook-message-injector", () => ({
  findFirstMessageWithAgent: findFirstMessageWithAgentMock,
  findNearestMessageWithFields: findNearestMessageWithFieldsMock,
  findFirstMessageWithAgentFromSDK: findFirstMessageWithAgentFromSDKMock,
  findNearestMessageWithFieldsFromSDK: findNearestMessageWithFieldsFromSDKMock,
}))

mock.module("../../features/claude-code-session-state", () => ({
  getSessionAgent: getSessionAgentMock,
}))

mock.module("../../features/boulder-state", () => ({
  readBoulderState: readBoulderStateMock,
}))

mock.module("../../shared/opencode-message-dir", () => ({
  getMessageDir: () => null,
}))

mock.module("../../shared/opencode-storage-detection", () => ({
  isSqliteBackend: () => true,
}))

const { getAgentFromSession } = await import("./agent-resolution")

describe("getAgentFromSession", () => {
  beforeEach(() => {
    readBoulderStateMock.mockReset()
    getSessionAgentMock.mockReset()
    findFirstMessageWithAgentMock.mockReset()
    findNearestMessageWithFieldsMock.mockReset()
    findFirstMessageWithAgentFromSDKMock.mockReset()
    findNearestMessageWithFieldsFromSDKMock.mockReset()

    readBoulderStateMock.mockReturnValue(null)
    getSessionAgentMock.mockReturnValue(undefined)
    findFirstMessageWithAgentMock.mockReturnValue(undefined)
    findNearestMessageWithFieldsMock.mockReturnValue(undefined)
    findFirstMessageWithAgentFromSDKMock.mockResolvedValue(undefined)
    findNearestMessageWithFieldsFromSDKMock.mockResolvedValue(undefined)
  })

  it("keeps subagent identity for boulder-tracked child sessions", async () => {
    readBoulderStateMock.mockReturnValue({
      session_ids: ["ses_root", "ses_child"],
      agent: "Atlas (Plan Executor)",
      task_sessions: {},
    })

    const sessionGet = mock(async () => ({
      data: {
        id: "ses_child",
        title: "Strict perf suite audit (@Sisyphus Junior (Focused Executor) subagent)",
        parentID: "ses_root",
      },
    }))

    const result = await getAgentFromSession("ses_child", "/tmp/project", {
      session: { get: sessionGet },
    } as never)

    expect(result).toBe("Sisyphus Junior (Focused Executor)")
    expect(sessionGet).toHaveBeenCalledTimes(1)
  })

  it("prefers explicit boulder task-session agent when present", async () => {
    const sessionGet = mock(async () => ({
      data: {
        id: "ses_child",
        title: "Strict perf suite audit (@Sisyphus Junior (Focused Executor) subagent)",
      },
    }))

    readBoulderStateMock.mockReturnValue({
      session_ids: ["ses_root", "ses_child"],
      agent: "Atlas (Plan Executor)",
      task_sessions: {
        todo_1: {
          task_key: "todo_1",
          task_label: "1",
          task_title: "Strict perf suite audit",
          session_id: "ses_child",
          agent: "Oracle (Strategic Advisor)",
          updated_at: "2026-04-17T00:00:00Z",
        },
      },
    })

    const result = await getAgentFromSession("ses_child", "/tmp/project", {
      session: { get: sessionGet },
    } as never)

    expect(result).toBe("Oracle (Strategic Advisor)")
    expect(sessionGet).not.toHaveBeenCalled()
  })

  it("keeps boulder agent for tracked root execution sessions", async () => {
    readBoulderStateMock.mockReturnValue({
      session_ids: ["ses_root"],
      agent: "Atlas (Plan Executor)",
      task_sessions: {},
    })

    const sessionGet = mock(async () => ({
      data: {
        id: "ses_root",
        title: "oh-my-opencode run",
      },
    }))

    const result = await getAgentFromSession("ses_root", "/tmp/project", {
      session: { get: sessionGet },
    } as never)

    expect(result).toBe("Atlas (Plan Executor)")
    expect(sessionGet).toHaveBeenCalledTimes(1)
  })
})
