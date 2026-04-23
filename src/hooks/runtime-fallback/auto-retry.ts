import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { FallbackState, HookDeps, RuntimeFallbackTimeout } from "./types"
import {
  FALLBACK_CONTINUATION_PROMPT,
  HOOK_NAME,
  MODEL_RECOVERY_PROBE_MIN_INTERVAL_MS,
  MODEL_RECOVERY_PROBE_TIMEOUT_MS,
  STALLED_SESSION_NUDGE_MS,
  WATCHDOG_CONTINUATION_PROMPT,
  isLongRunningAssistantProgress,
  isPreExecutionRegroupToolProgress,
  resolveLongRunningProgressTimeoutMs,
} from "./constants"
import { log } from "../../shared/logger"
import { normalizeAgentName, resolveAgentForSession } from "./agent-resolver"
import { getSessionAgent } from "../../features/claude-code-session-state"
import { getFallbackModelsForSession } from "./fallback-models"
import {
  createFallbackState,
  beginTransientRetryWindow,
  canAutoResumeRecoveredModel,
  canKeepRetryingTransiently,
  getNextTransientRetryDelayMs,
  getPreferredRecoveryCandidate,
  inheritCanonicalRetryParts,
  inheritFreshSameModelRetryWindow,
  isRecentLimitError,
  isFreshSameModelRetryWindowOpen,
  markTransientRetryDispatched,
  prepareFallback,
  markRecoveredModelAutoResume,
  recordFreshSameModelRetry,
  recoverPreferredModel,
  resetTransientRetryState,
  wasRecentlyStopped,
} from "./fallback-state"
import { SessionCategoryRegistry } from "../../shared/session-category-registry"
import { buildRetryModelPayload } from "./retry-model-payload"
import { resolveRetryBriefParts } from "./last-user-retry-parts"
import { extractSessionMessages } from "./session-messages"
import { createInternalAgentTextPart } from "../../shared/internal-initiator-marker"
import { getServerBaseUrl } from "../../shared/opencode-http-api"
import { getRuntimeFallbackTransitionMode } from "./fallback-transition-policy"
import {
  isPrimaryRuntimeAgent,
  normalizeAgentForPrompt,
  normalizeAgentForExecution,
  normalizeAgentForSessionPrompt,
} from "../../shared/agent-display-names"
import {
  getRecoveryProbeCandidates,
  getRuntimeFallbackTier,
  selectFallbackModelsForAction,
} from "./fallback-policy"
import { inspectParentSessionTasks } from "../../features/background-agent/parent-session-tasks"
import { getAgentFromSession } from "../prometheus-md-only/agent-resolution"
import { readBoulderState } from "../../features/boulder-state"
import {
  RUNTIME_FALLBACK_SCOPED_HANDOFF_TITLE_PREFIX,
} from "../../shared/runtime-fallback-session-titles"
import { markRecentRuntimeFallbackContinuationDispatch } from "../../shared/recent-runtime-fallback-continuation"
import { normalizeSDKResponse } from "../../shared/normalize-sdk-response"
import { hasVisibleAssistantEventContent } from "./visible-assistant-response"
import { extractAutoRetrySignal } from "./error-classifier"
import { getScopedFallbackParentSessionHint } from "./scoped-fallback-hints"
import { markGlobalModelCooldown } from "./global-model-cooldown"

const SESSION_TTL_MS = 30 * 60 * 1000
const EXTERNAL_WATCHDOG_RESPAWN_MS = 10_000
const EXTERNAL_WATCHDOG_MIN_TIMEOUT_MS = 1_000
const SESSION_MESSAGES_REQUEST_TIMEOUT_MS = 5_000
const EXTERNAL_WATCHDOG_DIR = join(tmpdir(), "oh-my-opencode-watchdogs")
const EXTERNAL_WATCHDOG_LOG = join(tmpdir(), "oh-my-opencode-watchdog.log")
const EXTERNAL_WATCHDOG_RUNNER = fileURLToPath(
  new URL("../../../script/runtime-fallback-external-watchdog.ts", import.meta.url),
)
const RECOVERY_PROBE_DIR_PREFIX = "oh-my-opencode-recovery-probe-"
const RECOVERY_PROBE_PROMPT = "Reply with OK only."
const RECOVERY_PROBE_RUNTIME_FALLBACK_DISABLE_ENV = "OH_MY_OPENCODE_DISABLE_RUNTIME_FALLBACK"
const SCOPED_FALLBACK_HANDOFF_MAX_BRIEF_CHARS = 4000
const FRESH_SAME_MODEL_RETRY_WINDOW_MS = 5 * 60 * 1000
const RECOVERY_PROBE_FAILURE_PATTERNS = [
  /\[session\.error\]/i,
  /\bsession ended with error\b/i,
  /\bai_?apicallerror\b/i,
  /\bout of extra usage\b/i,
  /\bextra usage is required for long context requests\b/i,
  /\bquota\b/i,
  /\busage limit\b/i,
  /\bout of credits?\b/i,
  /\bpayment required\b/i,
  /continue the current task from where you left off/i,
]

type RuntimeFallbackSessionStatus = {
  type?: string
}

type RuntimeFallbackChildSession = {
  id?: string
}

const NON_TERMINAL_SESSION_FINISH_REASONS = new Set(["tool-calls", "unknown"])

declare function setTimeout(callback: () => void | Promise<void>, delay?: number): RuntimeFallbackTimeout
declare function clearTimeout(timeout: RuntimeFallbackTimeout): void

function getWatchdogModelIdentity(model: string): string {
  return model.replace(/\([^()]+\)$/, "").trim()
}

function shouldOmitRetryAgent(
  targetModel: string,
  originalModel?: string,
  retryAgent?: string,
): boolean {
  if (!originalModel) {
    return false
  }

  if (getWatchdogModelIdentity(targetModel) === getWatchdogModelIdentity(originalModel)) {
    return false
  }

  const normalizedAgent = normalizeAgentName(retryAgent)
  return !normalizedAgent
}

function isBoulderTrackedExecutionSession(sessionID: string, directory: string): boolean {
  const boulderState = readBoulderState(directory)
  return Boolean(boulderState?.session_ids?.includes(sessionID))
}

function getExplicitLiveRetryAgent(resolvedAgent?: string): string | undefined {
  return normalizeAgentName(resolvedAgent) ?? resolvedAgent
}

function formatScopedFallbackBrief(
  parts: Array<{ type?: string; text?: string }>,
): string {
  const text = parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n")

  if (!text) {
    return "No reusable user brief was available from the parent session. Continue from the parent session lineage only."
  }

  if (text.length <= SCOPED_FALLBACK_HANDOFF_MAX_BRIEF_CHARS) {
    return text
  }

  return `${text.slice(0, SCOPED_FALLBACK_HANDOFF_MAX_BRIEF_CHARS).trim()}\n\n[Brief truncated for scoped fallback handoff]`
}

function hasTerminalAssistantCompletion(messagesResponse: unknown): boolean {
  const messages = extractSessionMessages(messagesResponse)
  if (!messages?.length) {
    return false
  }

  let lastUserID: string | undefined
  let lastAssistantID: string | undefined
  let lastAssistantFinish: string | undefined

  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i]?.info
    const role = typeof info?.role === "string" ? info.role : undefined
    const id = typeof info?.id === "string" ? info.id : undefined

    if (!lastAssistantID && role === "assistant") {
      lastAssistantID = id
      lastAssistantFinish = typeof info?.finish === "string" ? info.finish : undefined
    }

    if (!lastUserID && role === "user") {
      lastUserID = id
    }

    if (lastUserID && lastAssistantID) {
      break
    }
  }

  if (!lastUserID || !lastAssistantID || !lastAssistantFinish) {
    return false
  }

  if (NON_TERMINAL_SESSION_FINISH_REASONS.has(lastAssistantFinish)) {
    return false
  }

  return lastUserID < lastAssistantID
}

