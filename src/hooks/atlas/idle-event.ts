import type { PluginInput } from "@opencode-ai/plugin"
import {
  clearTaskSessionState,
  getPlanProgress,
  getTaskSessionState,
  readBoulderState,
  readCurrentTopLevelTask,
} from "../../features/boulder-state"
import { getSessionAgent, isAgentRegistered, subagentSessions } from "../../features/claude-code-session-state"
import { inspectParentSessionTasks } from "../../features/background-agent/parent-session-tasks"
import { getAgentConfigKey } from "../../shared/agent-display-names"
import { log } from "../../shared/logger"
import { injectBoulderContinuation } from "./boulder-continuation-injector"
import { HOOK_NAME } from "./hook-name"
import { resolveActiveBoulderSession } from "./resolve-active-boulder-session"
import type { AtlasHookOptions, SessionState } from "./types"

const CONTINUATION_COOLDOWN_MS = 5000
const FAILURE_BACKOFF_MS = 5 * 60 * 1000
const MAX_CONSECUTIVE_PROMPT_FAILURES = 10
const SESSION_ERROR_BACKOFF_MS = 30 * 1000
const RETRY_DELAY_MS = CONTINUATION_COOLDOWN_MS + 1000
const MAX_STAGNATION_COUNT = 3

function buildPlanExecutionDigest(planPath: string, progress: { total: number; completed: number }): string {
  const currentTask = readCurrentTopLevelTask(planPath)
  return JSON.stringify({
    total: progress.total,
    completed: progress.completed,
    currentTaskKey: currentTask?.key ?? null,
  })
}

function shouldStopForStagnation(input: {
  sessionID: string
  sessionState: SessionState
  currentPlanDigest: string
}): boolean {
  const { sessionID, sessionState, currentPlanDigest } = input
  const previousObservedPlanDigest = sessionState.lastObservedPlanDigest

  if (
    previousObservedPlanDigest !== undefined
    && previousObservedPlanDigest !== currentPlanDigest
  ) {
    sessionState.stagnationCount = 0
  }

  if (sessionState.awaitingPostInjectionProgressCheck) {
    if (sessionState.lastInjectedPlanDigest === currentPlanDigest) {
      sessionState.stagnationCount = (sessionState.stagnationCount ?? 0) + 1
      log(`[${HOOK_NAME}] Detected no plan progress after continuation`, {
        sessionID,
        stagnationCount: sessionState.stagnationCount,
        maxStagnationCount: MAX_STAGNATION_COUNT,
      })
    } else {
      sessionState.stagnationCount = 0
    }

    sessionState.awaitingPostInjectionProgressCheck = false
  }

  sessionState.lastObservedPlanDigest = currentPlanDigest

  if ((sessionState.stagnationCount ?? 0) < MAX_STAGNATION_COUNT) {
    return false
  }

  log(`[${HOOK_NAME}] Skipped: continuation stagnated with no plan progress`, {
    sessionID,
    stagnationCount: sessionState.stagnationCount,
    maxStagnationCount: MAX_STAGNATION_COUNT,
  })
  return true
}

function hasActiveBackgroundTasks(sessionID: string, options?: AtlasHookOptions): boolean {
  const backgroundTasks = inspectParentSessionTasks({
    backgroundManager: options?.backgroundManager,
    sessionID,
    logScope: HOOK_NAME,
  })
  if (!backgroundTasks.available) {
    return true
  }

  return backgroundTasks.hasActiveTasks
}

async function hasReusablePreferredTaskSession(input: {
  client: PluginInput["client"]
  sessionID: string
  options?: AtlasHookOptions
}): Promise<boolean> {
  if (input.options?.backgroundManager) {
    return Boolean(input.options.backgroundManager.findBySession(input.sessionID))
  }

  try {
    await input.client.session.get({
      path: { id: input.sessionID },
    })
    return true
  } catch {
    return false
  }
}

