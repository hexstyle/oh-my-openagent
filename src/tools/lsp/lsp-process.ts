import { spawn as bunSpawn } from "bun"
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process"
import { existsSync, statSync } from "fs"
import { delimiter } from "node:path"
import { log } from "../../shared/logger"
// Bun spawn segfaults on Windows (oven-sh/bun#25798) — unfixed as of v1.3.8+
function shouldUseNodeSpawn(): boolean {
  return process.platform === "win32"
}
// Prevents segfaults when libuv gets a non-existent cwd (oven-sh/bun#25798)
export function validateCwd(cwd: string): { valid: boolean; error?: string } {
  try {
    if (!existsSync(cwd)) {
      return { valid: false, error: `Working directory does not exist: ${cwd}` }
    }
    const stats = statSync(cwd)
    if (!stats.isDirectory()) {
      return { valid: false, error: `Path is not a directory: ${cwd}` }
    }
    return { valid: true }
  } catch (err) {
    return { valid: false, error: `Cannot access working directory: ${cwd} (${err instanceof Error ? err.message : String(err)})` }
  }
}
interface StreamReader {
  read(): Promise<{ done: boolean; value: Uint8Array | undefined }>
}
// Bridges Bun Subprocess and Node.js ChildProcess under a common API
export interface UnifiedProcess {
  stdin: { write(chunk: Uint8Array | string): void }
  stdout: { getReader(): StreamReader }
  stderr: { getReader(): StreamReader }
  exitCode: number | null
  exited: Promise<number>
  kill(signal?: string): void
}
function wrapNodeProcess(proc: ChildProcess): UnifiedProcess {
  let resolveExited: (code: number) => void
  let exitCode: number | null = null
  const exitedPromise = new Promise<number>((resolve) => {
    resolveExited = resolve
  })
  proc.on("exit", (code) => {
    exitCode = code ?? 1
    resolveExited(exitCode)
  })
  proc.on("error", () => {
    if (exitCode === null) {
      exitCode = 1
      resolveExited(1)
    }
  })
  const createStreamReader = (nodeStream: NodeJS.ReadableStream | null): StreamReader => {
    const chunks: Uint8Array[] = []
    let streamEnded = false
    type ReadResult = { done: boolean; value: Uint8Array | undefined }
    let waitingResolve: ((result: ReadResult) => void) | null = null

    if (nodeStream) {
      nodeStream.on("data", (chunk: Buffer) => {
        const uint8 = new Uint8Array(chunk)
        if (waitingResolve) {
          const resolve = waitingResolve
          waitingResolve = null
          resolve({ done: false, value: uint8 })
        } else {
          chunks.push(uint8)
        }
      })

      nodeStream.on("end", () => {
        streamEnded = true
        if (waitingResolve) {
          const resolve = waitingResolve
          waitingResolve = null
          resolve({ done: true, value: undefined })
        }
      })

      nodeStream.on("error", () => {
        streamEnded = true
        if (waitingResolve) {
          const resolve = waitingResolve
          waitingResolve = null
          resolve({ done: true, value: undefined })
        }
      })
    } else {
      streamEnded = true
    }
    return {
      read(): Promise<ReadResult> {
        return new Promise((resolve) => {
          if (chunks.length > 0) {
            resolve({ done: false, value: chunks.shift()! })
          } else if (streamEnded) {
            resolve({ done: true, value: undefined })
          } else {
            waitingResolve = resolve
          }
        })
      },
    }
  }
  return {
    stdin: {
      write(chunk: Uint8Array | string) {
        if (proc.stdin) {
          proc.stdin.write(chunk)
        }
      },
    },
    stdout: {
      getReader: () => createStreamReader(proc.stdout),
    },
    stderr: {
      getReader: () => createStreamReader(proc.stderr),
    },
    get exitCode() {
      return exitCode
    },
    exited: exitedPromise,
    kill(signal?: string) {
      try {
        if (signal === "SIGKILL") {
          proc.kill("SIGKILL")
        } else {
          proc.kill()
        }
      } catch {}
    },
  }
}

const DOTNET8_HOMEBREW_ROOT = "/opt/homebrew/opt/dotnet@8/libexec"

function prependPathSegment(pathValue: string | undefined, segment: string): string {
  if (!pathValue || pathValue.length === 0) {
    return segment
  }

  const segments = pathValue.split(delimiter)
  if (segments.includes(segment)) {
    return pathValue
  }

  return `${segment}${delimiter}${pathValue}`
}

export function augmentEnvForLspCommand(
  command: string[],
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  if (command[0] !== "csharp-ls") {
    return env
  }

  if (!existsSync(DOTNET8_HOMEBREW_ROOT)) {
    return env
  }

  return {
    ...env,
    DOTNET_ROOT: env.DOTNET_ROOT?.trim().length ? env.DOTNET_ROOT : DOTNET8_HOMEBREW_ROOT,
    PATH: prependPathSegment(env.PATH, DOTNET8_HOMEBREW_ROOT),
  }
}

export function spawnProcess(
  command: string[],
  options: { cwd: string; env: Record<string, string | undefined> }
): UnifiedProcess {
  const cwdValidation = validateCwd(options.cwd)
  if (!cwdValidation.valid) {
    throw new Error(`[LSP] ${cwdValidation.error}`)
  }
  const effectiveEnv = augmentEnvForLspCommand(command, options.env)
  if (shouldUseNodeSpawn()) {
    const [cmd, ...args] = command
    log("[LSP] Using Node.js child_process on Windows to avoid Bun spawn segfault")
    const proc = nodeSpawn(cmd, args, {
      cwd: options.cwd,
      env: effectiveEnv as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: true,
    })
    return wrapNodeProcess(proc)
  }
  const proc = bunSpawn(command, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: options.cwd,
    env: effectiveEnv,
  })
  return proc as unknown as UnifiedProcess
}
