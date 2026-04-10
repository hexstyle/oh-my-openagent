import type { PluginInput } from "@opencode-ai/plugin"
import type { BackgroundManager } from "../../features/background-agent"
import { inspectParentSessionTasks } from "../../features/background-agent/parent-session-tasks"
import { isAgentRegistered } from "../../features/claude-code-session-state"
import { normalizeAgentForSessionPrompt } from "../../shared/agent-display-names"
import { log } from "../../shared/logger"
import { createInternalAgentTextPart, resolveInheritedPromptTools } from "../../shared"
import { HOOK_NAME } from "./hook-name"
import { BOULDER_CONTINUATION_PROMPT } from "./system-reminder-templates"
import { resolveRecentPromptContextForSession } from "./recent-model-resolver"
import type { SessionState } from "./types"

export async function injectBoulderContinuation(input: {
  ctx: PluginInput
  sessionID: string
  planName: string
  planDigest: string
  remaining: number
  total: number
  agent?: string
  worktreePath?: string
  preferredTaskSessionId?: string
  preferredTaskTitle?: string
  backgroundManager?: BackgroundManager
  sessionState: SessionState
}): Promise<void> {
  const {
    ctx,
    sessionID,
    planName,
    planDigest,
    remaining,
    total,
    agent,
    worktreePath,
    preferredTaskSessionId,
    preferredTaskTitle,
    backgroundManager,
    sessionState,
  } = input

  const backgroundTasks = inspectParentSessionTasks({
    backgroundManager,
    sessionID,
    logScope: HOOK_NAME,
  })
  if (!backgroundTasks.available) {
    log(`[${HOOK_NAME}] Skipped injection: background task state unavailable`, { sessionID })
    return
  }

  if (backgroundTasks.hasRunningTasks) {
    log(`[${HOOK_NAME}] Skipped injection: background tasks running`, { sessionID })
    return
  }

  const worktreeContext = worktreePath ? `\n\n[Worktree: ${worktreePath}]` : ""
  const preferredSessionContext = preferredTaskSessionId
    ? `\n\n[Preferred reuse session for current top-level plan task${preferredTaskTitle ? `: ${preferredTaskTitle}` : ""}: ${preferredTaskSessionId}]`
    : ""
	const prompt =
		BOULDER_CONTINUATION_PROMPT.replace(/{PLAN_NAME}/g, planName) +
		`\n\n[Status: ${total - remaining}/${total} completed, ${remaining} remaining]` +
		preferredSessionContext +
		worktreeContext
	const continuationAgent = agent ?? (isAgentRegistered("atlas") ? "atlas" : undefined)

	if (!continuationAgent || !isAgentRegistered(continuationAgent)) {
		log(`[${HOOK_NAME}] Skipped injection: continuation agent unavailable`, {
			sessionID,
			agent: continuationAgent ?? agent ?? "unknown",
		})
		return
	}

	try {
		log(`[${HOOK_NAME}] Injecting boulder continuation`, { sessionID, planName, remaining })

    const promptContext = await resolveRecentPromptContextForSession(ctx, sessionID)
    const inheritedTools = resolveInheritedPromptTools(sessionID, promptContext.tools)

    await ctx.client.session.promptAsync({
      path: { id: sessionID },
      body: {
        agent: normalizeAgentForSessionPrompt(continuationAgent) ?? continuationAgent,
        ...(promptContext.model !== undefined ? { model: promptContext.model } : {}),
        ...(inheritedTools ? { tools: inheritedTools } : {}),
        parts: [createInternalAgentTextPart(prompt)],
      },
      query: { directory: ctx.directory },
    })

    sessionState.promptFailureCount = 0
    sessionState.lastInjectedPlanDigest = planDigest
    sessionState.awaitingPostInjectionProgressCheck = true
    log(`[${HOOK_NAME}] Boulder continuation injected`, { sessionID })
  } catch (err) {
    sessionState.promptFailureCount += 1
    sessionState.lastFailureAt = Date.now()
    log(`[${HOOK_NAME}] Boulder continuation failed`, {
      sessionID,
      error: String(err),
      promptFailureCount: sessionState.promptFailureCount,
    })
  }
}
