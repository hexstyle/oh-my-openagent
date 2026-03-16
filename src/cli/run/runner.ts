import pc from "picocolors"
import type { RunOptions } from "./types"
import { createJsonOutputManager } from "./json-output"
import { executeOnCompleteHook } from "./on-complete-hook"
import { createServerConnection } from "./server-connection"
import {
  executeRunSession,
  waitForEventProcessorShutdown,
} from "./run-engine"
import { createTimestampedStdoutController } from "./timestamp-output"
import { serializeError } from "./events"
import { suppressRunInput } from "./stdin-suppression"

export { resolveRunAgent } from "./agent-resolver"
export { waitForEventProcessorShutdown }

export async function run(options: RunOptions): Promise<number> {
  process.env.OPENCODE_CLI_RUN_MODE = "true"

  const {
    directory = process.cwd(),
  } = options

  const jsonManager = options.json ? createJsonOutputManager() : null
  if (jsonManager) jsonManager.redirectToStderr()
  const timestampOutput = options.json || options.timestamp === false
    ? null
    : createTimestampedStdoutController()
  timestampOutput?.enable()

  const abortController = new AbortController()

  try {
    const { client, cleanup } = await createServerConnection({
      port: options.port,
      attach: options.attach,
      signal: abortController.signal,
    })

    const restoreInput = suppressRunInput()
    const handleSigint = () => {
      console.log(pc.yellow("\nInterrupted. Shutting down..."))
      abortController.abort()
      restoreInput()
      cleanup()
      process.exit(130)
    }

    process.on("SIGINT", handleSigint)

    try {
      const { exitCode, result } = await executeRunSession({
        client,
        message: options.message,
        directory,
        agent: options.agent,
        model: options.model,
        sessionId: options.sessionId,
        verbose: options.verbose ?? false,
        questionPermission: "deny",
        questionToolEnabled: false,
        renderOutput: true,
      })

      if (options.onComplete) {
        await executeOnCompleteHook({
          command: options.onComplete,
          sessionId: result.sessionId,
          exitCode,
          durationMs: result.durationMs,
          messageCount: result.messageCount,
        })
      }

      if (jsonManager) {
        jsonManager.emitResult(result)
      }

      return exitCode
    } finally {
      process.removeListener("SIGINT", handleSigint)
      restoreInput()
      cleanup()
    }
  } catch (err) {
    if (jsonManager) jsonManager.restore()
    timestampOutput?.restore()
    if (err instanceof Error && err.name === "AbortError") {
      return 130
    }
    console.error(pc.red(`Error: ${serializeError(err)}`))
    return 1
  } finally {
    timestampOutput?.restore()
  }
}
