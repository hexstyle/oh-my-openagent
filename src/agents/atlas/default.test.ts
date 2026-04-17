import { describe, expect, test } from "bun:test"
import { ATLAS_SYSTEM_PROMPT } from "./default"

describe("ATLAS_SYSTEM_PROMPT", () => {
  test("requires evidence-gated completion instead of raw checkbox counting", () => {
    expect(ATLAS_SYSTEM_PROMPT).toContain("checked boxes without required evidence")
    expect(ATLAS_SYSTEM_PROMPT).toContain("Do not declare a task complete from checkbox state alone")
  })
})
