import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it, spyOn } from "bun:test"
import * as fs from "node:fs"

describe("spawnProcess", () => {
  it("augments csharp-ls with dotnet@8 when available", async () => {
    const existsSpy = spyOn(fs, "existsSync").mockImplementation((pathLike: fs.PathLike) => {
      return String(pathLike) === "/opt/homebrew/opt/dotnet@8/libexec"
    })

    try {
      const { augmentEnvForLspCommand } = await import("./lsp-process")

      const env = augmentEnvForLspCommand(
        ["csharp-ls"],
        { PATH: "/usr/bin:/bin", DOTNET_ROOT: "/opt/homebrew/Cellar/dotnet/10.0.107/libexec" },
      )

      expect(env.DOTNET_ROOT).toBe("/opt/homebrew/Cellar/dotnet/10.0.107/libexec")
      expect(env.PATH?.startsWith("/opt/homebrew/opt/dotnet@8/libexec:")).toBe(true)
    } finally {
      existsSpy.mockRestore()
    }
  })

  it("sets DOTNET_ROOT for csharp-ls when dotnet@8 is available and unset", async () => {
    const existsSpy = spyOn(fs, "existsSync").mockImplementation((pathLike: fs.PathLike) => {
      return String(pathLike) === "/opt/homebrew/opt/dotnet@8/libexec"
    })

    try {
      const { augmentEnvForLspCommand } = await import("./lsp-process")

      const env = augmentEnvForLspCommand(["csharp-ls"], { PATH: "/usr/bin:/bin" })

      expect(env.DOTNET_ROOT).toBe("/opt/homebrew/opt/dotnet@8/libexec")
      expect(env.PATH?.split(":")[0]).toBe("/opt/homebrew/opt/dotnet@8/libexec")
    } finally {
      existsSpy.mockRestore()
    }
  })

  it("does not augment non-csharp lsp commands", async () => {
    const { augmentEnvForLspCommand } = await import("./lsp-process")
    const env = { PATH: "/usr/bin:/bin" }

    expect(augmentEnvForLspCommand(["typescript-language-server", "--stdio"], env)).toEqual(env)
  })

  it("proceeds to node spawn on Windows when command is available", async () => {
    //#given
    const originalPlatform = process.platform
    const rootDir = mkdtempSync(join(tmpdir(), "lsp-process-test-"))
    const childProcess = await import("node:child_process")
    const nodeSpawnSpy = spyOn(childProcess, "spawn")

    try {
      Object.defineProperty(process, "platform", { value: "win32" })
      const { spawnProcess } = await import("./lsp-process")

      //#when
      let result: ReturnType<typeof spawnProcess> | null = null
      expect(() => {
        result = spawnProcess(["node", "--version"], {
          cwd: rootDir,
          env: process.env,
        })
      }).not.toThrow(/Binary 'node' not found/)

      //#then
      expect(nodeSpawnSpy).toHaveBeenCalled()
      expect(result).not.toBeNull()
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform })
      nodeSpawnSpy.mockRestore()
      rmSync(rootDir, { recursive: true, force: true })
    }
  })
})