async function injectContinuation(input: {
  ctx: PluginInput
  sessionID: string
  sessionState: SessionState
  options?: AtlasHookOptions
  planName: string
  planDigest: string
  progress: { total: number; completed: number }
  agent?: string
  worktreePath?: string
}): Promise<void> {
  const remaining = input.progress.total - input.progress.completed
  input.sessionState.lastContinuationInjectedAt = Date.now()

  try {
    const currentBoulder = readBoulderState(input.ctx.directory)
    const currentTask = currentBoulder
      ? readCurrentTopLevelTask(currentBoulder.active_plan)
      : null
    const preferredTaskSession = currentTask
      ? getTaskSessionState(input.ctx.directory, currentTask.key)
      : null
    let preferredTaskSessionId = preferredTaskSession?.session_id
    let preferredTaskTitle = preferredTaskSession?.task_title

    if (currentTask && preferredTaskSessionId) {
      const isReusable = await hasReusablePreferredTaskSession({
        client: input.ctx.client,
        sessionID: preferredTaskSessionId,
        options: input.options,
      })

      if (!isReusable) {
        clearTaskSessionState(input.ctx.directory, currentTask.key)
        preferredTaskSessionId = undefined
        preferredTaskTitle = undefined
      }
    }

    await injectBoulderContinuation({
      ctx: input.ctx,
      sessionID: input.sessionID,
      planName: input.planName,
      planDigest: input.planDigest,
      remaining,
      total: input.progress.total,
      agent: input.agent,
      worktreePath: input.worktreePath,
      preferredTaskSessionId,
      preferredTaskTitle,
      backgroundManager: input.options?.backgroundManager,
      sessionState: input.sessionState,
    })
  } catch (error) {
    log(`[${HOOK_NAME}] Failed to inject boulder continuation`, { sessionID: input.sessionID, error })
    input.sessionState.promptFailureCount += 1
  }
}

function scheduleRetry(input: {
  ctx: PluginInput
  sessionID: string
  sessionState: SessionState
  options?: AtlasHookOptions
}): void {
  const { ctx, sessionID, sessionState, options } = input
  if (sessionState.pendingRetryTimer) {
    return
  }

  sessionState.pendingRetryTimer = setTimeout(async () => {
    sessionState.pendingRetryTimer = undefined

    if (sessionState.promptFailureCount >= MAX_CONSECUTIVE_PROMPT_FAILURES) return
    if (sessionState.waitingForFinalWaveApproval) return

    const currentBoulder = readBoulderState(ctx.directory)
    if (!currentBoulder) return
    if (!currentBoulder.session_ids?.includes(sessionID)) return

    const currentProgress = getPlanProgress(currentBoulder.active_plan)
    if (currentProgress.isComplete) return
    if (options?.isContinuationStopped?.(sessionID)) return
    if (hasActiveBackgroundTasks(sessionID, options)) return
    if ((sessionState.stagnationCount ?? 0) >= MAX_STAGNATION_COUNT) return

    const currentPlanDigest = buildPlanExecutionDigest(currentBoulder.active_plan, currentProgress)
    await injectContinuation({
      ctx,
      sessionID,
      sessionState,
      options,
      planName: currentBoulder.plan_name,
      planDigest: currentPlanDigest,
      progress: currentProgress,
      agent: currentBoulder.agent,
      worktreePath: currentBoulder.worktree_path,
    })
  }, RETRY_DELAY_MS)
}

