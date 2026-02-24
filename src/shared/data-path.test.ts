import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"
import { getCacheDir, getDataDir } from "./data-path"

describe("data-path", () => {
  let originalPlatform: NodeJS.Platform
  let originalEnv: Record<string, string | undefined>

  beforeEach(() => {
    originalPlatform = process.platform
    originalEnv = {
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      APPDATA: process.env.APPDATA,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    }
  })

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform })
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value !== undefined) {
        process.env[key] = value
      } else {
        delete process.env[key]
      }
    }
  })

  test("#given Windows with LOCALAPPDATA #when getDataDir is called #then returns LOCALAPPDATA", () => {
    Object.defineProperty(process, "platform", { value: "win32" })
    process.env.LOCALAPPDATA = "C:\\Users\\TestUser\\AppData\\Local"

    const result = getDataDir()

    expect(result).toBe("C:\\Users\\TestUser\\AppData\\Local")
  })

  test("#given Windows without LOCALAPPDATA #when getDataDir is called #then falls back to AppData Local", () => {
    Object.defineProperty(process, "platform", { value: "win32" })
    delete process.env.LOCALAPPDATA

    const result = getDataDir()

    expect(result).toBe(join(homedir(), "AppData", "Local"))
  })

  test("#given Windows with LOCALAPPDATA #when getCacheDir is called #then returns Local cache path", () => {
    Object.defineProperty(process, "platform", { value: "win32" })
    process.env.LOCALAPPDATA = "C:\\Users\\TestUser\\AppData\\Local"

    const result = getCacheDir()

    expect(result).toBe(join("C:\\Users\\TestUser\\AppData\\Local", "cache"))
  })
})
