import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const loggerSpecifier = import.meta.resolve("./logger")

async function importLoggerWithEnv(logFilePath: string, maxBytes: number) {
  process.env["OH_MY_OPENAGENT_LOG_PATH"] = logFilePath
  process.env["OH_MY_OPENAGENT_LOG_MAX_BYTES"] = String(maxBytes)
  const logger = await import(`${loggerSpecifier}?test=${Date.now()}-${Math.random()}`)
  logger.resetLoggerForTesting()
  return logger
}

afterEach(() => {
  delete process.env["OH_MY_OPENAGENT_LOG_PATH"]
  delete process.env["OH_MY_OPENAGENT_LOG_MAX_BYTES"]
})

describe("shared/logger", () => {
  test("uses the configured log path override", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), `omo-logger-${randomUUID()}`))
    try {
      const logFilePath = join(tempDir, "nested", "custom.log")
      const logger = await importLoggerWithEnv(logFilePath, 1024)

      expect(logger.getLogFilePath()).toBe(logFilePath)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test("shrinks an oversized existing log before appending new data", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), `omo-logger-${randomUUID()}`))
    try {
      const logFilePath = join(tempDir, "nested", "oh-my-opencode.log")
      mkdirSync(dirname(logFilePath), { recursive: true })
      writeFileSync(logFilePath, `${"A".repeat(200)}KEEP-OLD-TAIL`)

      const logger = await importLoggerWithEnv(logFilePath, 120)
      logger.log("fresh-entry")
      logger.flushBufferedLogsForTesting()

      const fileContents = readFileSync(logFilePath, "utf8")
      expect(fileContents).toContain("KEEP-OLD-TAIL")
      expect(fileContents).toContain("fresh-entry")
      expect(statSync(logFilePath).size).toBeLessThanOrEqual(120)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  test("caps a single oversized log entry to the configured file limit", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), `omo-logger-${randomUUID()}`))
    try {
      const logFilePath = join(tempDir, "oh-my-opencode.log")
      const logger = await importLoggerWithEnv(logFilePath, 96)

      logger.log("oversized-entry", {
        payload: "x".repeat(512),
      })
      logger.flushBufferedLogsForTesting()

      expect(statSync(logFilePath).size).toBeLessThanOrEqual(96)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
