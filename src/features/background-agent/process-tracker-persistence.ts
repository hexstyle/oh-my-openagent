import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { log } from "../../shared"
import type { TrackedRoot } from "./process-tracker"

const REGISTRY_DIR = path.join(os.tmpdir(), "oh-my-openagent")
const REGISTRY_FILE = path.join(REGISTRY_DIR, "tracked-roots.json")
let writeCounter = 0

function ensureDir(): void {
  if (!fs.existsSync(REGISTRY_DIR)) {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true })
  }
}

export async function persistRoots(roots: TrackedRoot[]): Promise<void> {
  ensureDir()
  const tmpFile = `${REGISTRY_FILE}.${process.pid}-${++writeCounter}.tmp`
  const json = JSON.stringify(roots, null, 2)
  try {
    await fs.promises.writeFile(tmpFile, json, "utf8")
    await fs.promises.rename(tmpFile, REGISTRY_FILE)
  } catch {
    try { await fs.promises.unlink(tmpFile) } catch { /* already gone */ }
  }
}

export async function loadRoots(): Promise<TrackedRoot[]> {
  try {
    const raw = await fs.promises.readFile(REGISTRY_FILE, "utf8")
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed as TrackedRoot[]
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log("[process-tracker] Failed to load persisted roots:", err)
    }
    return []
  }
}
