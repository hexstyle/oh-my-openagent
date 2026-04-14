import { spawn } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HookDeps, RuntimeFallbackTimeout } from "./types"
import {
  HOOK_NAME,
  MODEL_RECOVERY_PROBE_MIN_INTERVAL_MS,
  MODEL_RECOVERY_PROBE_TIMEOUT_MS,
  WATCHDOG_CONTINUATION_PROMPT,
} from "./constants"
import { log } from "../../shared/logger"
import { normalizeAgentName, resolveAgentForSession } from "./agent-resolver"
import { getSessionAgent } from "../../features/claude-code-session-state"
import { getFallbackModelsForSession } from "./fallback-models"
import {
  beginTransientRetryWindow,
  canKeepRetryingTransiently,
  getNextTransientRetryDelayMs,
  isRecentLimitError,
  markTransientRetryDispatched,
  prepareFallback,
  recoverPreferredModel,
  resetTransientRetryState,
  wasRecentlyStopped,
} from "./fallback-state"
import { SessionCategoryRegistry } from "../../shared/session-category-registry"
import { buildRetryModelPayload } from "./retry-model-payload"
import { getLastUserRetryParts } from "./last-user-retry-parts"
import { extractSessionMessages } from "./session-messages"
import {
  isPrimaryRuntimeAgent,
  normalizeAgentForPrompt,
  normalizeAgentForExecution,
  normalizeAgentForSessionPrompt,
} from "../../shared/agent-display-names"
import { getRecoveryProbeCandidates, selectFallbackModelsForAction } from "./fallback-policy"

const SESSION_TTL_MS = 30 * 60 * 1000
const EXTERNAL_WATCHDOG_RESPAWN_MS = 10_000
const EXTERNAL_WATCHDOG_MIN_TIMEOUT_MS = 1_000
const EXTERNAL_WATCHDOG_DIR = join(tmpdir(), "oh-my-opencode-watchdogs")
const EXTERNAL_WATCHDOG_LOG = join(tmpdir(), "oh-my-opencode-watchdog.log")

declare function setTimeout(callback: () => void | Promise<void>, delay?: number): RuntimeFallbackTimeout
declare function clearTimeout(timeout: RuntimeFallbackTimeout): void

export function selectExternalWatchdogModel(
  currentModel: string,
  fallbackModels: string[],
): string | undefined {
  return currentModel || fallbackModels.find((candidate) => candidate)
}

export function resolveExternalWatchdogAgent(resolvedAgent: string | undefined): string {
  const executionAgent = normalizeAgentForExecution(resolvedAgent)
  if (!executionAgent) {
    return ""
  }

  if (!isPrimaryRuntimeAgent(executionAgent)) {
    return executionAgent
  }

  return normalizeAgentForPrompt(executionAgent) ?? executionAgent
}

