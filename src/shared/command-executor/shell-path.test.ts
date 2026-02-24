import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { findBashPath } from "./shell-path"

describe("shell-path", () => {
  let originalPlatform: NodeJS.Platform
  let originalComspec: string | undefined

  beforeEach(() => {
    originalPlatform = process.platform
    originalComspec = process.env.COMSPEC
  })

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform })
    if (originalComspec !== undefined) {
      process.env.COMSPEC = originalComspec
      return
    }
    delete process.env.COMSPEC
  })

  test("#given Windows platform with COMSPEC #when findBashPath is called #then returns COMSPEC path", () => {
    Object.defineProperty(process, "platform", { value: "win32" })
    process.env.COMSPEC = "C:\\Windows\\System32\\cmd.exe"

    const result = findBashPath()

    expect(result).toBe("C:\\Windows\\System32\\cmd.exe")
  })

  test("#given Windows platform without COMSPEC #when findBashPath is called #then returns default cmd path", () => {
    Object.defineProperty(process, "platform", { value: "win32" })
    delete process.env.COMSPEC

    const result = findBashPath()

    expect(result).toBe("C:\\Windows\\System32\\cmd.exe")
  })
})
