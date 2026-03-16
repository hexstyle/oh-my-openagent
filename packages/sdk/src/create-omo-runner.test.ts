import { beforeEach, describe, expect, it, mock } from "bun:test"
import type { ServerConnection } from "../../../src/cli/run/types"

const mockCreateServerConnection = mock(
  async (): Promise<ServerConnection> => ({
    client: {} as never,
    cleanup: mock(() => {}),
  }),
)

const mockExecuteRunSession = mock(async (_options: unknown) => ({
  exitCode: 0,
  sessionId: "ses_runner",
  result: {
    sessionId: "ses_runner",
    success: true,
    durationMs: 10,
    messageCount: 1,
    summary: "done",
  },
}))

mock.module("../../../src/cli/run/server-connection", () => ({
  createServerConnection: mockCreateServerConnection,
}))

mock.module("../../../src/cli/run/run-engine", () => ({
  executeRunSession: mockExecuteRunSession,
}))

const { createOmoRunner } = await import("./create-omo-runner")

describe("createOmoRunner", () => {
  beforeEach(() => {
    mockCreateServerConnection.mockClear()
    mockExecuteRunSession.mockClear()
  })

  it("reuses the same connection and enables question-aware execution", async () => {
    const runner = createOmoRunner({
      directory: "/repo",
      agent: "atlas",
    })

    const first = await runner.run("first")
    const second = await runner.run("second", { agent: "prometheus" })

    expect(first.summary).toBe("done")
    expect(second.summary).toBe("done")
    expect(mockCreateServerConnection).toHaveBeenCalledTimes(1)
    expect(mockExecuteRunSession).toHaveBeenNthCalledWith(1, expect.objectContaining({
      directory: "/repo",
      agent: "atlas",
      questionPermission: "allow",
      questionToolEnabled: true,
      renderOutput: false,
    }))
    expect(mockExecuteRunSession).toHaveBeenNthCalledWith(2, expect.objectContaining({
      agent: "prometheus",
    }))
    await runner.close()
  })

  it("streams normalized events", async () => {
    mockExecuteRunSession.mockImplementationOnce(async (options: { eventObserver?: { onEvent?: (event: unknown) => Promise<void> } }) => {
      await options.eventObserver?.onEvent?.({
        type: "session.started",
        sessionId: "ses_runner",
        agent: "Atlas (Plan Executor)",
        resumed: false,
      })
      await options.eventObserver?.onEvent?.({
        type: "session.completed",
        sessionId: "ses_runner",
        result: {
          sessionId: "ses_runner",
          success: true,
          durationMs: 10,
          messageCount: 1,
          summary: "done",
        },
      })
      return {
        exitCode: 0,
        sessionId: "ses_runner",
        result: {
          sessionId: "ses_runner",
          success: true,
          durationMs: 10,
          messageCount: 1,
          summary: "done",
        },
      }
    })

    const runner = createOmoRunner({ directory: "/repo" })
    const seenTypes: string[] = []

    for await (const event of runner.stream("stream")) {
      seenTypes.push(event.type)
    }

    expect(seenTypes).toEqual(["session.started", "session.completed"])
    await runner.close()
  })
})
