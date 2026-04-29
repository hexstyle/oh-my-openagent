import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { TrackedRoot } from "./process-tracker"

const DEFAULT_REGISTRY = path.join(os.tmpdir(), "oh-my-openagent", "tracked-roots.json")
const DEFAULT_TIMEOUT_MS = 5000
const SIGKILL_GRACE_MS = 1500

export interface ReapReport {
  killed: number[]
  alreadyDead: number[]
  preserved: number[]
  errors: Array<{ pid: number; error: string }>
}

export interface ReapOptions {
  signal?: AbortSignal
  timeoutMs?: number
  registryPath?: string
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    if (err.code === "ESRCH") return false
    if (err.code === "EPERM") return true
    return false
  }
}

async function killWithGrace(pid: number): Promise<"killed" | "alreadyDead" | "error"> {
  try {
    process.kill(pid, "SIGTERM")
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    if (err.code === "ESRCH") return "alreadyDead"
    return "error"
  }
  await new Promise((r) => setTimeout(r, SIGKILL_GRACE_MS))
  if (!isProcessAlive(pid)) return "killed"
  try {
    process.kill(pid, "SIGKILL")
    return "killed"
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    if (err.code === "ESRCH") return "killed"
    return "error"
  }
}

async function loadRecords(registryPath: string): Promise<TrackedRoot[]> {
  try {
    const raw = await fs.readFile(registryPath, "utf8")
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed as TrackedRoot[]
  } catch {
    return []
  }
}

async function writeRecords(registryPath: string, records: TrackedRoot[]): Promise<void> {
  const tmp = `${registryPath}.tmp`
  await fs.writeFile(tmp, JSON.stringify(records, null, 2), "utf8")
  await fs.rename(tmp, registryPath)
}

export async function reapOrphans(opts?: ReapOptions): Promise<ReapReport> {
  const registryPath = opts?.registryPath ?? DEFAULT_REGISTRY
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const signal = opts?.signal

  const report: ReapReport = { killed: [], alreadyDead: [], preserved: [], errors: [] }
  const deadline = Date.now() + timeoutMs

  const records = await loadRecords(registryPath)
  if (records.length === 0) return report

  const toPreserve: TrackedRoot[] = []

  for (const record of records) {
    if (signal?.aborted || Date.now() >= deadline) break

    const ownerAlive = record.ownerPid === process.pid || isProcessAlive(record.ownerPid)
    if (ownerAlive) {
      report.preserved.push(record.pid)
      toPreserve.push(record)
      continue
    }

    // orphan: owner is gone
    if (!isProcessAlive(record.pid)) {
      report.alreadyDead.push(record.pid)
      continue
    }

    const result = await killWithGrace(record.pid)
    if (result === "killed") {
      report.killed.push(record.pid)
    } else if (result === "alreadyDead") {
      report.alreadyDead.push(record.pid)
    } else {
      report.errors.push({ pid: record.pid, error: "kill failed" })
      toPreserve.push(record)
    }
  }

  try {
    await writeRecords(registryPath, toPreserve)
  } catch {
    // best-effort
  }

  return report
}
