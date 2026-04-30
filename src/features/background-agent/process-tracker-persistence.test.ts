import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { TrackedRoot } from "./process-tracker"
import { loadRoots, persistRoots } from "./process-tracker-persistence"

const REGISTRY_FILE = path.join(os.tmpdir(), "oh-my-openagent", "tracked-roots.json")

function cleanup(): void {
  try {
    fs.rmSync(REGISTRY_FILE)
  } catch {
    // ignore
  }
}

describe("process-tracker-persistence", () => {
  beforeEach(cleanup)
  afterEach(cleanup)

  it("missing file returns empty array", async () => {
    const roots = await loadRoots()
    expect(roots).toEqual([])
  })

  it("corrupted JSON returns empty array", async () => {
    fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true })
    fs.writeFileSync(REGISTRY_FILE, "NOT_JSON", "utf8")
    const roots = await loadRoots()
    expect(roots).toEqual([])
  })

  it("persist and load round-trip preserves records", async () => {
    const sample: TrackedRoot[] = [
      {
        pid: 1234,
        kind: "mcp",
        command: "node server.js",
        startedAt: 1000000,
        ownerPid: process.pid,
        sessionID: "ses_abc",
      },
    ]

    await persistRoots(sample)
    const loaded = await loadRoots()
    expect(loaded).toEqual(sample)
  })

  it("persist overwrites previous data atomically", async () => {
    const first: TrackedRoot[] = [
      { pid: 1, kind: "probe", command: "probe", startedAt: 1, ownerPid: 1 },
    ]
    const second: TrackedRoot[] = [
      { pid: 2, kind: "daemon", command: "daemon", startedAt: 2, ownerPid: 2 },
    ]

    await persistRoots(first)
    await persistRoots(second)

    const loaded = await loadRoots()
    expect(loaded).toEqual(second)
  })

  it("persist with empty array results in empty load", async () => {
    await persistRoots([])
    const loaded = await loadRoots()
    expect(loaded).toEqual([])
  })
})
