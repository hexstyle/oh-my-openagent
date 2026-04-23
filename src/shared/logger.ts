import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { LOG_FILENAME } from "./plugin-identity"

const DEFAULT_MAX_LOG_FILE_BYTES = 10 * 1024 * 1024

function resolveLogFilePath(): string {
  const configuredLogPath = process.env["OH_MY_OPENAGENT_LOG_PATH"]?.trim()
  return configuredLogPath
    ? path.resolve(configuredLogPath)
    : path.join(os.tmpdir(), LOG_FILENAME)
}

function resolveMaxLogFileBytes(): number {
  const configuredMaxLogBytes = Number.parseInt(
    process.env["OH_MY_OPENAGENT_LOG_MAX_BYTES"] ?? "",
    10,
  )
  return Number.isFinite(configuredMaxLogBytes) && configuredMaxLogBytes > 0
    ? configuredMaxLogBytes
    : DEFAULT_MAX_LOG_FILE_BYTES
}

let buffer: string[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
const FLUSH_INTERVAL_MS = 500
const BUFFER_SIZE_LIMIT = 50

function trimBufferToFitLimit(data: Buffer): Buffer {
  const maxLogFileBytes = resolveMaxLogFileBytes()
  if (data.byteLength <= maxLogFileBytes) return data
  return data.subarray(data.byteLength - maxLogFileBytes)
}

function shrinkExistingLogIfNeeded(incomingBytes: number): void {
  const logFile = resolveLogFilePath()
  const maxLogFileBytes = resolveMaxLogFileBytes()
  let stat: fs.Stats
  try {
    stat = fs.statSync(logFile)
  } catch {
    return
  }

  if (!stat.isFile()) return

  const maxExistingBytes = Math.max(0, maxLogFileBytes - incomingBytes)
  if (stat.size <= maxExistingBytes) return

  if (maxExistingBytes === 0) {
    fs.writeFileSync(logFile, "")
    return
  }

  const fd = fs.openSync(logFile, "r")
  try {
    const tail = Buffer.allocUnsafe(maxExistingBytes)
    fs.readSync(fd, tail, 0, maxExistingBytes, stat.size - maxExistingBytes)
    fs.writeFileSync(logFile, tail)
  } finally {
    fs.closeSync(fd)
  }
}

function flush(): void {
  if (buffer.length === 0) return
  const logFile = resolveLogFilePath()
  const data = trimBufferToFitLimit(Buffer.from(buffer.join(""), "utf8"))
  buffer = []
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true })
    shrinkExistingLogIfNeeded(data.byteLength)
    fs.appendFileSync(logFile, data)
  } catch {
  }
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flush()
  }, FLUSH_INTERVAL_MS)
}

export function log(message: string, data?: unknown): void {
  try {
    const timestamp = new Date().toISOString()
    const logEntry = `[${timestamp}] ${message} ${data ? JSON.stringify(data) : ""}\n`
    buffer.push(logEntry)
    if (buffer.length >= BUFFER_SIZE_LIMIT) {
      flush()
    } else {
      scheduleFlush()
    }
  } catch {
  }
}

export function getLogFilePath(): string {
  return resolveLogFilePath()
}

export function flushBufferedLogsForTesting(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  flush()
}

export function resetLoggerForTesting(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  buffer = []
}
