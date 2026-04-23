import { statSync } from "node:fs"
import type { PluginInput } from "@opencode-ai/plugin"
import {
  readBoulderState,
  writeBoulderState,
  appendSessionId,
  findPrometheusPlans,
  getPlanProgress,
  createBoulderState,
  getPlanName,
  clearBoulderState,
} from "../../features/boulder-state"
import { log } from "../../shared/logger"
import { getAgentDisplayName } from "../../shared/agent-display-names"
import { getSessionAgent, isAgentRegistered, updateSessionAgent } from "../../features/claude-code-session-state"
import { detectWorktreePath } from "./worktree-detector"
import { parseUserRequest } from "./parse-user-request"

export const HOOK_NAME = "start-work" as const

interface StartWorkHookInput {
  sessionID: string
  messageID?: string
}

interface StartWorkCommandExecuteBeforeInput {
  sessionID: string
  command: string
  arguments: string
}

interface StartWorkHookOutput {
  message?: Record<string, unknown>
  parts: Array<{ type: string; text?: string }>
}

function isStartWorkPrompt(promptText: string): boolean {
  const trimmed = promptText.trim()
  return trimmed.startsWith("/start-work")
    || promptText.includes("# /start-work Command")
    || promptText.includes("You are starting a Sisyphus work session.")
}

function findPlanByName(plans: string[], requestedName: string): string | null {
  const lowerName = requestedName.toLowerCase()
  const exactMatch = plans.find((p) => getPlanName(p).toLowerCase() === lowerName)
  if (exactMatch) return exactMatch
  const partialMatch = plans.find((p) => getPlanName(p).toLowerCase().includes(lowerName))
  return partialMatch || null
}

function createWorktreeActiveBlock(worktreePath: string): string {
  return `
## Worktree Active

**Worktree**: \`${worktreePath}\`

**CRITICAL — DO NOT FORGET**: You are working inside a git worktree. ALL operations MUST be performed exclusively within this worktree directory.
- Every file read, write, edit, and git operation MUST target paths under: \`${worktreePath}\`
- When delegating tasks to subagents, you MUST include the worktree path in your delegation prompt so they also operate exclusively within the worktree
- NEVER operate on the main repository directory — always use the worktree path above`
}

function resolveWorktreeContext(
  explicitWorktreePath: string | null,
): { worktreePath: string | undefined; block: string } {
  if (explicitWorktreePath === null) {
    return { worktreePath: undefined, block: "" }
  }

  const validatedPath = detectWorktreePath(explicitWorktreePath)
  if (validatedPath) {
    return { worktreePath: validatedPath, block: createWorktreeActiveBlock(validatedPath) }
  }

  return {
    worktreePath: undefined,
    block: `\n**Worktree** (needs setup): \`git worktree add ${explicitWorktreePath} <branch>\`, then add \`"worktree_path"\` to boulder.json`,
  }
}

function createDelegationKickoffBlock(): string {
  return `
## Delegation Kickoff

After you refresh the plan, boulder state, and relevant notepad context, your next substantive action MUST be \`task(...)\` for the current top-level task.

- Focus on the current top-level task first
- Keep your own direct orchestration work minimal: plan/notepad/boulder refresh, verification, delegation
- Do not spend multiple Read/Bash research loops investigating implementation details yourself before delegation
- Use \`task(subagent_type="explore", run_in_background=true, ...)\` for codebase search and the appropriate execution subagent for implementation`
}

function createEvidenceGateBlock(): string {
  return `
## Evidence-Gated Progress

- Plan completion is NOT determined by checkbox state alone
- A checked task with required evidence paths is still INCOMPLETE until those files/directories actually exist
- If a QA/Evidence line references \`.sisyphus/evidence/...\` and that artifact is missing or empty, keep treating the task as remaining work
- Checked boxes without required evidence remain incomplete
- Do not announce "all complete" from raw \`- [x]\` counts alone`
}

