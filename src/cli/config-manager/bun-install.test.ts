import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { initConfigContext, resetConfigContext } from "./config-context"
import { runBunInstallWithDetails } from "./bun-install"

describe("bun-install", () => {
  let originalPlatform: NodeJS.Platform

  beforeEach(() => {
    originalPlatform = process.platform
    resetConfigContext()
    initConfigContext("opencode", null)
  })

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform })
    resetConfigContext()
  })

  test("#given Windows with bun.exe on PATH #when runBunInstallWithDetails is called #then uses bun.exe", async () => {
    Object.defineProperty(process, "platform", { value: "win32" })

    const whichSpy = spyOn(Bun, "which")
      .mockImplementation((binary: string) => {
        if (binary === "bun.exe") {
          return "C:\\Tools\\bun.exe"
        }
        return null
      })

    const spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
      exited: Promise.resolve(0),
      exitCode: 0,
      kill: () => {},
    } as unknown as ReturnType<typeof Bun.spawn>)

    try {
      const result = await runBunInstallWithDetails()

      expect(result.success).toBe(true)
      expect(spawnSpy).toHaveBeenCalledTimes(1)
      expect(spawnSpy.mock.calls[0]?.[0]).toEqual(["C:\\Tools\\bun.exe", "install"])
    } finally {
      spawnSpy.mockRestore()
      whichSpy.mockRestore()
    }
  })
})
