import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"

import * as loggerModule from "../../shared/logger"
import * as spawnWithWindowsHideModule from "../../shared/spawn-with-windows-hide"
import { resetConfigContext } from "./config-context"
import { runBunInstallWithDetails } from "./bun-install"

function createProc(
  exitCode: number,
  output?: { stdout?: string; stderr?: string }
): ReturnType<typeof spawnWithWindowsHideModule.spawnWithWindowsHide> {
  return {
    exited: Promise.resolve(exitCode),
    exitCode,
    stdout: output?.stdout ? new Blob([output.stdout]).stream() : undefined,
    stderr: output?.stderr ? new Blob([output.stderr]).stream() : undefined,
    kill: () => {},
  } satisfies ReturnType<typeof spawnWithWindowsHideModule.spawnWithWindowsHide>
}

describe("runBunInstallWithDetails", () => {
  beforeEach(() => {
    process.env.OPENCODE_CONFIG_DIR = "/test/opencode"
    resetConfigContext()
  })

  afterEach(() => {
    resetConfigContext()
    delete process.env.OPENCODE_CONFIG_DIR
  })

  it("inherits install output by default", async () => {
    // given
    const spawnSpy = spyOn(spawnWithWindowsHideModule, "spawnWithWindowsHide").mockReturnValue(createProc(0))

    try {
      // when
      const result = await runBunInstallWithDetails()

      // then
      expect(result).toEqual({ success: true })
      const [_, options] = spawnSpy.mock.calls[0] as Parameters<typeof spawnWithWindowsHideModule.spawnWithWindowsHide>
      expect(options.stdout).toBe("inherit")
      expect(options.stderr).toBe("inherit")
    } finally {
      spawnSpy.mockRestore()
    }
  })

  it("pipes install output when requested", async () => {
    // given
    const spawnSpy = spyOn(spawnWithWindowsHideModule, "spawnWithWindowsHide").mockReturnValue(createProc(0))

    try {
      // when
      const result = await runBunInstallWithDetails({ outputMode: "pipe" })

      // then
      expect(result).toEqual({ success: true })
      const [_, options] = spawnSpy.mock.calls[0] as Parameters<typeof spawnWithWindowsHideModule.spawnWithWindowsHide>
      expect(options.stdout).toBe("pipe")
      expect(options.stderr).toBe("pipe")
    } finally {
      spawnSpy.mockRestore()
    }
  })

  it("logs captured output when piped install fails", async () => {
    // given
    const spawnSpy = spyOn(spawnWithWindowsHideModule, "spawnWithWindowsHide").mockReturnValue(
      createProc(1, {
        stdout: "resolved 10 packages",
        stderr: "network error",
      })
    )
    const logSpy = spyOn(loggerModule, "log").mockImplementation(() => {})

    try {
      // when
      const result = await runBunInstallWithDetails({ outputMode: "pipe" })

      // then
      expect(result).toEqual({
        success: false,
        error: "bun install failed with exit code 1",
      })
      expect(logSpy).toHaveBeenCalledWith("[bun-install] Captured output from failed bun install", {
        stdout: "resolved 10 packages",
        stderr: "network error",
      })
    } finally {
      logSpy.mockRestore()
      spawnSpy.mockRestore()
    }
  })
})
