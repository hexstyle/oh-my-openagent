import { log } from "../../shared"

const GRACE_MS = 2000

async function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sendSignal(target: number, signal: NodeJS.Signals): void {
  try {
    process.kill(target, signal)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== "ESRCH" && code !== "EPERM") {
      log(`[process-tracker] Unexpected error sending ${signal} to ${target}:`, err)
    }
  }
}

export async function killTrackedRoot(pid: number): Promise<void> {
  if (!isAlive(pid)) return
  sendSignal(pid, "SIGTERM")
  await wait(GRACE_MS)
  if (isAlive(pid)) {
    sendSignal(pid, "SIGKILL")
  }
}

export async function killTrackedTree(pgid: number): Promise<void> {
  const target = -pgid
  try {
    process.kill(target, "SIGTERM")
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ESRCH") return
    if (code !== "EPERM") {
      log(`[process-tracker] Unexpected error sending SIGTERM to pgid ${pgid}:`, err)
    }
  }
  await wait(GRACE_MS)
  try {
    process.kill(target, "SIGKILL")
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== "ESRCH" && code !== "EPERM") {
      log(`[process-tracker] Unexpected error sending SIGKILL to pgid ${pgid}:`, err)
    }
  }
}
