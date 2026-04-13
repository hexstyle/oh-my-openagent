import { describe, expect, it } from "bun:test"
import { createToolExecuteAfterHandler } from "./tool-execute-after"

describe("createToolExecuteAfterHandler", () => {
  it("#given truncator changes output #when tool.execute.after runs #then claudeCodeHooks receives truncated output", async () => {
    const callOrder: string[] = []
    let claudeSawOutput = ""

    const handler = createToolExecuteAfterHandler({
      ctx: { directory: "/repo" } as never,
      hooks: {
        toolOutputTruncator: {
          "tool.execute.after": async (_input, output) => {
            callOrder.push("truncator")
            output.output = "truncated output"
          },
        },
        claudeCodeHooks: {
          "tool.execute.after": async (_input, output) => {
            callOrder.push("claude")
            claudeSawOutput = output.output
          },
        },
      } as never,
    })

    await handler(
      { tool: "hashline_edit", sessionID: "ses_test", callID: "call_test" },
      { title: "result", output: "original output", metadata: {} }
    )

    expect(callOrder).toEqual(["truncator", "claude"])
    expect(claudeSawOutput).toBe("truncated output")
  })

  it("#given a normal tool and a throwing post-hook #when tool.execute.after runs #then the tool result is not aborted", async () => {
    const handler = createToolExecuteAfterHandler({
      ctx: { directory: "/repo" } as never,
      hooks: {
        toolOutputTruncator: {
          "tool.execute.after": async () => {
            throw new Error("post-hook exploded")
          },
        },
      } as never,
    })

    const output = {
      title: "result",
      output: "original output",
      metadata: {},
    }

    const run = handler(
      { tool: "hashline_edit", sessionID: "ses_test", callID: "call_test" },
      output,
    )

    await expect(run).resolves.toBeUndefined()
    expect(output).toEqual({
      title: "result",
      output: "original output",
      metadata: {},
    })
  })

  it("#given extract output and a throwing post-hook #when tool.execute.after runs #then the original extract output is preserved", async () => {
    const handler = createToolExecuteAfterHandler({
      ctx: { directory: "/repo" } as never,
      hooks: {
        toolOutputTruncator: {
          "tool.execute.after": async (_input, output) => {
            output.output = "mutated output"
            throw new Error("post-hook exploded")
          },
        },
      } as never,
    })

    const output = {
      title: "extract result",
      output: "original extract output",
      metadata: { source: "extract" },
    }

    await expect(
      handler(
        { tool: "extract", sessionID: "ses_test", callID: "call_test" },
        output,
      )
    ).resolves.toBeUndefined()

    expect(output).toEqual({
      title: "extract result",
      output: "original extract output",
      metadata: { source: "extract" },
    })
  })
})