export function createAutoRetryHelpers(deps: HookDeps) {
  const {
    ctx,
    config,
    options,
    sessionStates,
    sessionLastAccess,
    sessionLastUserMessageIDs,
    sessionRecentCompletionUntil,
    sessionRetryInFlight,
    sessionAwaitingFallbackResult,
    sessionFallbackTimeouts,
    sessionTransientRetryTimeouts,
    pluginConfig,
    sessionStatusRetryKeys,
  } = deps
  const externalWatchdogSpawnedAt = new Map<string, number>()
  const recoveryProbeLastAttemptAt = new Map<string, number>()

  const ensureExternalWatchdogDir = (): void => {
    try {
      mkdirSync(EXTERNAL_WATCHDOG_DIR, { recursive: true })
    } catch {
    }
  }

  const getExternalWatchdogTokenPath = (sessionID: string): string =>
    join(EXTERNAL_WATCHDOG_DIR, `${sessionID}.token`)

  const invalidateExternalWatchdog = (sessionID: string): void => {
    externalWatchdogSpawnedAt.delete(sessionID)
    try {
      rmSync(getExternalWatchdogTokenPath(sessionID), { force: true })
    } catch {
    }
  }

  const splitWatchdogCliModel = (model: string): {
    model: string
    variant?: string
  } => {
    const match = model.match(/^(.*)\(([^()]+)\)$/)
    if (!match) {
      return { model }
    }

    return {
      model: match[1]?.trim() || model,
      variant: match[2]?.trim() || undefined,
    }
  }

  const armExternalWatchdog = (args: {
    sessionID: string
    timeoutMs: number
    source: string
    resolvedAgent?: string
    currentModel: string
  }): void => {
    if (args.timeoutMs < EXTERNAL_WATCHDOG_MIN_TIMEOUT_MS) {
      return
    }
    if (
      ctx.directory === "/test/dir" ||
      ctx.directory.startsWith("/test/") ||
      args.sessionID.startsWith("test-")
    ) {
      return
    }

    if (!args.resolvedAgent || !isPrimaryRuntimeAgent(args.resolvedAgent)) {
      log(`[${HOOK_NAME}] Skipping external watchdog for non-primary or unresolved agent`, {
        sessionID: args.sessionID,
        source: args.source,
        resolvedAgent: args.resolvedAgent,
      })
      return
    }

    const fallbackModels = getFallbackModelsForSession(args.sessionID, args.resolvedAgent, pluginConfig)
    const nextModel = selectExternalWatchdogModel(args.currentModel, fallbackModels)
    if (!nextModel) {
      log(`[${HOOK_NAME}] Skipping external watchdog arm without fallback model`, {
        sessionID: args.sessionID,
        source: args.source,
        currentModel: args.currentModel,
      })
      return
    }

    ensureExternalWatchdogDir()

    const now = Date.now()
    const lastSpawnedAt = externalWatchdogSpawnedAt.get(args.sessionID) ?? 0
    const token = `${now}-${Math.random().toString(36).slice(2, 10)}`
    const tokenPath = getExternalWatchdogTokenPath(args.sessionID)

    try {
      writeFileSync(tokenPath, token)
    } catch (error) {
      log(`[${HOOK_NAME}] Failed to write external watchdog token`, {
        sessionID: args.sessionID,
        source: args.source,
        error: String(error),
      })
      return
    }

    if (now - lastSpawnedAt < EXTERNAL_WATCHDOG_RESPAWN_MS) {
      log(`[${HOOK_NAME}] Refreshed external watchdog token without respawn`, {
        sessionID: args.sessionID,
        source: args.source,
        timeoutMs: args.timeoutMs,
        nextModel,
      })
      return
    }

    const cliAgent = resolveExternalWatchdogAgent(args.resolvedAgent)
    const cliModel = splitWatchdogCliModel(nextModel)
    const escapedWatchdogPrompt = JSON.stringify(WATCHDOG_CONTINUATION_PROMPT)
    const shellScript = `
sleep "$1"
TOKEN_FILE="$2"
EXPECTED_TOKEN="$3"
SESSION_ID="$4"
SESSION_DIR="$5"
NEXT_MODEL="$6"
MODEL_VARIANT="$7"
AGENT_NAME="$8"
WATCHDOG_LOG="$9"
CURRENT_TOKEN="$(cat "$TOKEN_FILE" 2>/dev/null || true)"
if [ "$CURRENT_TOKEN" != "$EXPECTED_TOKEN" ]; then
  exit 0
fi
{
  printf '[%s] [runtime-fallback external] firing session=%s model=%s variant=%s agent=%s\\n' "$(date -Iseconds)" "$SESSION_ID" "$NEXT_MODEL" "$MODEL_VARIANT" "$AGENT_NAME"
} >> "$WATCHDOG_LOG"
VARIANT_ARGS=()
if [ -n "$MODEL_VARIANT" ]; then
  VARIANT_ARGS=(--variant "$MODEL_VARIANT")
fi
if [ -n "$AGENT_NAME" ]; then
  exec opencode run -s "$SESSION_ID" --dir "$SESSION_DIR" --model "$NEXT_MODEL" "\${VARIANT_ARGS[@]}" --agent "$AGENT_NAME" ${escapedWatchdogPrompt} >> "$WATCHDOG_LOG" 2>&1
else
  exec opencode run -s "$SESSION_ID" --dir "$SESSION_DIR" --model "$NEXT_MODEL" "\${VARIANT_ARGS[@]}" ${escapedWatchdogPrompt} >> "$WATCHDOG_LOG" 2>&1
fi
`

    try {
      const child = spawn(
        "/bin/zsh",
        [
          "-lc",
          shellScript,
          "runtime-fallback-watchdog",
          String(Math.max(1, Math.ceil(args.timeoutMs / 1000))),
          tokenPath,
          token,
          args.sessionID,
          ctx.directory,
          cliModel.model,
          cliModel.variant ?? "",
          cliAgent,
          EXTERNAL_WATCHDOG_LOG,
        ],
        {
          detached: true,
          stdio: "ignore",
        },
      )
      child.unref()
      externalWatchdogSpawnedAt.set(args.sessionID, now)
      log(`[${HOOK_NAME}] Armed external watchdog`, {
        sessionID: args.sessionID,
        source: args.source,
        timeoutMs: args.timeoutMs,
        nextModel: cliModel.model,
        variant: cliModel.variant,
        agentDisplayName: cliAgent || undefined,
        logFile: EXTERNAL_WATCHDOG_LOG,
      })
    } catch (error) {
      log(`[${HOOK_NAME}] Failed to spawn external watchdog`, {
        sessionID: args.sessionID,
        source: args.source,
        error: String(error),
      })
    }
  }

  const abortSessionRequest = async (sessionID: string, source: string): Promise<void> => {
    try {
      await ctx.client.session.abort({ path: { id: sessionID } })
      log(`[${HOOK_NAME}] Aborted in-flight session request (${source})`, { sessionID })
    } catch (error) {
      log(`[${HOOK_NAME}] Failed to abort in-flight session request (${source})`, {
        sessionID,
        error: String(error),
      })
    }
  }

  const clearSessionTransientRetryTimeout = (sessionID: string): void => {
    const timer = sessionTransientRetryTimeouts.get(sessionID)
    if (timer) {
      clearTimeout(timer)
      sessionTransientRetryTimeouts.delete(sessionID)
    }
  }

  const clearSessionFallbackTimeout = (sessionID: string) => {
    const existingTimer = sessionFallbackTimeouts.get(sessionID)
    if (existingTimer) {
      clearTimeout(existingTimer)
      sessionFallbackTimeouts.delete(sessionID)
    }
    clearSessionTransientRetryTimeout(sessionID)
    invalidateExternalWatchdog(sessionID)
  }

  const scheduleSessionFallbackTimeout = (sessionID: string, args?: {
    resolvedAgent?: string
    source?: string
    mode?: "fallback" | "transient_retry"
  }) => {
    const source = args?.source ?? "session.timeout"
    const mode = args?.mode ?? "fallback"
    const hadExistingTimer = sessionFallbackTimeouts.has(sessionID)
    const delayedTransientTimer = sessionTransientRetryTimeouts.get(sessionID)
    if (delayedTransientTimer) {
      clearTimeout(delayedTransientTimer)
      sessionTransientRetryTimeouts.delete(sessionID)
    }

    const existingTimer = sessionFallbackTimeouts.get(sessionID)
    if (existingTimer) {
      clearTimeout(existingTimer)
      sessionFallbackTimeouts.delete(sessionID)
    }
    invalidateExternalWatchdog(sessionID)

    const timeoutMs = options?.session_timeout_ms ?? config.timeout_seconds * 1000
    if (timeoutMs <= 0) return
    const stateAtSchedule = sessionStates.get(sessionID)
    if (!stateAtSchedule) {
      log(`[${HOOK_NAME}] Skipping session fallback timeout arm without state`, {
        sessionID,
        source,
      })
      return
    }

    if (wasRecentlyStopped(stateAtSchedule)) {
      log(`[${HOOK_NAME}] Skipping session fallback timeout arm — session was recently stopped`, {
        sessionID,
        source,
      })
      return
    }

    log(
      `[${HOOK_NAME}] ${hadExistingTimer ? "Refreshed" : "Armed"} session fallback timeout`,
      {
        sessionID,
        source,
        timeoutMs,
        mode,
        currentModel: stateAtSchedule.currentModel,
      },
    )
    if (mode === "fallback") {
      armExternalWatchdog({
        sessionID,
        timeoutMs,
        source,
        resolvedAgent: args?.resolvedAgent,
        currentModel: stateAtSchedule.currentModel,
      })
    }

    const timer = setTimeout(async () => {
      try {
        sessionFallbackTimeouts.delete(sessionID)

        const state = sessionStates.get(sessionID)
        if (!state) {
          log(`[${HOOK_NAME}] Session fallback timeout fired without state`, {
            sessionID,
            source,
          })
          return
        }

        // If the user pressed ESC after this timer was armed, abort.
        if (wasRecentlyStopped(state)) {
          log(`[${HOOK_NAME}] Session fallback timeout cancelled — session was stopped`, {
            sessionID,
            source,
          })
          return
        }

        if (sessionRetryInFlight.has(sessionID)) {
          log(`[${HOOK_NAME}] Overriding in-flight retry due to session timeout`, { sessionID, source })
        }

        await abortSessionRequest(sessionID, source)
        sessionRetryInFlight.delete(sessionID)

        const resolvedAgent = args?.resolvedAgent ?? await resolveAgentForSessionFromContext(sessionID)

        if (mode === "transient_retry" && state.pendingTransientRetry) {
          state.pendingTransientRetry = false

          if (canKeepRetryingTransiently(state, config)) {
            scheduleTransientRetry(sessionID, resolvedAgent, `${source}.transient-timeout`)
            return
          }
        }

        if (state.pendingFallbackModel) {
          state.pendingFallbackModel = undefined
        }

        const allFallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, pluginConfig)
        if (allFallbackModels.length === 0) {
          log(`[${HOOK_NAME}] Session fallback timeout reached but no fallback models were resolved`, {
            sessionID,
            source,
            resolvedAgent,
          })
          return
        }

        // If the session previously hit a quota/limit, route directly to spark
        // then free-tier models instead of retrying paid models that are capped.
        const timeoutAction = isRecentLimitError(state) ? "limit_fallback" : "fallback_chain"
        const fallbackModels = timeoutAction === "limit_fallback"
          ? selectFallbackModelsForAction({ currentModel: state.currentModel, fallbackModels: allFallbackModels, action: "limit_fallback" })
          : allFallbackModels

        const lastAccess = sessionLastAccess.get(sessionID)
        log(`[${HOOK_NAME}] Session fallback timeout reached`, {
          sessionID,
          source,
          timeoutSeconds: config.timeout_seconds,
          currentModel: state.currentModel,
          resolvedAgent,
          timeoutAction,
          lastAccessAgeMs: typeof lastAccess === "number" ? Math.max(0, Date.now() - lastAccess) : undefined,
        })

        const result = prepareFallback(sessionID, state, fallbackModels, config)
        if (result.success && result.newModel) {
          await autoRetryWithFallback(sessionID, result.newModel, resolvedAgent, source)
        }
      } catch (error) {
        log(`[${HOOK_NAME}] Session fallback timeout handler failed`, {
          sessionID,
          source,
          error: String(error),
        })
      }
    }, timeoutMs)

    sessionFallbackTimeouts.set(sessionID, timer)
  }

  const scheduleTransientRetry = (
    sessionID: string,
    resolvedAgent: string | undefined,
    source: string,
  ): void => {
    const state = sessionStates.get(sessionID)
    if (!state) {
      return
    }

    if (!canKeepRetryingTransiently(state, config)) {
      log(`[${HOOK_NAME}] Transient retry window exhausted`, {
        sessionID,
        source,
        currentModel: state.currentModel,
        transientRetryCount: state.transientRetryCount,
      })
      return
    }

    if (sessionTransientRetryTimeouts.has(sessionID)) {
      log(`[${HOOK_NAME}] Transient retry already scheduled`, {
        sessionID,
        source,
        currentModel: state.currentModel,
      })
      return
    }

    beginTransientRetryWindow(state)
    const delayMs = getNextTransientRetryDelayMs(state, config)
    state.transientRetryDelayMs = delayMs

    log(`[${HOOK_NAME}] Scheduling delayed transient retry on current model`, {
      sessionID,
      source,
      currentModel: state.currentModel,
      delayMs,
      transientRetryCount: state.transientRetryCount,
    })

    const timer = setTimeout(async () => {
      sessionTransientRetryTimeouts.delete(sessionID)

      const latestState = sessionStates.get(sessionID)
      if (!latestState) {
        return
      }

      if (!canKeepRetryingTransiently(latestState, config)) {
        log(`[${HOOK_NAME}] Skipping delayed transient retry after retry window expired`, {
          sessionID,
          source,
          currentModel: latestState.currentModel,
        })
        return
      }

      markTransientRetryDispatched(latestState)
      await autoRetryWithFallback(sessionID, latestState.currentModel, resolvedAgent, `${source}.retry`, {
        transientRetry: true,
      })
    }, delayMs)

    sessionTransientRetryTimeouts.set(sessionID, timer)
  }

  const autoRetryWithFallback = async (
    sessionID: string,
    newModel: string,
    resolvedAgent: string | undefined,
    source: string,
    args?: {
      transientRetry?: boolean
    },
  ): Promise<void> => {
    if (sessionRetryInFlight.has(sessionID)) {
      log(`[${HOOK_NAME}] Retry already in flight, skipping (${source})`, { sessionID })
      return
    }

    const retryModelPayload = buildRetryModelPayload(newModel)
    if (!retryModelPayload) {
      log(`[${HOOK_NAME}] Invalid model format (missing provider prefix): ${newModel}`)
      const state = sessionStates.get(sessionID)
      if (state?.pendingFallbackModel) {
        state.pendingFallbackModel = undefined
      }
      if (state?.pendingTransientRetry) {
        state.pendingTransientRetry = false
      }
      return
    }

    sessionRetryInFlight.add(sessionID)
    let retryDispatched = false
    try {
      const messagesResp = await ctx.client.session.messages({
        path: { id: sessionID },
        query: { directory: ctx.directory },
      })
      const retryParts = getLastUserRetryParts(messagesResp)
      if (retryParts.length > 0) {
        log(`[${HOOK_NAME}] Auto-retrying session (${source})`, {
          sessionID,
          model: newModel,
        })

        const retryAgent = resolvedAgent ?? getSessionAgent(sessionID)
        const retryPromptAgent = normalizeAgentForSessionPrompt(retryAgent)
        sessionAwaitingFallbackResult.add(sessionID)
        scheduleSessionFallbackTimeout(sessionID, {
          resolvedAgent: retryAgent,
          source,
          mode: args?.transientRetry ? "transient_retry" : "fallback",
        })

        await ctx.client.session.promptAsync({
          path: { id: sessionID },
          body: {
            ...(retryPromptAgent ? { agent: retryPromptAgent } : {}),
            ...retryModelPayload,
            parts: retryParts,
          },
          query: { directory: ctx.directory },
        })
        retryDispatched = true
      } else {
        log(`[${HOOK_NAME}] No user message found for auto-retry (${source})`, { sessionID })
      }
    } catch (retryError) {
      log(`[${HOOK_NAME}] Auto-retry failed (${source})`, { sessionID, error: String(retryError) })
    } finally {
      sessionRetryInFlight.delete(sessionID)
      if (!retryDispatched) {
        sessionAwaitingFallbackResult.delete(sessionID)
        clearSessionFallbackTimeout(sessionID)
        const state = sessionStates.get(sessionID)
        if (state?.pendingFallbackModel) {
          state.pendingFallbackModel = undefined
        }
        if (state?.pendingTransientRetry) {
          state.pendingTransientRetry = false
        }
      }
    }
  }

  const retryCurrentModel = async (
    sessionID: string,
    resolvedAgent: string | undefined,
    source: string,
    options?: {
      immediate?: boolean
    },
  ): Promise<boolean> => {
    const state = sessionStates.get(sessionID)
    if (!state) {
      return false
    }

    const immediate = options?.immediate ?? true

    if (!canKeepRetryingTransiently(state, config)) {
      log(`[${HOOK_NAME}] Transient retry window exhausted before retry dispatch`, {
        sessionID,
        source,
        currentModel: state.currentModel,
      })
      return false
    }

    if (immediate && state.transientRetryCount === 0) {
      markTransientRetryDispatched(state)
      log(`[${HOOK_NAME}] Retrying current model immediately after transient error`, {
        sessionID,
        source,
        currentModel: state.currentModel,
        transientRetryCount: state.transientRetryCount,
      })

      await autoRetryWithFallback(sessionID, state.currentModel, resolvedAgent, `${source}.retry`, {
        transientRetry: true,
      })
      return true
    }

    if (!immediate && state.transientRetryCount === 0) {
      log(`[${HOOK_NAME}] Deferring opaque transient retry on current model`, {
        sessionID,
        source,
        currentModel: state.currentModel,
      })
    }

    scheduleTransientRetry(sessionID, resolvedAgent, source)
    return true
  }

  const resolveAgentForSessionFromContext = async (
    sessionID: string,
    eventAgent?: string,
  ): Promise<string | undefined> => {
    const resolved = resolveAgentForSession(sessionID, eventAgent)
    if (resolved) return resolved

    try {
      const messagesResp = await ctx.client.session.messages({
        path: { id: sessionID },
        query: { directory: ctx.directory },
      })
      const msgs = extractSessionMessages(messagesResp)
      if (!msgs || msgs.length === 0) return undefined

      for (let i = msgs.length - 1; i >= 0; i--) {
        const info = msgs[i]?.info
        const infoAgent = typeof info?.agent === "string" ? info.agent : undefined
        const normalized = normalizeAgentName(infoAgent)
        if (normalized) {
          return normalized
        }
      }
    } catch {
      return undefined
    }

    return undefined
  }

  const probeModelAvailability = async (sessionID: string, model: string): Promise<boolean> => {
    if (options?.probeModelAvailability) {
      return await options.probeModelAvailability({
        sessionID,
        model,
        directory: ctx.directory,
      })
    }

    const cliModel = splitWatchdogCliModel(model)

    return await new Promise<boolean>((resolve) => {
      const variantArgs = cliModel.variant ? ["--variant", cliModel.variant] : []
      const child = spawn(
        "opencode",
        [
          "run",
          "--dir",
          ctx.directory,
          "--model",
          cliModel.model,
          ...variantArgs,
          "Reply with OK only.",
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      )

      let stdout = ""
      let stderr = ""
      let settled = false

      const finalize = (result: boolean) => {
        if (settled) return
        settled = true
        resolve(result)
      }

      const timeout = setTimeout(() => {
        try {
          child.kill("SIGKILL")
        } catch {
        }
        finalize(false)
      }, MODEL_RECOVERY_PROBE_TIMEOUT_MS)

      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString()
      })

      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString()
      })

      child.on("error", () => {
        clearTimeout(timeout)
        finalize(false)
      })

      child.on("close", (code) => {
        clearTimeout(timeout)
        const output = `${stdout}\n${stderr}`
        finalize(code === 0 && /\bOK\b/i.test(output))
      })
    })
  }

  const maybeProbePreferredRecovery = async (
    sessionID: string,
    resolvedAgent: string | undefined,
  ): Promise<string | undefined> => {
    const state = sessionStates.get(sessionID)
    if (!state) {
      return undefined
    }

    const candidates = getRecoveryProbeCandidates(state)
    if (candidates.length === 0) {
      return undefined
    }

    for (const candidate of candidates) {
      const probeKey = `${sessionID}:${candidate}`
      const lastAttemptAt = recoveryProbeLastAttemptAt.get(probeKey) ?? 0
      if (Date.now() - lastAttemptAt < MODEL_RECOVERY_PROBE_MIN_INTERVAL_MS) {
        continue
      }

      recoveryProbeLastAttemptAt.set(probeKey, Date.now())
      const available = await probeModelAvailability(sessionID, candidate)

      if (!available) {
        state.failedModels.set(candidate, Date.now())
        log(`[${HOOK_NAME}] Recovery probe still failing for higher-priority model`, {
          sessionID,
          candidate,
        })
        continue
      }

      state.failedModels.delete(candidate)
      const recoveredModel = recoverPreferredModel(state, config.cooldown_seconds)
      if (!recoveredModel) {
        continue
      }

      log(`[${HOOK_NAME}] Recovery probe restored higher-priority model`, {
        sessionID,
        recoveredModel,
      })

      if (sessionAwaitingFallbackResult.has(sessionID)) {
        await autoRetryWithFallback(sessionID, recoveredModel, resolvedAgent, "model.recovery.probe")
      }

      return recoveredModel
    }

    return undefined
  }

  const cleanupStaleSessions = () => {
    const now = Date.now()
    let cleanedCount = 0
    for (const [sessionID, lastAccess] of sessionLastAccess.entries()) {
      if (now - lastAccess > SESSION_TTL_MS) {
        sessionStates.delete(sessionID)
        sessionLastAccess.delete(sessionID)
        sessionLastUserMessageIDs.delete(sessionID)
        sessionRecentCompletionUntil.delete(sessionID)
        sessionRetryInFlight.delete(sessionID)
        sessionAwaitingFallbackResult.delete(sessionID)
        clearSessionFallbackTimeout(sessionID)
        SessionCategoryRegistry.remove(sessionID)
        sessionStatusRetryKeys.delete(sessionID)
        for (const probeKey of recoveryProbeLastAttemptAt.keys()) {
          if (probeKey.startsWith(`${sessionID}:`)) {
            recoveryProbeLastAttemptAt.delete(probeKey)
          }
        }
        cleanedCount++
      }
    }
    if (cleanedCount > 0) {
      log(`[${HOOK_NAME}] Cleaned up ${cleanedCount} stale session states`)
    }
  }

  const recoverPreferredModels = async () => {
    for (const [sessionID, state] of sessionStates.entries()) {
      const recoveredModel = recoverPreferredModel(state, config.cooldown_seconds)
      if (!recoveredModel) {
        const resolvedAgent = await resolveAgentForSessionFromContext(sessionID)
        await maybeProbePreferredRecovery(sessionID, resolvedAgent)
        continue
      }

      sessionLastAccess.set(sessionID, Date.now())
      log(`[${HOOK_NAME}] Background recovery promoted session back to a higher-priority model`, {
        sessionID,
        recoveredModel,
      })

      if (sessionAwaitingFallbackResult.has(sessionID)) {
        const resolvedAgent = await resolveAgentForSessionFromContext(sessionID)
        await autoRetryWithFallback(sessionID, recoveredModel, resolvedAgent, "model.recovery.cooldown")
      }
    }
  }

  return {
    abortSessionRequest,
    clearSessionFallbackTimeout,
    scheduleSessionFallbackTimeout,
    autoRetryWithFallback,
    retryCurrentModel,
    resolveAgentForSessionFromContext,
    cleanupStaleSessions,
    recoverPreferredModels,
  }
}

export type AutoRetryHelpers = ReturnType<typeof createAutoRetryHelpers>
