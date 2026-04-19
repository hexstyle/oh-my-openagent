import { afterEach, describe, expect, it } from "bun:test"

import { _peekLspManagerForTesting } from "./lsp-server"

afterEach(async () => {
  const manager = _peekLspManagerForTesting()
  if (manager) {
    await manager.stopAll()
  }
})

describe("lsp manager lazy initialization", () => {
  it("does not instantiate the manager when the tools registry is imported", async () => {
    expect(_peekLspManagerForTesting()).toBeUndefined()

    await import("../index")

    expect(_peekLspManagerForTesting()).toBeUndefined()
  })
})
