import { afterEach, describe, expect, it, mock } from "bun:test"

describe("run prompt abort recovery", () => {
  afterEach(() => {
    mock.restore()
  })

  it("continues into polling when promptAsync aborts after the launched turn is still busy", async () => {
    // given
    const promptAsync = mock(async () => {
      throw new Error("Aborted")
    })
    const pollForCompletion = mock(async () => 0)
    const cleanup = mock(() => {})

    mock.module("../../plugin-config", () => ({
      loadPluginConfig: mock(() => ({})),
    }))
    mock.module("./agent-resolver", () => ({
      resolveRunAgent: mock(() => "Sisyphus (Ultraworker)"),
      resolveRunPromptAgent: mock(() => "Sisyphus (Ultraworker)"),
    }))
    mock.module("./server-connection", () => ({
      createServerConnection: mock(async () => ({
        client: {
          event: {
            subscribe: mock(async () => ({
              stream: (async function* () {})(),
            })),
          },
          session: {
            promptAsync,
            status: mock(async () => ({
              data: {
                ses_test: { type: "busy" },
              },
            })),
            todo: mock(async () => ({ data: [] })),
            children: mock(async () => ({ data: [] })),
            messages: mock(async () => ({ data: [] })),
          },
        },
        cleanup,
      })),
    }))
    mock.module("./session-resolver", () => ({
      resolveSession: mock(async () => "ses_test"),
    }))
    mock.module("./json-output", () => ({
      createJsonOutputManager: mock(() => null),
    }))
    mock.module("./on-complete-hook", () => ({
      executeOnCompleteHook: mock(async () => {}),
    }))
    mock.module("./model-resolver", () => ({
      resolveRunModel: mock(() => null),
    }))
    mock.module("./poll-for-completion", () => ({
      pollForCompletion,
    }))
    mock.module("./agent-profile-colors", () => ({
      loadAgentProfileColors: mock(async () => ({})),
    }))
    mock.module("./stdin-suppression", () => ({
      suppressRunInput: mock(() => mock(() => {})),
    }))
    mock.module("./timestamp-output", () => ({
      createTimestampedStdoutController: mock(() => ({
        enable: mock(() => {}),
        restore: mock(() => {}),
      })),
    }))

    const { run } = await import(`./runner?prompt-abort-recovery=${Date.now()}-${Math.random()}`)

    // when
    const result = await run({ message: "test" })

    // then
    expect(result).toBe(0)
    expect(promptAsync).toHaveBeenCalledTimes(1)
    expect(pollForCompletion).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalled()
  })
})
