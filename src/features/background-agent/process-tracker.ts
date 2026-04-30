import { killTrackedRoot, killTrackedTree } from "./process-tracker-kill"
import { loadRoots, persistRoots } from "./process-tracker-persistence"

export type TrackedRootKind = "mcp" | "watchdog" | "probe" | "daemon" | "test"

export interface TrackedRoot {
  pid: number
  pgid?: number
  kind: TrackedRootKind
  sessionID?: string
  startedAt: number
  ownerPid: number
  command: string
}

export class ProcessTracker {
  private roots: Map<number, TrackedRoot> = new Map()

  register(root: Omit<TrackedRoot, "ownerPid" | "startedAt">): TrackedRoot {
    const record: TrackedRoot = {
      ...root,
      ownerPid: process.pid,
      startedAt: Date.now(),
    }
    this.roots.set(record.pid, record)
    void this.flush()
    return record
  }

  markExited(pid: number): void {
    if (this.roots.delete(pid)) {
      void this.flush()
    }
  }

  async killTrackedRoot(pid: number): Promise<void> {
    await killTrackedRoot(pid)
    this.roots.delete(pid)
    void this.flush()
  }

  async killTrackedTree(pid: number): Promise<void> {
    const root = this.roots.get(pid)
    const pgid = root?.pgid ?? pid
    await killTrackedTree(pgid)
    this.roots.delete(pid)
    void this.flush()
  }

  listTrackedRoots(): TrackedRoot[] {
    return Array.from(this.roots.values())
  }

  async loadPersistedRoots(): Promise<TrackedRoot[]> {
    return loadRoots()
  }

  size(): number {
    return this.roots.size
  }

  clear(): void {
    this.roots.clear()
    void this.flush()
  }

  private async flush(): Promise<void> {
    await persistRoots(this.listTrackedRoots())
  }
}
