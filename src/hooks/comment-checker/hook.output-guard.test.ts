import { describe, it, expect, mock } from "bun:test"

mock.module("./cli-runner", () => ({
  initializeCommentCheckerCli: () => {},
  getCommentCheckerCliPathPromise: () => Promise.resolve("/tmp/fake-comment-checker"),
  isCliPathUsable: () => true,
  processWithCli: async () => {},
  processApplyPatchEditsWithCli: async () => {},
}))

const { createCommentCheckerHooks } = await import("./hook")

describe("comment-checker output guard", () => {
  //#given output.output is undefined
  //#when tool.execute.after is called
  //#then should return without throwing
  it("should not throw when output.output is undefined", async () => {
    const hooks = createCommentCheckerHooks()
    const input = { tool: "Write", sessionID: "ses_test", callID: "call_test" }
    const output = { title: "ok", output: undefined as unknown as string, metadata: {} }

    await expect(hooks["tool.execute.after"](input, output)).resolves.toBeUndefined()
  })
})
