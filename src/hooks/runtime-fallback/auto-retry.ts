import { spawn } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HookDeps, RuntimeFallbackTimeout } from "./types"
import { HOOK_NAME } from "./constants"
import { log } from "../../shared/logger"
import { normalizeAgentName, resolveAgentForSession } from "./agent-resolver"
import { getSessionAgent } from "../../features/claude-code-session-state"
import { getFallbackModelsForSession } from "./fallback-models"
import { prepareFallback } from "./fallback-state"
import { recoverPreferredModel } from "./fallback-state"
import { SessionCategoryRegistry } from "../../shared/session-category-registry"
import { buildRetryModelPayload } from "./retry-model-payload"
import { getLastUserRetryParts } from "./last-user-retry-parts"
import { extractSessionMessages } from "./session-messages"
import { getAgentDisplayName } from "../../shared/agent-display-names"

const SESSION_TTL_MS = 30 * 60 * 1000
const EXTERNAL_WATCHDOG_RESPAWN_MS = 10_000
const EXTERNAL_WATCHDOG_MIN_TIMEOUT_MS = 1_000
const EXTERNAL_WATCHDOG_DIR = join(tmpdir(), "oh-my-opencode-watchdogs")
const EXTERNAL_WATCHDOG_LOG = join(tmpdir(), "oh-my-opencode-watchdog.log")

declare function setTimeout(callback: () => void | Promise<void>, delay?: number): RuntimeFallbackTimeout
declare function clearTimeout(timeout: RuntimeFallbackTimeout): void

