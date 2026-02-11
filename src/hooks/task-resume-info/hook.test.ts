import { describe, it, expect } from "bun:test"
import { createTaskResumeInfoHook } from "./hook"

describe("createTaskResumeInfoHook", () => {
  describe("tool.execute.after", () => {
    //#given output.output is undefined
    //#when tool.execute.after is called
    //#then should return without throwing
    it("should not throw when output.output is undefined", async () => {
      const hook = createTaskResumeInfoHook()
      const input = { tool: "Task", sessionID: "ses_test", callID: "call_test" }
      const output = { title: "Result", output: undefined as unknown as string, metadata: {} }

      await expect(hook["tool.execute.after"](input, output)).resolves.toBeUndefined()
    })
  })
})
