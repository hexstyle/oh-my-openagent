import pc from "picocolors"
import type { RunOptions, RunContext } from "./types"
import { createEventState, processEvents, serializeError } from "./events"
import { loadPluginConfig } from "../../plugin-config"
import { createServerConnection } from "./server-connection"
import { resolveSession } from "./session-resolver"
import { createJsonOutputManager } from "./json-output"
import { executeOnCompleteHook } from "./on-complete-hook"
import { resolveRunAgent, resolveRunPromptAgent } from "./agent-resolver"
import { resolveRunModel } from "./model-resolver"
import { pollForCompletion } from "./poll-for-completion"
import { loadAgentProfileColors } from "./agent-profile-colors"
import { suppressRunInput } from "./stdin-suppression"
import { createTimestampedStdoutController } from "./timestamp-output"
import { CONTINUATION_PROMPT, DEFAULT_CONFIG as RUNTIME_FALLBACK_DEFAULT_CONFIG } from "../../hooks/runtime-fallback/constants"
import { getRuntimeFallbackAction, isSameModelRetryAction } from "../../hooks/runtime-fallback/fallback-policy"
import { createInternalAgentTextPart } from "../../shared/internal-initiator-marker"

export { resolveRunAgent, resolveRunPromptAgent }

const EVENT_PROCESSOR_SHUTDOWN_TIMEOUT_MS = 2_000
const RUN_TRANSPORT_RECOVERY_MAX_ATTEMPTS = 2
const RUN_TRANSPORT_RECOVERY_DELAY_MS = 2_000

export function shouldRecoverRunTransportError(error: unknown): boolean {
  const action = getRuntimeFallbackAction(
    error,
    RUNTIME_FALLBACK_DEFAULT_CONFIG.retry_on_errors,
  )
  return isSameModelRetryAction(action)
}

export async function waitForEventProcessorShutdown(
  eventProcessor: Promise<void>,
  timeoutMs = EVENT_PROCESSOR_SHUTDOWN_TIMEOUT_MS,
): Promise<void> {
  const completed = await Promise.race([
    eventProcessor.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ])

  void completed
}

export async function run(options: RunOptions): Promise<number> {
  process.env.OPENCODE_CLI_RUN_MODE = "true"
  process.env.OPENCODE_CLIENT = "run"

  const startTime = Date.now()
  const {
    message,
    directory = process.cwd(),
  } = options

  const jsonManager = options.json ? createJsonOutputManager() : null
  if (jsonManager) jsonManager.redirectToStderr()
  const timestampOutput = options.json || options.timestamp === false
    ? null
    : createTimestampedStdoutController()
  timestampOutput?.enable()

  const pluginConfig = loadPluginConfig(directory, { command: "run" })
  const resolvedAgent = resolveRunAgent(options, pluginConfig)
  const promptAgent = resolveRunPromptAgent(resolvedAgent)
  const abortController = new AbortController()

  try {
    const resolvedModel = resolveRunModel(options.model)

    const { client, cleanup: serverCleanup } = await createServerConnection({
      port: options.port,
      attach: options.attach,
      signal: abortController.signal,
    })

    const cleanup = () => {
      serverCleanup()
    }

    const restoreInput = suppressRunInput()
    const handleSigint = () => {
      console.log(pc.yellow("\nInterrupted. Shutting down..."))
      restoreInput()
      cleanup()
      process.exit(130)
    }

    process.on("SIGINT", handleSigint)

    try {
      const sessionID = await resolveSession({
        client,
        sessionId: options.sessionId,
        directory,
      })

      console.log(pc.dim(`Session: ${sessionID}`))

      if (resolvedModel) {
        console.log(pc.dim(`Model: ${resolvedModel.providerID}/${resolvedModel.modelID}`))
      }

      const ctx: RunContext = {
        client,
        sessionID,
        directory,
        abortController,
        verbose: options.verbose ?? false,
      }
      const events = await client.event.subscribe({ query: { directory } })
      const eventState = createEventState()
      eventState.agentColorsByName = await loadAgentProfileColors(client)
      const eventProcessor = processEvents(ctx, events.stream, eventState).catch(
        () => {},
      )
      const continuationPrompt = createInternalAgentTextPart(CONTINUATION_PROMPT).text
      let promptDelivered = false
      let transportRecoveryAttempts = 0
      let exitCode = 1

      while (true) {
        const promptText = promptDelivered ? continuationPrompt : message

        try {
          await client.session.promptAsync({
            path: { id: sessionID },
            body: {
              agent: promptAgent,
              ...(resolvedModel ? { model: resolvedModel } : {}),
              tools: {
                question: false,
              },
              parts: [{ type: "text", text: promptText }],
            },
            query: { directory },
          })

          promptDelivered = true
          exitCode = await pollForCompletion(ctx, eventState, abortController)
          break
        } catch (err) {
          if (
            transportRecoveryAttempts >= RUN_TRANSPORT_RECOVERY_MAX_ATTEMPTS
            || !shouldRecoverRunTransportError(err)
          ) {
            throw err
          }

          transportRecoveryAttempts += 1
          console.error(
            pc.yellow(
              `Run transport recovery ${transportRecoveryAttempts}/${RUN_TRANSPORT_RECOVERY_MAX_ATTEMPTS}: ${serializeError(err)}`
            )
          )
          await new Promise((resolve) => setTimeout(resolve, RUN_TRANSPORT_RECOVERY_DELAY_MS))
        }
      }

      // Abort the event stream to stop the processor
      abortController.abort()

      await waitForEventProcessorShutdown(eventProcessor)
      cleanup()

      const durationMs = Date.now() - startTime

      if (options.onComplete) {
        await executeOnCompleteHook({
          command: options.onComplete,
          sessionId: sessionID,
          exitCode,
          durationMs,
          messageCount: eventState.messageCount,
        })
      }

      if (jsonManager) {
        jsonManager.emitResult({
          sessionId: sessionID,
          success: exitCode === 0,
          durationMs,
          messageCount: eventState.messageCount,
          summary: eventState.lastPartText.slice(0, 200) || "Run completed",
        })
      }

      return exitCode
    } catch (err) {
      cleanup()
      throw err
    } finally {
      process.removeListener("SIGINT", handleSigint)
      restoreInput()
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
