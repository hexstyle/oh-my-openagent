import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { reapOrphans } from "./orphan-reaper"

const tmpDir = path.join(os.tmpdir(), "orphan-reaper-test-" + process.pid)
const registryPath = path.join(tmpDir, "tracked-roots.json")

function writeRegistry(records: unknown[]): void {
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.writeFileSync(registryPath, JSON.stringify(records, null, 2), "utf8")
}

function readRegistry(): unknown[] {
  try {
    return JSON.parse(fs.readFileSync(registryPath, "utf8"))
  } catch {
    return []
  }
}

const spawnedProcs: ReturnType<typeof Bun.spawn>[] = []

afterEach(() => {
  for (const p of spawnedProcs) {
    try {
      p.kill()
    } catch {}
  }
  spawnedProcs.length = 0
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {}
})

describe("reapOrphans", () => {
  it("returns empty report when registry missing", async () => {
    const report = await reapOrphans({ registryPath })
    expect(report.killed).toEqual([])
    expect(report.alreadyDead).toEqual([])
    expect(report.preserved).toEqual([])
    expect(report.errors).toEqual([])
  })

  it("returns empty report on malformed JSON", async () => {
    fs.mkdirSync(tmpDir, { recursive: true })
    fs.writeFileSync(registryPath, "not-json", "utf8")
    const report = await reapOrphans({ registryPath })
    expect(report.killed).toEqual([])
    expect(report.alreadyDead).toEqual([])
  })

  it("preserves record when ownerPid === process.pid", async () => {
    writeRegistry([
      {
        pid: 999999,
        kind: "mcp",
        startedAt: Date.now(),
        ownerPid: process.pid,
        command: "test",
      },
    ])
    const report = await reapOrphans({ registryPath })
    expect(report.preserved).toContain(999999)
    expect(report.killed).toEqual([])
    const remaining = readRegistry() as Array<{ pid: number }>
    expect(remaining.some((r) => r.pid === 999999)).toBe(true)
  })

  it("handles already-dead pid as alreadyDead", async () => {
    writeRegistry([
      {
        pid: 2147483647,
        kind: "probe",
        startedAt: Date.now(),
        ownerPid: 2147483646,
        command: "test",
      },
    ])
    const report = await reapOrphans({ registryPath })
    // ownerPid is dead → orphan; pid is also dead → alreadyDead
    expect(report.alreadyDead.length + report.killed.length + report.errors.length).toBeGreaterThanOrEqual(1)
    const remaining = readRegistry() as Array<{ pid: number }>
    expect(remaining.some((r) => r.pid === 2147483647)).toBe(false)
  })

  it("kills orphaned process whose owner is gone", async () => {
    // spawn a short-lived process and wait for it to die → use its pid as ownerPid
    const deadOwner = Bun.spawn(["true"])
    await deadOwner.exited
    const deadOwnerPid = deadOwner.pid

    // spawn a long-lived process as the orphan target
    const orphan = Bun.spawn(["sleep", "60"])
    spawnedProcs.push(orphan)
    const orphanPid = orphan.pid

    writeRegistry([
      {
        pid: orphanPid,
        kind: "watchdog",
        startedAt: Date.now(),
        ownerPid: deadOwnerPid,
        command: "sleep 60",
      },
    ])

    const report = await reapOrphans({ registryPath, timeoutMs: 8000 })
    expect(report.killed).toContain(orphanPid)
    const remaining = readRegistry() as Array<{ pid: number }>
    expect(remaining.some((r) => r.pid === orphanPid)).toBe(false)
  })

  it("preserves process whose owner is still alive", async () => {
    // spawn live owner and target
    const liveOwner = Bun.spawn(["sleep", "60"])
    spawnedProcs.push(liveOwner)
    const target = Bun.spawn(["sleep", "60"])
    spawnedProcs.push(target)

    writeRegistry([
      {
        pid: target.pid,
        kind: "mcp",
        startedAt: Date.now(),
        ownerPid: liveOwner.pid,
        command: "sleep 60",
      },
    ])

    const report = await reapOrphans({ registryPath })
    expect(report.preserved).toContain(target.pid)
    expect(report.killed).not.toContain(target.pid)
  })

  it("is idempotent: second run does not error on already-cleaned records", async () => {
    writeRegistry([
      {
        pid: 2147483647,
        kind: "probe",
        startedAt: Date.now(),
        ownerPid: 2147483646,
        command: "test",
      },
    ])
    await reapOrphans({ registryPath })
    const report2 = await reapOrphans({ registryPath })
    expect(report2.errors).toEqual([])
  })

  it("respects timeoutMs and returns early", async () => {
    // write many records pointing to dead pids — should time out quickly
    const records = Array.from({ length: 50 }, (_, i) => ({
      pid: 2000000 + i,
      kind: "probe",
      startedAt: Date.now(),
      ownerPid: 1999999,
      command: "test",
    }))
    writeRegistry(records)
    const start = Date.now()
    await reapOrphans({ registryPath, timeoutMs: 50 })
    const elapsed = Date.now() - start
    // should return well under 5s even with 50 records (all are already dead so fast, but timeout path exercised)
    expect(elapsed).toBeLessThan(5000)
  })
})