export async function handleAtlasSessionIdle(input: {
  ctx: PluginInput
  options?: AtlasHookOptions
  getState: (sessionID: string) => SessionState
  sessionID: string
}): Promise<void> {
  const { ctx, options, getState, sessionID } = input

  log(`[${HOOK_NAME}] session.idle`, { sessionID })

  const activeBoulderSession = await resolveActiveBoulderSession({
    client: ctx.client,
    directory: ctx.directory,
    sessionID,
  })
  if (!activeBoulderSession) {
    log(`[${HOOK_NAME}] Skipped: session not registered in active boulder`, { sessionID })
    return
  }

  const { boulderState, progress, appendedSession } = activeBoulderSession
  if (progress.isComplete) {
    log(`[${HOOK_NAME}] Boulder complete`, { sessionID, plan: boulderState.plan_name })
    return
  }

  if (appendedSession) {
    log(`[${HOOK_NAME}] Appended subagent session to boulder during idle`, {
      sessionID,
      plan: boulderState.plan_name,
    })
  }

  if (subagentSessions.has(sessionID)) {
    const sessionAgent = getSessionAgent(sessionID)
    const agentKey = getAgentConfigKey(sessionAgent ?? "")
    const requiredAgentName = boulderState.agent ?? (isAgentRegistered("atlas") ? "atlas" : undefined)
    if (!requiredAgentName || !isAgentRegistered(requiredAgentName)) {
      log(`[${HOOK_NAME}] Skipped: boulder agent is unavailable for continuation`, {
        sessionID,
        requiredAgent: boulderState.agent ?? "unknown",
      })
      return
    }
    const requiredAgentKey = getAgentConfigKey(requiredAgentName)
    const agentMatches =
      agentKey === requiredAgentKey ||
      (requiredAgentKey === getAgentConfigKey("atlas") && agentKey === getAgentConfigKey("sisyphus"))
    if (!agentMatches) {
      log(`[${HOOK_NAME}] Skipped: subagent agent does not match boulder agent`, {
        sessionID,
        agent: sessionAgent ?? "unknown",
          requiredAgent: requiredAgentName,
        })
        return
      }
  }

  const sessionState = getState(sessionID)
  const now = Date.now()
  const currentPlanDigest = buildPlanExecutionDigest(boulderState.active_plan, progress)

  if (sessionState.waitingForFinalWaveApproval) {
    log(`[${HOOK_NAME}] Skipped: waiting for explicit final-wave approval`, { sessionID })
    return
  }

  if (sessionState.lastEventWasAbortError) {
    sessionState.lastEventWasAbortError = false
    log(`[${HOOK_NAME}] Skipped: abort error immediately before idle`, { sessionID })
    return
  }

  if (sessionState.lastNonAbortSessionErrorAt) {
    const timeSinceLastSessionError = now - sessionState.lastNonAbortSessionErrorAt
    if (timeSinceLastSessionError < SESSION_ERROR_BACKOFF_MS) {
      log(`[${HOOK_NAME}] Skipped: recent session.error before idle`, {
        sessionID,
        backoffRemaining: SESSION_ERROR_BACKOFF_MS - timeSinceLastSessionError,
      })
      return
    }

    sessionState.lastNonAbortSessionErrorAt = undefined
  }

  if (sessionState.promptFailureCount >= MAX_CONSECUTIVE_PROMPT_FAILURES) {
    const timeSinceLastFailure =
      sessionState.lastFailureAt !== undefined ? now - sessionState.lastFailureAt : Number.POSITIVE_INFINITY
    if (timeSinceLastFailure < FAILURE_BACKOFF_MS) {
      log(`[${HOOK_NAME}] Skipped: continuation in backoff after repeated failures`, {
        sessionID,
        promptFailureCount: sessionState.promptFailureCount,
        backoffRemaining: FAILURE_BACKOFF_MS - timeSinceLastFailure,
      })
      return
    }

    sessionState.promptFailureCount = 0
    sessionState.lastFailureAt = undefined
  }

  if (hasActiveBackgroundTasks(sessionID, options)) {
    log(`[${HOOK_NAME}] Skipped: background tasks active`, { sessionID })
    return
  }

  if (options?.isContinuationStopped?.(sessionID)) {
    log(`[${HOOK_NAME}] Skipped: continuation stopped for session`, { sessionID })
    return
  }

  if (sessionState.lastContinuationInjectedAt && now - sessionState.lastContinuationInjectedAt < CONTINUATION_COOLDOWN_MS) {
    if (!sessionState.awaitingPostInjectionProgressCheck) {
      scheduleRetry({ ctx, sessionID, sessionState, options })
    }
    log(`[${HOOK_NAME}] Skipped: continuation cooldown active`, {
      sessionID,
      cooldownRemaining: CONTINUATION_COOLDOWN_MS - (now - sessionState.lastContinuationInjectedAt),
      pendingRetry: !!sessionState.pendingRetryTimer,
      awaitingPostInjectionProgressCheck: sessionState.awaitingPostInjectionProgressCheck ?? false,
    })
    return
  }

  if (shouldStopForStagnation({ sessionID, sessionState, currentPlanDigest })) {
    return
  }

  await injectContinuation({
    ctx,
    sessionID,
    sessionState,
    options,
    planName: boulderState.plan_name,
    planDigest: currentPlanDigest,
    progress,
    agent: boulderState.agent,
    worktreePath: boulderState.worktree_path,
  })
}
