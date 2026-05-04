import pc from "picocolors"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
import { getPreferredDataDir } from "../../shared/data-path"
import { checkCompletionConditions } from "./completion"
import { normalizeSDKResponse } from "../../shared"

export { resolveRunAgent, resolveRunPromptAgent }

const EVENT_PROCESSOR_SHUTDOWN_TIMEOUT_MS = 2_000
const RUN_TRANSPORT_RECOVERY_MAX_ATTEMPTS = 2
const RUN_TRANSPORT_RECOVERY_DELAY_MS = 2_000
const RUN_CERT_RECOVERY_MAX_ATTEMPTS = 8
const RUN_CERT_RECOVERY_DELAY_MS = 5_000
const RUN_ISOLATED_DATA_HOME_DISABLE_ENV = "OH_MY_OPENAGENT_DISABLE_RUN_DATA_ISOLATION"

type RunIsolatedDataHomeState = {
  tempDir: string
  originalXdgDataHome: string | undefined
}

export function shouldRecoverRunTransportError(error: unknown): boolean {
  const action = getRuntimeFallbackAction(
    error,
    RUNTIME_FALLBACK_DEFAULT_CONFIG.retry_on_errors,
  )
  return isSameModelRetryAction(action)
}

export function isCertificateVerificationTransportError(error: unknown): boolean {
  return /unknown certificate verification error/i.test(serializeError(error))
}

export function getRunTransportRecoveryPolicy(error: unknown): {
  maxAttempts: number
  delayMs: number
} {
  if (isCertificateVerificationTransportError(error)) {
    return {
      maxAttempts: RUN_CERT_RECOVERY_MAX_ATTEMPTS,
      delayMs: RUN_CERT_RECOVERY_DELAY_MS,
    }
  }

  return {
    maxAttempts: RUN_TRANSPORT_RECOVERY_MAX_ATTEMPTS,
    delayMs: RUN_TRANSPORT_RECOVERY_DELAY_MS,
  }
}

export function shouldUseIsolatedRunDataHome(options: Pick<RunOptions, "attach">, env: NodeJS.ProcessEnv = process.env): boolean {
  if (options.attach) {
    return false
  }

  return env[RUN_ISOLATED_DATA_HOME_DISABLE_ENV] !== "1"
}

export function prepareIsolatedRunDataHome(env: NodeJS.ProcessEnv = process.env): RunIsolatedDataHomeState {
  const tempDir = mkdtempSync(join(tmpdir(), "oh-my-openagent-run-data-"))
  const opencodeDir = join(tempDir, "opencode")
  mkdirSync(opencodeDir, { recursive: true })

  const authSource = join(getPreferredDataDir(), "opencode", "auth.json")
  const authTarget = join(opencodeDir, "auth.json")
  if (existsSync(authSource)) {
    copyFileSync(authSource, authTarget)
  }

  const state: RunIsolatedDataHomeState = {
    tempDir,
    originalXdgDataHome: env.XDG_DATA_HOME,
  }
  env.XDG_DATA_HOME = tempDir
  return state
}

export function cleanupIsolatedRunDataHome(
  state: RunIsolatedDataHomeState | null,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!state) {
    return
  }

  if (state.originalXdgDataHome === undefined) {
    delete env.XDG_DATA_HOME
  } else {
    env.XDG_DATA_HOME = state.originalXdgDataHome
  }

  try {
    rmSync(state.tempDir, { recursive: true, force: true })
  } catch {
  }
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

async function getRunSessionStatus(
  ctx: RunContext,
): Promise<"idle" | "busy" | "retry" | null> {
  try {
    const statusesRes = await ctx.client.session.status({
      query: { directory: ctx.directory },
    })
    const statuses = normalizeSDKResponse(
      statusesRes,
      {} as Record<string, { type?: string }>
    )
    const status = statuses[ctx.sessionID]?.type
    if (status === "idle" || status === "busy" || status === "retry") {
      return status
    }
  } catch {
  }

  return null
}

function isPromptAbortRecoveryCandidate(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  if (error.name === "AbortError" || error.name === "MessageAbortedError") {
    return true
  }

  return /\baborted\b/i.test(serializeError(error))
}

export async function shouldResumePollingAfterPromptFailure(
  ctx: RunContext,
  eventState: {
    hasReceivedMeaningfulWork: boolean
    currentTool: string | null
    pendingSameModelRecovery: boolean
    mainSessionError: boolean
  },
  error: unknown,
  options: {
    attempts?: number
    delayMs?: number
  } = {},
): Promise<boolean> {
  if (!isPromptAbortRecoveryCandidate(error)) {
    return false
  }

  const attempts = options.attempts ?? 6
  const delayMs = options.delayMs ?? 500

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (
      eventState.currentTool !== null
      || eventState.pendingSameModelRecovery
      || eventState.mainSessionError
    ) {
      return true
    }

    const status = await getRunSessionStatus(ctx)
    if (status === "busy" || status === "retry") {
      return true
    }

    if (eventState.hasReceivedMeaningfulWork) {
      const settled = await checkCompletionConditions(ctx)
      if (!settled) {
        return true
      }
    }

    if (attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }

  // If promptAsync reached an abort-style failure, the server often already has
  // a live session turn (or a recovery prompt_async) in flight. Returning to
  // the poller is safer than terminating the direct run client here, because
  // completion/recovery logic can still prove the session idle or failed later.
  return true
}

export async function run(options: RunOptions): Promise<number> {
  process.env.OPENCODE_CLI_RUN_MODE = "true"
  process.env.OPENCODE_CLIENT = "run"
  const isolatedRunDataHome = shouldUseIsolatedRunDataHome(options)
    ? prepareIsolatedRunDataHome()
    : null

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
          const shouldResumePolling = await shouldResumePollingAfterPromptFailure(
            ctx,
            eventState,
            err,
          )
          if (shouldResumePolling) {
            promptDelivered = true
            exitCode = await pollForCompletion(ctx, eventState, abortController)
            break
          }

          const recoveryPolicy = getRunTransportRecoveryPolicy(err)
          if (
            transportRecoveryAttempts >= recoveryPolicy.maxAttempts
            || !shouldRecoverRunTransportError(err)
          ) {
            throw err
          }

          transportRecoveryAttempts += 1
          console.error(
            pc.yellow(
              `Run transport recovery ${transportRecoveryAttempts}/${recoveryPolicy.maxAttempts}: ${serializeError(err)}`
            )
          )
          await new Promise((resolve) => setTimeout(resolve, recoveryPolicy.delayMs))
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
    cleanupIsolatedRunDataHome(isolatedRunDataHome)
    timestampOutput?.restore()
  }
}