function inspectLatestAssistantProgress(messagesResponse: unknown): {
  hasTerminalCompletion: boolean
  hasVisibleNonTerminalResponse?: boolean
  blockingProgress?:
    | {
        partType?: string
        toolName?: string
        toolStatus?: string
      }
} {
  const messages = extractSessionMessages(messagesResponse)
  if (!messages?.length) {
    return { hasTerminalCompletion: false }
  }

  let lastUserIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = typeof messages[i]?.info?.role === "string" ? messages[i].info?.role : undefined
    if (role === "user") {
      lastUserIndex = i
      break
    }
  }

  let lastAssistantMessage: (typeof messages)[number] | undefined
  const assistantMessages: Array<(typeof messages)[number]> = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = typeof messages[i]?.info?.role === "string" ? messages[i].info?.role : undefined
    if (role !== "assistant") {
      continue
    }
    if (lastUserIndex >= 0 && i <= lastUserIndex) {
      break
    }
    assistantMessages.unshift(messages[i])
    lastAssistantMessage = messages[i]
  }

  if (!lastAssistantMessage) {
    return { hasTerminalCompletion: false }
  }

  const finish = typeof lastAssistantMessage.info?.finish === "string"
    ? lastAssistantMessage.info.finish
    : undefined
  if (finish && !NON_TERMINAL_SESSION_FINISH_REASONS.has(finish)) {
    return { hasTerminalCompletion: true }
  }

  let hasVisibleNonTerminalResponse = false
  for (let messageIndex = assistantMessages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const assistantMessage = assistantMessages[messageIndex]
    const infoParts = Array.isArray(assistantMessage.info?.parts)
      ? assistantMessage.info.parts
      : []
    const parts = Array.isArray(assistantMessage.parts) && assistantMessage.parts.length > 0
      ? assistantMessage.parts
      : infoParts

    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i]
      const partType = typeof part?.type === "string" ? part.type : undefined
      const toolName = typeof part?.tool === "string"
        ? part.tool
        : typeof part?.name === "string"
          ? part.name
          : undefined
      const toolStatus = typeof part?.state?.status === "string" ? part.state.status : undefined

      if (isLongRunningAssistantProgress({ partType, toolName, toolStatus })) {
        return {
          hasTerminalCompletion: false,
          blockingProgress: {
            partType,
            toolName,
            toolStatus,
          },
        }
      }
    }

    if (!assistantMessage.info?.error) {
      hasVisibleNonTerminalResponse ||= hasVisibleAssistantEventContent(
        extractAutoRetrySignal,
        {
          message: assistantMessage.info?.message,
          parts,
        },
      )
    }
  }

  if (hasVisibleNonTerminalResponse) {
    return {
      hasTerminalCompletion: false,
      hasVisibleNonTerminalResponse: true,
    }
  }

  return { hasTerminalCompletion: false }
}

function buildScopedFallbackHandoffPrompt(args: {
  parentSessionID: string
  newModel: string
  lastUserRetryParts: Array<{ type?: string; text?: string }>
}): string {
  const brief = formatScopedFallbackBrief(args.lastUserRetryParts)
  return [
    "Scoped fallback handoff.",
    `Parent session: ${args.parentSessionID}`,
    `Fallback model: ${args.newModel}`,
    "Continue the existing task from the current project state.",
    "Do not restate the full user request or redo completed work.",
    "Focus only on the next unresolved step and keep the result compact.",
    "",
    "Task brief:",
    brief,
  ].join("\n")
}

function buildFreshPaidRetryHandoffPrompt(args: {
  parentSessionID: string
  currentModel: string
  lastUserRetryParts: Array<{ type?: string; text?: string }>
}): string {
  const brief = formatScopedFallbackBrief(args.lastUserRetryParts)
  return [
    "Fresh paid retry handoff.",
    `Parent session: ${args.parentSessionID}`,
    `Retry model: ${args.currentModel}`,
    "Retry on the same paid model in a fresh session.",
    "Preserve the parent context and continue the current task without restarting from scratch.",
    "Do not restate the full request or redo completed work.",
    "Focus only on the next unresolved step.",
    "",
    "Task brief:",
    brief,
  ].join("\n")
}

export function selectExternalWatchdogModel(
  currentModel: string,
  fallbackModels: string[],
  options?: {
    originalModel?: string
  },
): string | undefined {
  const configuredModels = fallbackModels.filter((candidate) => Boolean(candidate))
  if (!currentModel) {
    return configuredModels[0]
  }

  const currentIdentity = getWatchdogModelIdentity(currentModel)
  const originalIdentity = options?.originalModel
    ? getWatchdogModelIdentity(options.originalModel)
    : undefined

  if (originalIdentity && currentIdentity === originalIdentity) {
    return configuredModels.find((candidate) => getWatchdogModelIdentity(candidate) !== currentIdentity)
      ?? configuredModels[0]
      ?? currentModel
  }

  return currentModel
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

export function didRecoveryProbeSucceed(
  exitCode: number | null | undefined,
  output: string,
): boolean {
  if (exitCode !== 0) {
    return false
  }

  if (!/\bok\b/i.test(output)) {
    return false
  }

  return !RECOVERY_PROBE_FAILURE_PATTERNS.some((pattern) => pattern.test(output))
}

function terminateChildProcessTree(
  child: {
    pid?: number
    kill: (signal?: number | NodeJS.Signals) => boolean
  },
  signal: NodeJS.Signals = "SIGKILL",
): void {
  const pid = child.pid
  if (typeof pid === "number" && pid > 0 && process.platform !== "win32") {
    try {
      process.kill(-pid, signal)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code !== "ESRCH") {
        log(`[${HOOK_NAME}] Failed to kill detached child process group`, {
          pid,
          signal,
          error: String(error),
        })
      }
    }
  }

  try {
    child.kill(signal)
  } catch {
  }
}

