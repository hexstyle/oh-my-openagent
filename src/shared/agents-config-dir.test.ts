import { describe, test, expect } from "bun:test"
import { getAgentsConfigDir } from "./agents-config-dir"

describe("getAgentsConfigDir", () => {
  test("returns path ending with .agents", () => {
    // given agents config dir is requested

    // when getAgentsConfigDir is called
    const result = getAgentsConfigDir()

    // then returns path ending with .agents
    expect(result.endsWith(".agents")).toBe(true)
  })
})
