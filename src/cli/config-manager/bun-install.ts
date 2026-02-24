import { getConfigDir } from "./config-context"

const BUN_INSTALL_TIMEOUT_SECONDS = 60
const BUN_INSTALL_TIMEOUT_MS = BUN_INSTALL_TIMEOUT_SECONDS * 1000

export interface BunInstallResult {
  success: boolean
  timedOut?: boolean
  error?: string
}

function resolveBunCommand(): string {
  if (process.platform === "win32") {
    return Bun.which("bun.exe") ?? Bun.which("bun") ?? "bun.exe"
  }

  return Bun.which("bun") ?? "bun"
}

export async function runBunInstall(): Promise<boolean> {
  const result = await runBunInstallWithDetails()
  return result.success
}

export async function runBunInstallWithDetails(): Promise<BunInstallResult> {
  try {
    const bunCommand = resolveBunCommand()
    const proc = Bun.spawn([bunCommand, "install"], {
      cwd: getConfigDir(),
      stdout: "inherit",
      stderr: "inherit",
    })

    let timeoutId: ReturnType<typeof setTimeout>
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeoutId = setTimeout(() => resolve("timeout"), BUN_INSTALL_TIMEOUT_MS)
    })
    const exitPromise = proc.exited.then(() => "completed" as const)
    const result = await Promise.race([exitPromise, timeoutPromise])
    clearTimeout(timeoutId!)

    if (result === "timeout") {
      try {
        proc.kill()
      } catch {
        /* intentionally empty - process may have already exited */
      }
      return {
        success: false,
        timedOut: true,
        error: `bun install timed out after ${BUN_INSTALL_TIMEOUT_SECONDS} seconds. Try running manually in ${getConfigDir()}: bun install`,
      }
    }

    if (proc.exitCode !== 0) {
      return {
        success: false,
        error: `bun install failed with exit code ${proc.exitCode}`,
      }
    }

    return { success: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      success: false,
      error: `bun install failed: ${message}. Ensure Bun is installed and available in PATH: https://bun.sh/docs/installation`,
    }
  }
}