export function createStartWorkHook(ctx: PluginInput) {
  const injectStartWorkContext = async (
    sessionId: string,
    promptText: string,
    output: StartWorkHookOutput,
  ): Promise<void> => {
    if (!isStartWorkPrompt(promptText)) return

    log(`[${HOOK_NAME}] Processing start-work command`, { sessionID: sessionId })
    const activeAgent = isAgentRegistered("atlas")
      ? "atlas"
      : getSessionAgent(sessionId) ?? "sisyphus"
    const activeAgentDisplayName = getAgentDisplayName(activeAgent)
    updateSessionAgent(sessionId, activeAgent)
    if (output.message) {
      output.message["agent"] = activeAgentDisplayName
    }

    const existingState = readBoulderState(ctx.directory)
    const timestamp = new Date().toISOString()

    const { planName: explicitPlanName, explicitWorktreePath } = parseUserRequest(promptText)
    const { worktreePath, block: worktreeBlock } = resolveWorktreeContext(explicitWorktreePath)
    const delegationKickoffBlock = createDelegationKickoffBlock()
    const evidenceGateBlock = createEvidenceGateBlock()

    let contextInfo = ""

    if (explicitPlanName) {
      log(`[${HOOK_NAME}] Explicit plan name requested: ${explicitPlanName}`, { sessionID: sessionId })

      const allPlans = findPrometheusPlans(ctx.directory)
      const matchedPlan = findPlanByName(allPlans, explicitPlanName)
        ?? (
          existingState
          && getPlanName(existingState.active_plan).toLowerCase() === explicitPlanName.toLowerCase()
          && !getPlanProgress(existingState.active_plan).isComplete
            ? existingState.active_plan
            : null
        )

      if (matchedPlan) {
        const progress = getPlanProgress(matchedPlan)

        if (progress.isComplete) {
          contextInfo = `
## Plan Already Complete

The requested plan "${getPlanName(matchedPlan)}" has been completed.
All ${progress.total} tasks are done. Create a new plan with: /plan "your task"`
        } else {
          if (existingState) clearBoulderState(ctx.directory)
          const newState = createBoulderState(matchedPlan, sessionId, activeAgent, worktreePath)
          writeBoulderState(ctx.directory, newState)

          contextInfo = `
## Auto-Selected Plan

**Plan**: ${getPlanName(matchedPlan)}
**Path**: ${matchedPlan}
**Progress**: ${progress.completed}/${progress.total} tasks
**Session ID**: ${sessionId}
**Started**: ${timestamp}
${worktreeBlock}
${evidenceGateBlock}

boulder.json has been created. Read the plan and begin execution.
${delegationKickoffBlock}`
        }
      } else {
        const incompletePlans = allPlans.filter((p) => !getPlanProgress(p).isComplete)
        if (incompletePlans.length > 0) {
          const planList = incompletePlans
            .map((p, i) => {
              const prog = getPlanProgress(p)
              return `${i + 1}. [${getPlanName(p)}] - Progress: ${prog.completed}/${prog.total}`
            })
            .join("\n")

          contextInfo = `
## Plan Not Found

Could not find a plan matching "${explicitPlanName}".

Available incomplete plans:
${planList}

Ask the user which plan to work on.`
        } else {
          contextInfo = `
## Plan Not Found

Could not find a plan matching "${explicitPlanName}".
No incomplete plans available. Create a new plan with: /plan "your task"`
        }
      }
    } else if (existingState) {
      const progress = getPlanProgress(existingState.active_plan)

      if (!progress.isComplete) {
        const effectiveWorktree = worktreePath ?? existingState.worktree_path

        if (worktreePath !== undefined) {
          const updatedSessions = existingState.session_ids.includes(sessionId)
            ? existingState.session_ids
            : [...existingState.session_ids, sessionId]
          writeBoulderState(ctx.directory, {
            ...existingState,
            worktree_path: worktreePath,
            session_ids: updatedSessions,
          })
        } else {
          appendSessionId(ctx.directory, sessionId)
        }

        const worktreeDisplay = effectiveWorktree ? createWorktreeActiveBlock(effectiveWorktree) : worktreeBlock

        contextInfo = `
## Active Work Session Found

**Status**: RESUMING existing work
**Plan**: ${existingState.plan_name}
**Path**: ${existingState.active_plan}
**Progress**: ${progress.completed}/${progress.total} tasks completed
**Sessions**: ${existingState.session_ids.length + 1} (current session appended)
**Started**: ${existingState.started_at}
${worktreeDisplay}
${evidenceGateBlock}

The current session (${sessionId}) has been added to session_ids.
Read the plan file and continue from the first unchecked task.
${delegationKickoffBlock}`
      } else {
        contextInfo = `
## Previous Work Complete

The previous plan (${existingState.plan_name}) has been completed.
Looking for new plans...`
        clearBoulderState(ctx.directory)
      }
    }

    if (
      (!existingState && !explicitPlanName) ||
      (existingState && !explicitPlanName && getPlanProgress(existingState.active_plan).isComplete)
    ) {
      const plans = findPrometheusPlans(ctx.directory)
      const incompletePlans = plans.filter((p) => !getPlanProgress(p).isComplete)

      if (plans.length === 0) {
        contextInfo += `
## No Plans Found

No Prometheus plan files found at .sisyphus/plans/
Use Prometheus to create a work plan first: /plan "your task"`
      } else if (incompletePlans.length === 0) {
        contextInfo += `

## All Plans Complete

All ${plans.length} plan(s) are complete. Create a new plan with: /plan "your task"`
      } else if (incompletePlans.length === 1) {
        const planPath = incompletePlans[0]
        const progress = getPlanProgress(planPath)
        const newState = createBoulderState(planPath, sessionId, activeAgent, worktreePath)
        writeBoulderState(ctx.directory, newState)

        contextInfo += `

## Auto-Selected Plan

**Plan**: ${getPlanName(planPath)}
**Path**: ${planPath}
**Progress**: ${progress.completed}/${progress.total} tasks
**Session ID**: ${sessionId}
**Started**: ${timestamp}
${worktreeBlock}
${evidenceGateBlock}

boulder.json has been created. Read the plan and begin execution.
${delegationKickoffBlock}`
      } else {
        const planList = incompletePlans
          .map((p, i) => {
            const progress = getPlanProgress(p)
            const modified = new Date(statSync(p).mtimeMs).toISOString()
            return `${i + 1}. [${getPlanName(p)}] - Modified: ${modified} - Progress: ${progress.completed}/${progress.total}`
          })
          .join("\n")

        contextInfo += `

<system-reminder>
## Multiple Plans Found

Current Time: ${timestamp}
Session ID: ${sessionId}

${planList}

Ask the user which plan to work on. Present the options above and wait for their response.
${worktreeBlock}
</system-reminder>`
      }
    }

    const idx = output.parts.findIndex((p) => p.type === "text" && p.text)
    if (idx >= 0 && output.parts[idx].text) {
      output.parts[idx].text = output.parts[idx].text
        .replace(/\$SESSION_ID/g, sessionId)
        .replace(/\$TIMESTAMP/g, timestamp)

      output.parts[idx].text += `\n\n---\n${contextInfo}`
    }

    log(`[${HOOK_NAME}] Context injected`, {
      sessionID: sessionId,
      hasExistingState: !!existingState,
      worktreePath,
    })
  }

  return {
    "chat.message": async (input: StartWorkHookInput, output: StartWorkHookOutput): Promise<void> => {
      const parts = output.parts
      const promptText =
        parts
          ?.filter((p) => p.type === "text" && p.text)
          .map((p) => p.text)
          .join("\n")
          .trim() || ""
      await injectStartWorkContext(input.sessionID, promptText, output)
    },
    "command.execute.before": async (
      input: StartWorkCommandExecuteBeforeInput,
      output: StartWorkHookOutput,
    ): Promise<void> => {
      const promptText = `/start-work${input.arguments ? ` ${input.arguments}` : ""}`
      await injectStartWorkContext(input.sessionID, promptText, output)
    },
  }
}