function isBlockingDescendantSessionStatus(type: string | undefined): boolean {
  return type === "busy" || type === "retry" || type === "running"
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
  const sessionTimeoutRecoveryInProgress =
    deps.sessionTimeoutRecoveryInProgress ?? new Set<string>()
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

  const getExternalWatchdogPidPath = (sessionID: string): string =>
    join(EXTERNAL_WATCHDOG_DIR, `${sessionID}.pid`)

  const readExternalWatchdogPid = (sessionID: string): number | undefined => {
    try {
      const rawPid = readFileSync(getExternalWatchdogPidPath(sessionID), "utf-8").trim()
      const pid = Number(rawPid)
      return Number.isInteger(pid) && pid > 0 ? pid : undefined
    } catch {
      return undefined
    }
  }

  const clearExternalWatchdogPid = (sessionID: string): void => {
    try {
      rmSync(getExternalWatchdogPidPath(sessionID), { force: true })
    } catch {
    }
  }

  const terminateExternalWatchdogProcess = (sessionID: string): void => {
    const pid = readExternalWatchdogPid(sessionID)
    clearExternalWatchdogPid(sessionID)
    if (!pid) {
      return
    }

    try {
      process.kill(pid, "SIGKILL")
    } catch {
    }
  }

  const hasLiveExternalWatchdogProcess = (sessionID: string): boolean => {
    const pid = readExternalWatchdogPid(sessionID)
    if (!pid) {
      return false
    }

    try {
      process.kill(pid, 0)
      return true
    } catch {
      clearExternalWatchdogPid(sessionID)
      return false
    }
  }

  const invalidateExternalWatchdog = (sessionID: string): void => {
    externalWatchdogSpawnedAt.delete(sessionID)
    try {
      rmSync(getExternalWatchdogTokenPath(sessionID), { force: true })
    } catch {
    }
    terminateExternalWatchdogProcess(sessionID)
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
    originalModel?: string
  }): void => {
    if (args.timeoutMs < EXTERNAL_WATCHDOG_MIN_TIMEOUT_MS) {
      return
    }
    if (
      process.env.NODE_ENV === "test"
      && options?.allow_external_watchdog_in_tests !== true
    ) {
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
    const nextModel = selectExternalWatchdogModel(args.currentModel, fallbackModels, {
      originalModel: args.originalModel,
    })
    if (!nextModel) {
      log(`[${HOOK_NAME}] Skipping external watchdog arm without fallback model`, {
        sessionID: args.sessionID,
        source: args.source,
        currentModel: args.currentModel,
      })
      return
    }

    const transitionMode = getRuntimeFallbackTransitionMode({
      resolvedAgent: args.resolvedAgent,
      currentModel: args.currentModel,
      newModel: nextModel,
    })
    if (transitionMode === "scoped_handoff") {
      log(`[${HOOK_NAME}] Skipping external watchdog because fallback requires scoped handoff`, {
        sessionID: args.sessionID,
        source: args.source,
        currentModel: args.currentModel,
        nextModel,
        resolvedAgent: args.resolvedAgent,
      })
      return
    }

    ensureExternalWatchdogDir()

    const now = Date.now()
    const lastSpawnedAt = externalWatchdogSpawnedAt.get(args.sessionID) ?? 0
    const tokenPath = getExternalWatchdogTokenPath(args.sessionID)
    const hasLiveProcess = hasLiveExternalWatchdogProcess(args.sessionID)
    const hasRecentToken = existsSync(tokenPath)

    if ((hasLiveProcess || hasRecentToken) && now - lastSpawnedAt < EXTERNAL_WATCHDOG_RESPAWN_MS) {
      log(`[${HOOK_NAME}] Refreshed external watchdog token without respawn`, {
        sessionID: args.sessionID,
        source: args.source,
        timeoutMs: args.timeoutMs,
        nextModel,
      })
      return
    }

    if (hasLiveProcess) {
      terminateExternalWatchdogProcess(args.sessionID)
    }

    const token = `${now}-${Math.random().toString(36).slice(2, 10)}`

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

    const cliModel = splitWatchdogCliModel(nextModel)
    const cliAgent = shouldOmitRetryAgent(
      nextModel,
      args.originalModel ?? args.currentModel,
      args.resolvedAgent,
    )
      ? ""
      : resolveExternalWatchdogAgent(args.resolvedAgent)
    const internalWatchdogPrompt = createInternalAgentTextPart(FALLBACK_CONTINUATION_PROMPT).text
    const serverBaseUrl = getServerBaseUrl(ctx.client)
    const command = serverBaseUrl ? "bun" : "/bin/zsh"
    const commandArgs = serverBaseUrl
      ? [
          EXTERNAL_WATCHDOG_RUNNER,
          String(Math.max(1, Math.ceil(args.timeoutMs / 1000))),
          tokenPath,
          token,
          args.sessionID,
          ctx.directory,
          serverBaseUrl,
          cliModel.model,
          cliModel.variant ?? "",
          cliAgent,
          internalWatchdogPrompt,
          EXTERNAL_WATCHDOG_LOG,
        ]
      : undefined
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
PROMPT="$(cat <<'__OMO_WATCHDOG_PROMPT__'
${internalWatchdogPrompt}
__OMO_WATCHDOG_PROMPT__
)"
if [ -n "$AGENT_NAME" ]; then
  exec opencode run -s "$SESSION_ID" --dir "$SESSION_DIR" --model "$NEXT_MODEL" "\${VARIANT_ARGS[@]}" --agent "$AGENT_NAME" "$PROMPT" >> "$WATCHDOG_LOG" 2>&1
else
  exec opencode run -s "$SESSION_ID" --dir "$SESSION_DIR" --model "$NEXT_MODEL" "\${VARIANT_ARGS[@]}" "$PROMPT" >> "$WATCHDOG_LOG" 2>&1
fi
`

    try {
      const child = spawn(
        command,
        commandArgs ?? [
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
      if (child.pid) {
        try {
          writeFileSync(getExternalWatchdogPidPath(args.sessionID), String(child.pid))
        } catch (error) {
          log(`[${HOOK_NAME}] Failed to persist external watchdog pid`, {
            sessionID: args.sessionID,
            source: args.source,
            error: String(error),
          })
        }

        child.on("exit", () => {
          const activePid = readExternalWatchdogPid(args.sessionID)
          if (activePid === child.pid) {
            clearExternalWatchdogPid(args.sessionID)
          }
        })
        child.on("error", () => {
          const activePid = readExternalWatchdogPid(args.sessionID)
          if (activePid === child.pid) {
            clearExternalWatchdogPid(args.sessionID)
          }
        })
      } else {
        log(`[${HOOK_NAME}] Spawned external watchdog without child pid; relying on token throttling`, {
          sessionID: args.sessionID,
          source: args.source,
          nextModel: cliModel.model,
          variant: cliModel.variant,
        })
      }
      externalWatchdogSpawnedAt.set(args.sessionID, now)
      log(`[${HOOK_NAME}] Armed external watchdog`, {
        sessionID: args.sessionID,
        source: args.source,
        timeoutMs: args.timeoutMs,
        nextModel: cliModel.model,
        variant: cliModel.variant,
        agentDisplayName: cliAgent || undefined,
        transport: serverBaseUrl ? "sdk" : "cli",
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

  const fetchSessionMessages = async (
    sessionID: string,
    source: string,
    directory = ctx.directory,
  ): Promise<unknown | undefined> => {
    const timeoutMs = Math.max(
      1,
      options?.session_messages_request_timeout_ms ?? SESSION_MESSAGES_REQUEST_TIMEOUT_MS,
    )
    let timeout: RuntimeFallbackTimeout | undefined

    try {
      return await Promise.race([
        ctx.client.session.messages({
          path: { id: sessionID },
          query: { directory },
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(`session.messages timed out after ${timeoutMs}ms`))
          }, timeoutMs)
        }),
      ])
    } catch (error) {
      log(`[${HOOK_NAME}] Failed to fetch session messages`, {
        sessionID,
        source,
        timeoutMs,
        error: String(error),
      })
      return undefined
    } finally {
      if (timeout) {
        clearTimeout(timeout)
      }
    }
  }

  const resolveFallbackSessionDirectory = async (sessionID: string): Promise<string> => {
    try {
      const sessionGet = ctx.client.session.get
      if (!sessionGet) {
        return ctx.directory
      }

      const session = await sessionGet({ path: { id: sessionID } })
      const sessionDirectory = session?.data?.directory
      return typeof sessionDirectory === "string" && sessionDirectory.trim().length > 0
        ? sessionDirectory
        : ctx.directory
    } catch {
      return ctx.directory
    }
  }

  const createScopedFallbackSession = async (args: {
    parentSessionID: string
    newModel: string
  }): Promise<{ sessionID: string; directory: string } | undefined> => {
    if (typeof ctx.client.session.create !== "function") {
      log(`[${HOOK_NAME}] Scoped fallback handoff unavailable because client.session.create is missing`, {
        sessionID: args.parentSessionID,
        newModel: args.newModel,
      })
      return undefined
    }

    const directory = await resolveFallbackSessionDirectory(args.parentSessionID)
    const modelLabel = args.newModel.split("/").pop() ?? args.newModel

    try {
      const createResult = await ctx.client.session.create({
        body: {
          parentID: args.parentSessionID,
          title: `${RUNTIME_FALLBACK_SCOPED_HANDOFF_TITLE_PREFIX}: ${modelLabel}`,
        },
        query: { directory },
      })

      if (createResult?.error || !createResult?.data?.id) {
        log(`[${HOOK_NAME}] Failed to create scoped fallback handoff session`, {
          sessionID: args.parentSessionID,
          newModel: args.newModel,
          error: String(createResult?.error ?? "missing session id"),
        })
        return undefined
      }

      return {
        sessionID: createResult.data.id,
        directory,
      }
    } catch (error) {
      log(`[${HOOK_NAME}] Failed to create scoped fallback handoff session`, {
        sessionID: args.parentSessionID,
        newModel: args.newModel,
        error: String(error),
      })
      return undefined
    }
  }

  const resolveFreshRetryParentSessionID = async (
    sessionID: string,
    state: FallbackState,
  ): Promise<string> => {
    if (!state.isScopedFallbackChild) {
      return sessionID
    }

    const stateScopedParentSessionID = typeof state.scopedFallbackParentSessionID === "string"
      ? state.scopedFallbackParentSessionID.trim()
      : ""
    if (stateScopedParentSessionID.length > 0) {
      return stateScopedParentSessionID
    }

    const hintedParentSessionID = getScopedFallbackParentSessionHint(deps, sessionID)?.trim()
    if (typeof hintedParentSessionID === "string" && hintedParentSessionID.length > 0) {
      state.scopedFallbackParentSessionID = hintedParentSessionID
      return hintedParentSessionID
    }

    const sessionGet = ctx.client.session.get
    if (typeof sessionGet !== "function") {
      return sessionID
    }

    try {
      const session = await sessionGet({ path: { id: sessionID } })
      const parentSessionID = typeof session?.data?.parentID === "string"
        ? session.data.parentID
        : (typeof (session?.data as { parentId?: string } | undefined)?.parentId === "string"
          ? (session?.data as { parentId?: string }).parentId
          : undefined)
      if (typeof parentSessionID === "string" && parentSessionID.trim().length > 0) {
        const normalizedParentSessionID = parentSessionID.trim()
        state.scopedFallbackParentSessionID = normalizedParentSessionID
        return normalizedParentSessionID
      }
    } catch (error) {
      log(`[${HOOK_NAME}] Failed to resolve fresh paid retry parent session`, {
        sessionID,
        model: state.currentModel,
        error: String(error),
      })
    }

    return sessionID
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

  const hasTerminalIdleMarker = (state: FallbackState): boolean => {
    if (typeof state.lastTerminalIdleAt !== "number") {
      return false
    }

    const lastMeaningfulProgressAt = state.lastMeaningfulProgressAt ?? 0
    const lastErrorAt = state.lastErrorAt ?? 0

    if (lastErrorAt > lastMeaningfulProgressAt) {
      return state.lastTerminalIdleAt < lastErrorAt
    }

    return state.lastTerminalIdleAt >= lastMeaningfulProgressAt
  }

  const getBackgroundTaskInspection = (sessionID: string) => inspectParentSessionTasks({
    backgroundManager: options?.backgroundManager,
    sessionID,
    logScope: HOOK_NAME,
  })

  const inspectDescendantSessions = async (sessionID: string): Promise<{
    available: boolean
    activeSessionIDs: string[]
  }> => {
    const sessionApi = ctx.client.session
    if (typeof sessionApi.status !== "function" || typeof sessionApi.children !== "function") {
      return {
        available: false,
        activeSessionIDs: [],
      }
    }

    try {
      const statusesResponse = await sessionApi.status({
        query: { directory: ctx.directory },
      })
      const statuses = normalizeSDKResponse(
        statusesResponse,
        {} as Record<string, RuntimeFallbackSessionStatus>,
      )
      const visited = new Set<string>()
      const activeSessionIDs = new Set<string>()

      const visitChildren = async (parentSessionID: string): Promise<void> => {
        if (visited.has(parentSessionID)) {
          return
        }
        visited.add(parentSessionID)

        const childrenResponse = await sessionApi.children!({
          path: { id: parentSessionID },
          query: { directory: ctx.directory },
        })
        const children = normalizeSDKResponse(
          childrenResponse,
          [] as RuntimeFallbackChildSession[],
        )

        for (const child of children) {
          const childSessionID = typeof child?.id === "string" ? child.id : undefined
          if (!childSessionID) {
            continue
          }

          const childRecoveryInProgress =
            sessionTimeoutRecoveryInProgress.has(childSessionID)
            || sessionRetryInFlight.has(childSessionID)
            || sessionTransientRetryTimeouts.has(childSessionID)

          if (childRecoveryInProgress) {
            activeSessionIDs.add(childSessionID)
            await visitChildren(childSessionID)
            continue
          }

          if (isBlockingDescendantSessionStatus(statuses[childSessionID]?.type)) {
            let treatAsActive = true

            try {
              const childMessagesResponse = await sessionApi.messages({
                path: { id: childSessionID },
                query: { directory: ctx.directory },
              })

              if (hasTerminalAssistantCompletion(childMessagesResponse)) {
                treatAsActive = false
                log(`[${HOOK_NAME}] Ignoring stale busy descendant session because it already completed`, {
                  sessionID,
                  childSessionID,
                  childStatus: statuses[childSessionID]?.type ?? "unknown",
                })
              }
            } catch (error) {
              log(`[${HOOK_NAME}] Failed to inspect descendant session messages`, {
                sessionID,
                childSessionID,
                error: String(error),
              })
            }

            if (treatAsActive) {
              activeSessionIDs.add(childSessionID)
            }
          }

          await visitChildren(childSessionID)
        }
      }

      await visitChildren(sessionID)

      return {
        available: true,
        activeSessionIDs: [...activeSessionIDs],
      }
    } catch (error) {
      log(`[${HOOK_NAME}] Failed to inspect descendant sessions`, {
        sessionID,
        error: String(error),
      })
      return {
        available: false,
        activeSessionIDs: [],
      }
    }
  }

  const isRecoveredAutoResumeEligible = (sessionID: string): boolean => {
    if (!sessionAwaitingFallbackResult.has(sessionID)) {
      return true
    }

    const baseTimeoutMs = options?.session_timeout_ms ?? config.timeout_seconds * 1000
    if (baseTimeoutMs <= 0) {
      return true
    }

    const lastAccess = sessionLastAccess.get(sessionID)
    if (typeof lastAccess !== "number") {
      return true
    }

    const quietWindowMs = resolveLongRunningProgressTimeoutMs(baseTimeoutMs)
    const lastAccessAgeMs = Math.max(0, Date.now() - lastAccess)
    if (lastAccessAgeMs >= quietWindowMs) {
      return true
    }

    log(`[${HOOK_NAME}] Skipping preferred-model auto-resume while fallback session still has recent progress`, {
      sessionID,
      quietWindowMs,
      lastAccessAgeMs,
    })
    return false
  }

  const scheduleSessionFallbackTimeout = (sessionID: string, args?: {
    resolvedAgent?: string
    source?: string
    mode?: "fallback" | "transient_retry"
    timeoutMsOverride?: number
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

    const baseTimeoutMs = options?.session_timeout_ms ?? config.timeout_seconds * 1000
    const backgroundTasksAtArm = getBackgroundTaskInspection(sessionID)
    const timeoutMs = backgroundTasksAtArm.hasActiveTasks
      ? Math.max(
        args?.timeoutMsOverride ?? baseTimeoutMs,
        resolveLongRunningProgressTimeoutMs(baseTimeoutMs),
      )
      : (args?.timeoutMsOverride ?? baseTimeoutMs)
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
        timeoutMsOverride: args?.timeoutMsOverride,
        currentModel: stateAtSchedule.currentModel,
      },
    )
    if (mode === "fallback" && !backgroundTasksAtArm.hasActiveTasks) {
      armExternalWatchdog({
        sessionID,
        timeoutMs,
        source,
        resolvedAgent: args?.resolvedAgent,
        currentModel: stateAtSchedule.currentModel,
        originalModel: stateAtSchedule.originalModel,
      })
    } else {
      invalidateExternalWatchdog(sessionID)
    }

    if (mode === "fallback" && backgroundTasksAtArm.hasActiveTasks) {
      log(`[${HOOK_NAME}] Skipped external watchdog while background tasks are active`, {
        sessionID,
        source,
        timeoutMs,
        activeBackgroundTaskCount: backgroundTasksAtArm.tasks.length,
      })
    }

    const timer = setTimeout(async () => {
      sessionTimeoutRecoveryInProgress.add(sessionID)
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

        const hadInFlightRetry = sessionRetryInFlight.has(sessionID)
        if (hadInFlightRetry) {
          log(`[${HOOK_NAME}] Overriding in-flight retry due to session timeout`, { sessionID, source })
          await abortSessionRequest(sessionID, source)
        }

        sessionRetryInFlight.delete(sessionID)

        const resolvedAgent = await resolveAgentForSessionFromContext(sessionID, args?.resolvedAgent)
          ?? args?.resolvedAgent
        const backgroundTasks = getBackgroundTaskInspection(sessionID)
        if (backgroundTasks.hasActiveTasks) {
          sessionLastAccess.set(sessionID, Date.now())
          scheduleSessionFallbackTimeout(sessionID, {
            resolvedAgent,
            source: `${source}.background-tasks-active`,
            timeoutMsOverride: resolveLongRunningProgressTimeoutMs(baseTimeoutMs),
          })
          log(`[${HOOK_NAME}] Deferred session fallback timeout while background tasks are active`, {
            sessionID,
            source,
            resolvedAgent,
            activeBackgroundTaskCount: backgroundTasks.tasks.length,
          })
          return
        }

        try {
          const currentMessagesResponse = await fetchSessionMessages(
            sessionID,
            `${source}.inspect-latest-assistant`,
          )
          if (currentMessagesResponse) {
            const currentAssistantProgress = inspectLatestAssistantProgress(currentMessagesResponse)
            if (currentAssistantProgress.hasTerminalCompletion) {
              log(`[${HOOK_NAME}] Skipping session timeout fallback because the session already completed`, {
                sessionID,
                source,
                resolvedAgent,
              })
              return
            }

            if (currentAssistantProgress.blockingProgress) {
              const blockingProgressQuietWindowMs = resolveLongRunningProgressTimeoutMs(baseTimeoutMs)
              const isPreExecutionRegroupProgress =
                isPreExecutionRegroupToolProgress(currentAssistantProgress.blockingProgress)
              const isDelegationToolProgress =
                currentAssistantProgress.blockingProgress.partType === "tool"
                && ["task", "call_omo_agent"].includes(currentAssistantProgress.blockingProgress.toolName ?? "")
                && ["pending", "running"].includes(currentAssistantProgress.blockingProgress.toolStatus ?? "")
              const blockingProgressFreshUntil = isPreExecutionRegroupProgress
                ? (
                  typeof state.longRunningProgressUntil === "number"
                    ? state.longRunningProgressUntil
                    : 0
                )
                : Math.max(
                  typeof state.lastMeaningfulProgressAt === "number"
                    ? state.lastMeaningfulProgressAt + blockingProgressQuietWindowMs
                    : 0,
                  typeof state.longRunningProgressUntil === "number"
                    ? state.longRunningProgressUntil
                    : 0,
                )

              if (isDelegationToolProgress || blockingProgressFreshUntil > Date.now()) {
                sessionLastAccess.set(sessionID, Date.now())
                scheduleSessionFallbackTimeout(sessionID, {
                  resolvedAgent,
                  source: `${source}.assistant-progress-active`,
                  timeoutMsOverride: blockingProgressQuietWindowMs,
                })
                log(`[${HOOK_NAME}] Deferred session fallback timeout while latest assistant tool progress is still active`, {
                  sessionID,
                  source,
                  resolvedAgent,
                  partType: currentAssistantProgress.blockingProgress.partType,
                  toolName: currentAssistantProgress.blockingProgress.toolName,
                  toolStatus: currentAssistantProgress.blockingProgress.toolStatus,
                  indefiniteDelegationDefer: isDelegationToolProgress || undefined,
                })
                return
              }

              log(`[${HOOK_NAME}] Stale assistant blocking progress no longer defers timeout fallback`, {
                sessionID,
                source,
                resolvedAgent,
                partType: currentAssistantProgress.blockingProgress.partType,
                toolName: currentAssistantProgress.blockingProgress.toolName,
                toolStatus: currentAssistantProgress.blockingProgress.toolStatus,
                lastMeaningfulProgressAt: state.lastMeaningfulProgressAt,
                longRunningProgressUntil: state.longRunningProgressUntil,
              })
            }

            if (
              currentAssistantProgress.hasVisibleNonTerminalResponse
              && typeof state.lastMeaningfulProgressAt === "number"
            ) {
              const visibleProgressAgeMs = Math.max(0, Date.now() - state.lastMeaningfulProgressAt)
              const visibleProgressQuietWindowMs = resolveLongRunningProgressTimeoutMs(baseTimeoutMs)
              if (visibleProgressAgeMs < visibleProgressQuietWindowMs) {
                sessionLastAccess.set(sessionID, Date.now())
                scheduleSessionFallbackTimeout(sessionID, {
                  resolvedAgent,
                  source: `${source}.assistant-visible-progress`,
                  timeoutMsOverride: visibleProgressQuietWindowMs,
                })
                log(`[${HOOK_NAME}] Deferred session fallback timeout while latest assistant visible progress is still fresh`, {
                  sessionID,
                  source,
                  resolvedAgent,
                  visibleProgressAgeMs,
                  visibleProgressQuietWindowMs,
                })
                return
              }
            }
          }
        } catch (error) {
          log(`[${HOOK_NAME}] Failed to inspect current session messages before timeout fallback`, {
            sessionID,
            source,
            error: String(error),
          })
        }

        const stateOnlyQuietWindowMs = resolveLongRunningProgressTimeoutMs(baseTimeoutMs)
        const stateOnlyFreshUntil = Math.max(
          typeof state.lastMeaningfulProgressAt === "number"
            ? state.lastMeaningfulProgressAt + stateOnlyQuietWindowMs
            : 0,
          typeof state.longRunningProgressUntil === "number"
            ? state.longRunningProgressUntil
            : 0,
        )
        if (stateOnlyFreshUntil > Date.now()) {
          const remainingFreshWindowMs = Math.max(1, stateOnlyFreshUntil - Date.now())
          sessionLastAccess.set(sessionID, Date.now())
          scheduleSessionFallbackTimeout(sessionID, {
            resolvedAgent,
            source: `${source}.assistant-live-state`,
            timeoutMsOverride: remainingFreshWindowMs,
          })
          log(`[${HOOK_NAME}] Deferred session fallback timeout from live progress state while transcript is stale`, {
            sessionID,
            source,
            resolvedAgent,
            lastMeaningfulProgressAt: state.lastMeaningfulProgressAt,
            longRunningProgressUntil: state.longRunningProgressUntil,
            remainingFreshWindowMs,
          })
          return
        }

        const descendantSessions = await inspectDescendantSessions(sessionID)
        if (descendantSessions.activeSessionIDs.length > 0) {
          sessionLastAccess.set(sessionID, Date.now())
          scheduleSessionFallbackTimeout(sessionID, {
            resolvedAgent,
            source: `${source}.descendant-sessions-active`,
            timeoutMsOverride: resolveLongRunningProgressTimeoutMs(baseTimeoutMs),
          })
          log(`[${HOOK_NAME}] Deferred session fallback timeout while descendant sessions are active`, {
            sessionID,
            source,
            resolvedAgent,
            activeDescendantSessionIDs: descendantSessions.activeSessionIDs,
          })
          return
        }

        if (mode === "transient_retry" && state.pendingTransientRetry) {
          await abortSessionRequest(sessionID, source)
          const persistentTransientRetry = state.persistentTransientRetry ?? false
          state.pendingTransientRetry = false

          const retryRescheduled =
            (persistentTransientRetry || canKeepRetryingTransiently(state, config))
            && scheduleTransientRetry(sessionID, resolvedAgent, `${source}.transient-timeout`, {
              persistent: persistentTransientRetry,
            })
          if (retryRescheduled) {
            return
          }

          if (
            typeof state.transientRetryMaxAttempts === "number"
            && getRuntimeFallbackTier(state.currentModel) === "paid"
          ) {
            const freshRetried = await retryCurrentModelInFreshSession(
              sessionID,
              resolvedAgent,
              `${source}.transient-timeout`,
            )
            if (freshRetried) {
              resetTransientRetryState(state)
              return
            }
          }
        }

        if (state.pendingFallbackModel) {
          state.pendingFallbackModel = undefined
        }

        const timeoutAction = isRecentLimitError(state) ? "limit_fallback" : "fallback_chain"
        if (
          mode === "fallback"
          && timeoutAction === "fallback_chain"
          && getRuntimeFallbackTier(state.currentModel) === "paid"
        ) {
          const freshRetried = await retryCurrentModelInFreshSession(
            sessionID,
            resolvedAgent,
            `${source}.timeout`,
          )
          if (freshRetried) {
            return
          }
        }

        const allFallbackModels = getFallbackModelsForSession(sessionID, resolvedAgent, pluginConfig)
        if (allFallbackModels.length === 0) {
          log(`[${HOOK_NAME}] Session fallback timeout reached but no fallback models were resolved`, {
            sessionID,
            source,
            resolvedAgent,
            timeoutAction,
          })
          return
        }

        // If the session previously hit a quota/limit, route directly to spark
        // then free-tier models instead of retrying paid models that are capped.
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

        const result = prepareFallback(sessionID, state, fallbackModels, config, {
          ignoreCandidateCooldown:
            timeoutAction === "limit_fallback"
            && getRuntimeFallbackTier(state.currentModel) !== "paid",
        })
        if (result.success && result.newModel) {
          const transitionMode = getRuntimeFallbackTransitionMode({
            resolvedAgent,
            currentModel: result.previousModel,
            newModel: result.newModel,
          })
          await autoRetryWithFallback(sessionID, result.newModel, resolvedAgent, source, {
            previousModel: result.previousModel,
            abortCurrentSessionFirst: !hadInFlightRetry && transitionMode === "same_session",
          })
          if (!hadInFlightRetry && transitionMode !== "same_session") {
            await abortSessionRequest(sessionID, source)
          }
          return
        }

        if (!hadInFlightRetry) {
          await abortSessionRequest(sessionID, source)
        }
      } catch (error) {
        log(`[${HOOK_NAME}] Session fallback timeout handler failed`, {
          sessionID,
          source,
          error: String(error),
        })
      } finally {
        sessionTimeoutRecoveryInProgress.delete(sessionID)
      }
    }, timeoutMs)

    sessionFallbackTimeouts.set(sessionID, timer)
  }

  const hasTransientRetryAttemptsRemaining = (state: FallbackState): boolean => {
    if (
      typeof state.transientRetryMaxAttempts === "number"
      && state.transientRetryMaxAttempts > 0
      && state.transientRetryCount >= state.transientRetryMaxAttempts
    ) {
      return false
    }

    return true
  }

  const scheduleTransientRetry = (
    sessionID: string,
    resolvedAgent: string | undefined,
    source: string,
    options?: {
      persistent?: boolean
    },
  ): boolean => {
    const state = sessionStates.get(sessionID)
    if (!state) {
      return false
    }

    const persistent = options?.persistent ?? state.persistentTransientRetry ?? false

    if (!hasTransientRetryAttemptsRemaining(state)) {
      log(`[${HOOK_NAME}] Transient retry attempt budget exhausted`, {
        sessionID,
        source,
        currentModel: state.currentModel,
        transientRetryCount: state.transientRetryCount,
        transientRetryMaxAttempts: state.transientRetryMaxAttempts,
        persistent,
      })
      return false
    }

    if (!persistent && !canKeepRetryingTransiently(state, config)) {
      log(`[${HOOK_NAME}] Transient retry window exhausted`, {
        sessionID,
        source,
        currentModel: state.currentModel,
        transientRetryCount: state.transientRetryCount,
      })
      return false
    }

    if (sessionTransientRetryTimeouts.has(sessionID)) {
      log(`[${HOOK_NAME}] Transient retry already scheduled`, {
        sessionID,
        source,
        currentModel: state.currentModel,
      })
      return true
    }

    beginTransientRetryWindow(state)
    const delayMs = getNextTransientRetryDelayMs(state, config)
    state.transientRetryDelayMs = delayMs
    state.persistentTransientRetry = persistent

    log(`[${HOOK_NAME}] Scheduling delayed transient retry on current model`, {
      sessionID,
      source,
      currentModel: state.currentModel,
      delayMs,
      transientRetryCount: state.transientRetryCount,
      persistent,
    })

    const timer = setTimeout(async () => {
      sessionTransientRetryTimeouts.delete(sessionID)

      const latestState = sessionStates.get(sessionID)
      if (!latestState) {
        return
      }

      const latestPersistent = latestState.persistentTransientRetry ?? false
      if (!hasTransientRetryAttemptsRemaining(latestState)) {
        log(`[${HOOK_NAME}] Skipping delayed transient retry after attempt budget expired`, {
          sessionID,
          source,
          currentModel: latestState.currentModel,
          transientRetryCount: latestState.transientRetryCount,
          transientRetryMaxAttempts: latestState.transientRetryMaxAttempts,
          persistent: latestPersistent,
        })
        return
      }

      if (!latestPersistent && !canKeepRetryingTransiently(latestState, config)) {
        log(`[${HOOK_NAME}] Skipping delayed transient retry after retry window expired`, {
          sessionID,
          source,
          currentModel: latestState.currentModel,
        })
        return
      }

      markTransientRetryDispatched(latestState, { persistent: latestPersistent })
      await autoRetryWithFallback(sessionID, latestState.currentModel, resolvedAgent, `${source}.retry`, {
        transientRetry: true,
      })
    }, delayMs)

    sessionTransientRetryTimeouts.set(sessionID, timer)
    return true
  }

  const autoRetryWithFallback = async (
    sessionID: string,
    newModel: string,
    resolvedAgent: string | undefined,
    source: string,
    args?: {
      transientRetry?: boolean
      continuationPrompt?: string
      previousModel?: string
      abortCurrentSessionFirst?: boolean
    },
  ): Promise<boolean> => {
    if (sessionRetryInFlight.has(sessionID)) {
      log(`[${HOOK_NAME}] Retry already in flight, skipping (${source})`, { sessionID })
      return false
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
      return false
    }

    sessionRetryInFlight.add(sessionID)
    let retryDispatched = false
    try {
      const state = sessionStates.get(sessionID)
      const messagesResp = await fetchSessionMessages(sessionID, `${source}.retry-brief`)
      const retryBriefParts = resolveRetryBriefParts(messagesResp, state)
      if (retryBriefParts.length === 0) {
        log(`[${HOOK_NAME}] No reusable user message found for auto-retry; continuing with internal fallback prompt (${source})`, {
          sessionID,
        })
      }

      log(`[${HOOK_NAME}] Auto-retrying session (${source})`, {
        sessionID,
        model: newModel,
      })

      const explicitLiveRetryAgent = getExplicitLiveRetryAgent(resolvedAgent)
      const retryAgent = explicitLiveRetryAgent
        ?? await resolveAgentForSessionFromContext(
          sessionID,
          resolvedAgent ?? getSessionAgent(sessionID),
        )
        ?? resolvedAgent
        ?? getSessionAgent(sessionID)
      const previousModel = args?.previousModel ?? state?.currentModel ?? newModel
      const transitionMode = getRuntimeFallbackTransitionMode({
        resolvedAgent: retryAgent,
        currentModel: previousModel,
        newModel,
      })
      const preserveRetryAgent = isBoulderTrackedExecutionSession(sessionID, ctx.directory)
      const retryPromptAgent = (!preserveRetryAgent
        && shouldOmitRetryAgent(newModel, state?.originalModel ?? newModel, retryAgent))
        ? undefined
        : normalizeAgentForSessionPrompt(retryAgent)

      if (transitionMode === "scoped_handoff") {
        const childSession = await createScopedFallbackSession({
          parentSessionID: sessionID,
          newModel,
        })

      if (childSession) {
        const baseTimeoutMs = options?.session_timeout_ms ?? config.timeout_seconds * 1000
        sessionAwaitingFallbackResult.add(sessionID)
        scheduleSessionFallbackTimeout(sessionID, {
          resolvedAgent: retryAgent,
          source: `${source}.scoped-handoff`,
          mode: args?.transientRetry ? "transient_retry" : "fallback",
          timeoutMsOverride: resolveLongRunningProgressTimeoutMs(baseTimeoutMs),
        })

        log(`[${HOOK_NAME}] Auto-retrying via scoped fallback handoff`, {
          sessionID,
          childSessionID: childSession.sessionID,
          from: previousModel,
          to: newModel,
            resolvedAgent: retryAgent,
          })

          await ctx.client.session.promptAsync({
            path: { id: childSession.sessionID },
            body: {
              ...(retryPromptAgent ? { agent: retryPromptAgent } : {}),
              ...retryModelPayload,
              parts: [
                createInternalAgentTextPart(
                  buildScopedFallbackHandoffPrompt({
                    parentSessionID: sessionID,
                    newModel,
                    lastUserRetryParts: retryBriefParts,
                  }),
                ),
              ],
            },
            query: { directory: childSession.directory },
          })

          markRecentRuntimeFallbackContinuationDispatch(sessionID)
          markRecentRuntimeFallbackContinuationDispatch(childSession.sessionID)
          if (state?.pendingFallbackModel) {
            state.pendingFallbackModel = undefined
          }
          if (state?.pendingTransientRetry) {
            state.pendingTransientRetry = false
          }
          retryDispatched = true
          return retryDispatched
        }

        log(`[${HOOK_NAME}] Scoped fallback handoff unavailable, falling back to same-session retry`, {
          sessionID,
          from: previousModel,
          to: newModel,
          resolvedAgent: retryAgent,
        })
      }

      sessionAwaitingFallbackResult.add(sessionID)
      const baseTimeoutMs = options?.session_timeout_ms ?? config.timeout_seconds * 1000
      scheduleSessionFallbackTimeout(sessionID, {
        resolvedAgent: retryAgent,
        source,
        mode: args?.transientRetry ? "transient_retry" : "fallback",
        timeoutMsOverride: resolveLongRunningProgressTimeoutMs(baseTimeoutMs),
      })

      if (args?.abortCurrentSessionFirst) {
        await abortSessionRequest(sessionID, `${source}.pre-dispatch`)
      }

      markRecentRuntimeFallbackContinuationDispatch(sessionID)

      await ctx.client.session.promptAsync({
        path: { id: sessionID },
        body: {
          ...(retryPromptAgent ? { agent: retryPromptAgent } : {}),
          ...retryModelPayload,
          parts: [
            createInternalAgentTextPart(
              args?.continuationPrompt ?? FALLBACK_CONTINUATION_PROMPT,
            ),
          ],
        },
        query: { directory: ctx.directory },
      })
      retryDispatched = true
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
    return retryDispatched
  }

  const retryCurrentModelInFreshSession = async (
    sessionID: string,
    resolvedAgent: string | undefined,
    source: string,
  ): Promise<boolean> => {
    const state = sessionStates.get(sessionID)
    if (!state) {
      return false
    }

    const retryModelPayload = buildRetryModelPayload(state.currentModel)
    if (!retryModelPayload) {
      log(`[${HOOK_NAME}] Invalid current model format for fresh retry handoff`, {
        sessionID,
        source,
        model: state.currentModel,
      })
      return false
    }

    try {
      const explicitLiveRetryAgent = getExplicitLiveRetryAgent(resolvedAgent)
      const retryAgent = explicitLiveRetryAgent
        ?? await resolveAgentForSessionFromContext(
          sessionID,
          resolvedAgent ?? getSessionAgent(sessionID),
        )
        ?? resolvedAgent
        ?? getSessionAgent(sessionID)
      const retryParentSessionID = await resolveFreshRetryParentSessionID(sessionID, state)
      if (state.isScopedFallbackChild && retryParentSessionID === sessionID) {
        log(`[${HOOK_NAME}] Scoped paid retry lost its original parent; reusing the same session instead of nesting another child`, {
          sessionID,
          source,
          model: state.currentModel,
          resolvedAgent: retryAgent,
        })

        return retryCurrentModel(sessionID, retryAgent, `${source}.orphaned-scoped-child`, {
          immediate: true,
        })
      }

      const retryWindowState =
        state.isScopedFallbackChild && retryParentSessionID !== sessionID
          ? (sessionStates.get(retryParentSessionID) ?? state)
          : state
      if (!isFreshSameModelRetryWindowOpen(
        retryWindowState,
        state.currentModel,
        FRESH_SAME_MODEL_RETRY_WINDOW_MS,
      )) {
        const globallyCoolingUntil = (
          source === "session.timeout"
          || source.endsWith(".timeout")
        )
          ? markGlobalModelCooldown(
            deps.globalModelCooldowns,
            state.currentModel,
            config.transient_retry_window_seconds * 1000,
          )
          : undefined
        log(`[${HOOK_NAME}] Fresh same-model retry window exhausted; allowing fallback chain to advance`, {
          sessionID,
          retryParentSessionID,
          source,
          model: state.currentModel,
          freshSameModelRetryStartedAt: retryWindowState.freshSameModelRetryStartedAt,
          freshSameModelRetryCount: retryWindowState.freshSameModelRetryCount,
          retryWindowMs: FRESH_SAME_MODEL_RETRY_WINDOW_MS,
          globallyCoolingUntil,
        })
        return false
      }

      const now = Date.now()
      const isFirstFreshSameModelRetryForModel =
        retryWindowState.freshSameModelRetryStartedAt === undefined
        || retryWindowState.freshSameModelRetryModelIdentity !== getWatchdogModelIdentity(state.currentModel)
      const shouldBackdateInitialTimeoutBudget =
        isFirstFreshSameModelRetryForModel
        && (
          source === "session.timeout"
          || source.endsWith(".timeout")
        )
        && !source.includes("transient-timeout")
      const baseTimeoutMs = options?.session_timeout_ms ?? config.timeout_seconds * 1000
      const firstRetryRecordedAt = shouldBackdateInitialTimeoutBudget
        ? now - resolveLongRunningProgressTimeoutMs(baseTimeoutMs)
        : now

      recordFreshSameModelRetry(retryWindowState, state.currentModel, firstRetryRecordedAt)
      if (retryWindowState !== state) {
        inheritFreshSameModelRetryWindow(state, retryWindowState)
      }

      const retryBriefSessionID =
        state.isScopedFallbackChild && retryParentSessionID !== sessionID
          ? retryParentSessionID
          : sessionID
      const messagesResp = await fetchSessionMessages(
        retryBriefSessionID,
        `${source}.fresh-retry-brief`,
      )
      const retryBriefParts = resolveRetryBriefParts(messagesResp, state)
      const preserveRetryAgent = isBoulderTrackedExecutionSession(sessionID, ctx.directory)
      const retryPromptAgent = (!preserveRetryAgent
        && shouldOmitRetryAgent(state.currentModel, state.originalModel ?? state.currentModel, retryAgent))
        ? undefined
        : normalizeAgentForSessionPrompt(retryAgent)
      const childSession = await createScopedFallbackSession({
        parentSessionID: retryParentSessionID,
        newModel: state.currentModel,
      })

      if (!childSession) {
        return false
      }

      await ctx.client.session.promptAsync({
        path: { id: childSession.sessionID },
        body: {
          ...(retryPromptAgent ? { agent: retryPromptAgent } : {}),
          ...retryModelPayload,
          parts: [
            createInternalAgentTextPart(
              buildFreshPaidRetryHandoffPrompt({
                parentSessionID: retryParentSessionID,
                currentModel: state.currentModel,
                lastUserRetryParts: retryBriefParts,
              }),
            ),
          ],
        },
        query: { directory: childSession.directory },
      })

      const parentState = sessionStates.get(retryParentSessionID)
      if (!parentState) {
        const bootstrappedParentState = createFallbackState(state.currentModel, [
          ...state.fallbackModels,
        ])
        bootstrappedParentState.resolvedAgent = retryAgent
        inheritCanonicalRetryParts(bootstrappedParentState, state)
        inheritFreshSameModelRetryWindow(bootstrappedParentState, state)
        sessionStates.set(retryParentSessionID, bootstrappedParentState)
        sessionLastAccess.set(retryParentSessionID, Date.now())
      }

      sessionAwaitingFallbackResult.delete(sessionID)
      clearSessionFallbackTimeout(sessionID)
      sessionAwaitingFallbackResult.add(retryParentSessionID)
      scheduleSessionFallbackTimeout(retryParentSessionID, {
        resolvedAgent: retryAgent,
        source: `${source}.fresh-scoped-handoff`,
        timeoutMsOverride: resolveLongRunningProgressTimeoutMs(baseTimeoutMs),
      })
      markRecentRuntimeFallbackContinuationDispatch(retryParentSessionID)
      state.pendingFallbackModel = undefined
      state.pendingTransientRetry = false
      state.persistentTransientRetry = false

      log(`[${HOOK_NAME}] Retrying current paid model in a fresh child session`, {
        sessionID,
        retryParentSessionID,
        childSessionID: childSession.sessionID,
        model: state.currentModel,
        source,
        resolvedAgent: retryAgent,
      })

      return true
    } catch (error) {
      log(`[${HOOK_NAME}] Fresh paid retry handoff failed`, {
        sessionID,
        source,
        model: state.currentModel,
        error: String(error),
      })
      return false
    }
  }

  const retryCurrentModel = async (
    sessionID: string,
    resolvedAgent: string | undefined,
    source: string,
    options?: {
      immediate?: boolean
      persistent?: boolean
      maxAttempts?: number
    },
  ): Promise<boolean> => {
    const state = sessionStates.get(sessionID)
    if (!state) {
      return false
    }

    const immediate = options?.immediate ?? true
    const persistent = options?.persistent ?? false
    if (typeof options?.maxAttempts === "number" && options.maxAttempts > 0) {
      state.transientRetryMaxAttempts = options.maxAttempts
    }

    if (!persistent && !canKeepRetryingTransiently(state, config)) {
      log(`[${HOOK_NAME}] Transient retry window exhausted before retry dispatch`, {
        sessionID,
        source,
        currentModel: state.currentModel,
        transientRetryCount: state.transientRetryCount,
        transientRetryMaxAttempts: state.transientRetryMaxAttempts,
      })
      return false
    }

    state.persistentTransientRetry = persistent

    if (immediate && state.transientRetryCount === 0) {
      markTransientRetryDispatched(state, { persistent })
      log(`[${HOOK_NAME}] Retrying current model immediately after transient error`, {
        sessionID,
        source,
        currentModel: state.currentModel,
        transientRetryCount: state.transientRetryCount,
        persistent,
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
        persistent,
      })
    }

    return scheduleTransientRetry(sessionID, resolvedAgent, source, { persistent })
  }

  const resolveAgentForSessionFromContext = async (
    sessionID: string,
    eventAgent?: string,
  ): Promise<string | undefined> => {
    const boulderResolvedAgent = await getAgentFromSession(sessionID, ctx.directory, ctx.client as never)
    const normalizedBoulderAgent = normalizeAgentName(boulderResolvedAgent)
    if (normalizedBoulderAgent) {
      return normalizedBoulderAgent
    }

    const resolved = resolveAgentForSession(sessionID, eventAgent)
    if (resolved) return resolved

    try {
      const messagesResp = await fetchSessionMessages(sessionID, "resolve-agent")
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
    const probeDir = mkdtempSync(join(tmpdir(), RECOVERY_PROBE_DIR_PREFIX))

    return await new Promise<boolean>((resolve) => {
      const variantArgs = cliModel.variant ? ["--variant", cliModel.variant] : []
      let stdout = ""
      let stderr = ""
      let settled = false
      let child: ReturnType<typeof spawn> | undefined

      const finalize = (result: boolean) => {
        if (settled) return
        settled = true
        try {
          rmSync(probeDir, { recursive: true, force: true })
        } catch {
        }
        resolve(result)
      }

      const timeout = setTimeout(() => {
        if (child) {
          terminateChildProcessTree(child)
        }
        finalize(false)
      }, MODEL_RECOVERY_PROBE_TIMEOUT_MS)

      try {
        child = spawn(
          "opencode",
          [
            "run",
            "--dir",
            probeDir,
            "--model",
            cliModel.model,
            ...variantArgs,
            RECOVERY_PROBE_PROMPT,
          ],
          {
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              ...process.env,
              [RECOVERY_PROBE_RUNTIME_FALLBACK_DISABLE_ENV]: "1",
            },
          },
        )
      } catch (error) {
        clearTimeout(timeout)
        log(`[${HOOK_NAME}] Failed to spawn recovery probe`, {
          sessionID,
          model,
          error: String(error),
        })
        finalize(false)
        return
      }

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
        finalize(didRecoveryProbeSucceed(code, output))
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

    const shouldAutoResumeCurrentTurn = sessionAwaitingFallbackResult.has(sessionID)
    if (shouldAutoResumeCurrentTurn && !isRecoveredAutoResumeEligible(sessionID)) {
      return undefined
    }
    if (
      shouldAutoResumeCurrentTurn
      && !canAutoResumeRecoveredModel(state, config.max_full_chain_cycles)
    ) {
      log(`[${HOOK_NAME}] Skipping recovered-model auto-resume after max full-chain cycles`, {
        sessionID,
        fullChainCyclesCompleted: state.fullChainCyclesCompleted ?? 0,
        maxFullChainCycles: config.max_full_chain_cycles,
        currentModel: state.currentModel,
      })
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
      const recoveryCandidate = getPreferredRecoveryCandidate(state, config.cooldown_seconds)
      if (!recoveryCandidate) {
        continue
      }

      const recoveredModel = recoverPreferredModel(state, config.cooldown_seconds)
      if (!recoveredModel) {
        continue
      }

      log(`[${HOOK_NAME}] Recovery probe restored higher-priority model`, {
        sessionID,
        recoveredModel,
      })

      if (shouldAutoResumeCurrentTurn) {
        const retryDispatched = await autoRetryWithFallback(
          sessionID,
          recoveredModel,
          resolvedAgent,
          "model.recovery.probe",
        )
        if (retryDispatched) {
          markRecoveredModelAutoResume(state)
        }
      }

      return recoveredModel
    }

    return undefined
  }

  const maybeNudgeStalledSession = async (
    sessionID: string,
    state: FallbackState,
  ): Promise<boolean> => {
    if (sessionRetryInFlight.has(sessionID) || sessionAwaitingFallbackResult.has(sessionID)) {
      return false
    }

    if (sessionFallbackTimeouts.has(sessionID) || sessionTransientRetryTimeouts.has(sessionID)) {
      return false
    }

    if (wasRecentlyStopped(state) || hasTerminalIdleMarker(state)) {
      return false
    }

    const lastAccess = sessionLastAccess.get(sessionID)
    if (typeof lastAccess !== "number") {
      return false
    }

    const lastAccessAgeMs = Math.max(0, Date.now() - lastAccess)
    if (lastAccessAgeMs < STALLED_SESSION_NUDGE_MS) {
      return false
    }

    const resolvedAgent = await resolveAgentForSessionFromContext(sessionID, state.resolvedAgent)
      ?? state.resolvedAgent
    log(`[${HOOK_NAME}] Nudging stalled session after prolonged inactivity`, {
      sessionID,
      currentModel: state.currentModel,
      resolvedAgent,
      lastAccessAgeMs,
      inactivityThresholdMs: STALLED_SESSION_NUDGE_MS,
    })

    return await autoRetryWithFallback(
      sessionID,
      state.currentModel,
      resolvedAgent,
      "session.stalled.nudge",
      { continuationPrompt: WATCHDOG_CONTINUATION_PROMPT },
    )
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
        sessionTimeoutRecoveryInProgress.delete(sessionID)
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
      const shouldAutoResumeCurrentTurn = sessionAwaitingFallbackResult.has(sessionID)
      if (shouldAutoResumeCurrentTurn && !isRecoveredAutoResumeEligible(sessionID)) {
        continue
      }
      if (
        shouldAutoResumeCurrentTurn
        && !canAutoResumeRecoveredModel(state, config.max_full_chain_cycles)
      ) {
        log(`[${HOOK_NAME}] Skipping background preferred-model auto-resume after max full-chain cycles`, {
          sessionID,
          fullChainCyclesCompleted: state.fullChainCyclesCompleted ?? 0,
          maxFullChainCycles: config.max_full_chain_cycles,
          currentModel: state.currentModel,
        })
        continue
      }

      const recoveredModel = recoverPreferredModel(state, config.cooldown_seconds)
      if (!recoveredModel) {
        const resolvedAgent = await resolveAgentForSessionFromContext(sessionID)
        await maybeProbePreferredRecovery(sessionID, resolvedAgent)
        await maybeNudgeStalledSession(sessionID, state)
        continue
      }

      log(`[${HOOK_NAME}] Background recovery promoted session back to a higher-priority model`, {
        sessionID,
        recoveredModel,
      })

      if (shouldAutoResumeCurrentTurn) {
        const resolvedAgent = await resolveAgentForSessionFromContext(sessionID)
        const retryDispatched = await autoRetryWithFallback(
          sessionID,
          recoveredModel,
          resolvedAgent,
          "model.recovery.cooldown",
        )
        if (retryDispatched) {
          markRecoveredModelAutoResume(state)
        }
      }

      await maybeNudgeStalledSession(sessionID, state)
    }
  }

  return {
    abortSessionRequest,
    clearSessionTransientRetryTimeout,
    clearSessionFallbackTimeout,
    scheduleSessionFallbackTimeout,
    autoRetryWithFallback,
    retryCurrentModel,
    retryCurrentModelInFreshSession,
    resolveAgentForSessionFromContext,
    cleanupStaleSessions,
    recoverPreferredModels,
  }
}

export type AutoRetryHelpers = ReturnType<typeof createAutoRetryHelpers>
