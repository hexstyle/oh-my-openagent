import { describe, expect, it } from "bun:test"
import { killTrackedRoot, killTrackedTree } from "./process-tracker-kill"

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("killTrackedRoot", () => {
  it("does not throw on already-dead PID (idempotent)", async () => {
    await expect(killTrackedRoot(999999)).resolves.toBeUndefined()
  })

  it("kills a live process", async () => {
    const proc = Bun.spawn(["sleep", "60"])
    const pid = proc.pid
    expect(isAlive(pid)).toBe(true)

    await killTrackedRoot(pid)

    expect(isAlive(pid)).toBe(false)
  }, 10000)

  it("calling twice on same dead PID does not throw", async () => {
    const proc = Bun.spawn(["sleep", "60"])
    const pid = proc.pid

    await killTrackedRoot(pid)
    await expect(killTrackedRoot(pid)).resolves.toBeUndefined()
  }, 10000)
})

describe("killTrackedTree", () => {
  it("does not throw on non-existent pgid (idempotent)", async () => {
    await expect(killTrackedTree(999999)).resolves.toBeUndefined()
  })
})