export function createAutoRetryHelpers(deps: HookDeps) {
  const {
    ctx,
    config,
    options,
    sessionStates,
    sessionLastAccess,
    sessionRetryInFlight,
    sessionAwaitingFallbackResult,
    sessionFallbackTimeouts,
    pluginConfig,
    sessionStatusRetryKeys,
  } = deps
  const externalWatchdogSpawnedAt = new Map<string, number>()

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

  const selectNextExternalWatchdogModel = (currentModel: string, fallbackModels: string[]): string | undefined => {
    for (const candidate of fallbackModels) {
      if (candidate && candidate !== currentModel) {
        return candidate
      }
    }

    return currentModel || undefined
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

    const fallbackModels = getFallbackModelsForSession(args.sessionID, args.resolvedAgent, pluginConfig)
    const nextModel = selectNextExternalWatchdogModel(args.currentModel, fallbackModels)
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

    const agentDisplayName = args.resolvedAgent ? getAgentDisplayName(args.resolvedAgent) : ""
    const cliModel = splitWatchdogCliModel(nextModel)
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
  exec opencode run -s "$SESSION_ID" --dir "$SESSION_DIR" --model "$NEXT_MODEL" "\${VARIANT_ARGS[@]}" --agent "$AGENT_NAME" "Continue the current task from where you left off. The previous request appears stalled. Resume from the existing context, do not redo completed work, and continue." >> "$WATCHDOG_LOG" 2>&1
else
  exec opencode run -s "$SESSION_ID" --dir "$SESSION_DIR" --model "$NEXT_MODEL" "\${VARIANT_ARGS[@]}" "Continue the current task from where you left off. The previous request appears stalled. Resume from the existing context, do not redo completed work, and continue." >> "$WATCHDOG_LOG" 2>&1
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
          agentDisplayName,
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
        agentDisplayName: agentDisplayName || undefined,
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

  const clearSessionFallbackTimeout = (sessionID: string) => {
    const timer = sessionFallbackTimeouts.get(sessionID)
    if (timer) {
      clearTimeout(timer)
      sessionFallbackTimeouts.delete(sessionID)
    }
    invalidateExternalWatchdog(sessionID)
  }

  const scheduleSessionFallbackTimeout = (sessionID: string, args?: {
    resolvedAgent?: string
    source?: string
  }) => {
    const source = args?.source ?? "session.timeout"
    const hadExistingTimer = sessionFallbackTimeouts.has(sessionID)
    clearSessionFallbackTimeout(sessionID)

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

    log(
      `[${HOOK_NAME}] ${hadExistingTimer ? "Refreshed" : "Armed"} session fallback timeout`,
      {
        sessionID,
        source,
        timeoutMs,
        currentModel: stateAtSchedule.currentModel,
      },
    )
    armExternalWatchdog({
      sessionID,
      timeoutMs,
      source,
      resolvedAgent: args?.resolvedAgent,
      currentModel: stateAtSchedule.currentModel,
    })

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

        if (sessionRetryInFlight.has(sessionID)) {
          log(`[${HOOK_NAME}] Overriding in-flight retry due to session timeout`, { sessionID, source })
        }

        await abortSessionRequest(sessionID, source)
        sessionRetryInFlight.delete(sessionID)

        if (state.pendingFallbackModel) {
          state.pendingFallbackModel = undefined
        }

        const resolvedAgent = args?.resolvedAgent ?? await resolveAgentForSessionFromContext(sessionID)
        const fallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, pluginConfig)
        if (fallbackModels.length === 0) {
          log(`[${HOOK_NAME}] Session fallback timeout reached but no fallback models were resolved`, {
            sessionID,
            source,
            resolvedAgent,
          })
          return
        }

        const lastAccess = sessionLastAccess.get(sessionID)
        log(`[${HOOK_NAME}] Session fallback timeout reached`, {
          sessionID,
          source,
          timeoutSeconds: config.timeout_seconds,
          currentModel: state.currentModel,
          resolvedAgent,
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

  const autoRetryWithFallback = async (
    sessionID: string,
    newModel: string,
    resolvedAgent: string | undefined,
    source: string,
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
        log(`[${HOOK_NAME}] Auto-retrying with fallback model (${source})`, {
          sessionID,
          model: newModel,
        })

        const retryAgent = resolvedAgent ?? getSessionAgent(sessionID)
        const retryAgentDisplayName = retryAgent ? getAgentDisplayName(retryAgent) : undefined
        sessionAwaitingFallbackResult.add(sessionID)
        scheduleSessionFallbackTimeout(sessionID, {
          resolvedAgent: retryAgent,
          source,
        })

        await ctx.client.session.promptAsync({
          path: { id: sessionID },
          body: {
            ...(retryAgentDisplayName ? { agent: retryAgentDisplayName } : {}),
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
      }
    }
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

  const cleanupStaleSessions = () => {
    const now = Date.now()
    let cleanedCount = 0
    for (const [sessionID, lastAccess] of sessionLastAccess.entries()) {
      if (now - lastAccess > SESSION_TTL_MS) {
        sessionStates.delete(sessionID)
        sessionLastAccess.delete(sessionID)
        sessionRetryInFlight.delete(sessionID)
        sessionAwaitingFallbackResult.delete(sessionID)
        clearSessionFallbackTimeout(sessionID)
        SessionCategoryRegistry.remove(sessionID)
        sessionStatusRetryKeys.delete(sessionID)
        cleanedCount++
      }
    }
    if (cleanedCount > 0) {
      log(`[${HOOK_NAME}] Cleaned up ${cleanedCount} stale session states`)
    }
  }

  const recoverPreferredModels = () => {
    for (const [sessionID, state] of sessionStates.entries()) {
      const recoveredModel = recoverPreferredModel(state, config.cooldown_seconds)
      if (!recoveredModel) {
        continue
      }

      sessionLastAccess.set(sessionID, Date.now())
      log(`[${HOOK_NAME}] Background recovery promoted session back to a higher-priority model`, {
        sessionID,
        recoveredModel,
      })
    }
  }

  return {
    abortSessionRequest,
    clearSessionFallbackTimeout,
    scheduleSessionFallbackTimeout,
    autoRetryWithFallback,
    resolveAgentForSessionFromContext,
    cleanupStaleSessions,
    recoverPreferredModels,
  }
}

export type AutoRetryHelpers = ReturnType<typeof createAutoRetryHelpers>
