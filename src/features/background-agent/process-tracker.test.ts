import { afterEach, describe, expect, it } from "bun:test"
import { ProcessTracker } from "./process-tracker"

describe("ProcessTracker", () => {
  let tracker: ProcessTracker

  afterEach(() => {
    tracker.clear()
  })

  it("register returns full record with ownerPid and startedAt", () => {
    tracker = new ProcessTracker()
    const before = Date.now()
    const root = tracker.register({ pid: 12345, kind: "mcp", command: "node server.js" })
    const after = Date.now()

    expect(root.pid).toBe(12345)
    expect(root.kind).toBe("mcp")
    expect(root.command).toBe("node server.js")
    expect(root.ownerPid).toBe(process.pid)
    expect(root.startedAt).toBeGreaterThanOrEqual(before)
    expect(root.startedAt).toBeLessThanOrEqual(after)
  })

  it("listTrackedRoots reflects registrations", () => {
    tracker = new ProcessTracker()
    tracker.register({ pid: 1001, kind: "watchdog", command: "watchdog" })
    tracker.register({ pid: 1002, kind: "probe", command: "probe" })

    const list = tracker.listTrackedRoots()
    expect(list).toHaveLength(2)
    expect(list.map((r) => r.pid).sort()).toEqual([1001, 1002])
  })

  it("markExited removes the record", () => {
    tracker = new ProcessTracker()
    tracker.register({ pid: 2000, kind: "daemon", command: "daemon" })
    expect(tracker.size()).toBe(1)

    tracker.markExited(2000)
    expect(tracker.size()).toBe(0)
    expect(tracker.listTrackedRoots()).toHaveLength(0)
  })

  it("markExited on unknown pid is a no-op", () => {
    tracker = new ProcessTracker()
    expect(() => tracker.markExited(99999)).not.toThrow()
  })

  it("size returns correct count", () => {
    tracker = new ProcessTracker()
    expect(tracker.size()).toBe(0)
    tracker.register({ pid: 3001, kind: "test", command: "test" })
    expect(tracker.size()).toBe(1)
    tracker.clear()
    expect(tracker.size()).toBe(0)
  })

  it("killTrackedRoot on already-exited PID does not throw", async () => {
    tracker = new ProcessTracker()
    await expect(tracker.killTrackedRoot(999999)).resolves.toBeUndefined()
  })

  it("killTrackedRoot on a live process kills it", async () => {
    tracker = new ProcessTracker()
    const proc = Bun.spawn(["sleep", "60"])
    const pid = proc.pid
    tracker.register({ pid, kind: "test", command: "sleep 60" })

    await tracker.killTrackedRoot(pid)

    expect(tracker.size()).toBe(0)
    // Verify the process is dead
    let alive = true
    try {
      process.kill(pid, 0)
    } catch {
      alive = false
    }
    expect(alive).toBe(false)
  }, 10000)
})
