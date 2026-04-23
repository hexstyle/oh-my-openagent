import type { PluginInput } from "@opencode-ai/plugin"
import {
  HOOK_NAME,
  BLOCKED_TOOLS,
  PLAN_WRITE_DELEGATION_BLOCK,
  PLANNING_CONSULT_WARNING,
  PROMETHEUS_WORKFLOW_REMINDER,
} from "./constants"
import { log } from "../../shared/logger"
import { SYSTEM_DIRECTIVE_PREFIX } from "../../shared/system-directive"
import { getAgentDisplayName } from "../../shared/agent-display-names"
import { getAgentFromSession } from "./agent-resolution"
import { isPrometheusAgent } from "./agent-matcher"
import { isAllowedFile } from "./path-policy"

const TASK_TOOLS = ["task", "call_omo_agent"]
const PLAN_WRITE_ALLOWED_SUBAGENTS = new Set(["metis", "momus"])

export function createPrometheusMdOnlyHook(ctx: PluginInput) {
  return {
    "tool.execute.before": async (
      input: { tool: string; sessionID: string; callID: string },
      output: { args: Record<string, unknown>; message?: string }
    ): Promise<void> => {
      const agentName = await getAgentFromSession(input.sessionID, ctx.directory, ctx.client)

      if (!isPrometheusAgent(agentName)) {
        return
      }

      const toolName = input.tool

      // Inject planning-only warning for task tools called by Prometheus
       if (TASK_TOOLS.includes(toolName)) {
         const prompt = output.args.prompt as string | undefined
         if (prompt && !prompt.includes(SYSTEM_DIRECTIVE_PREFIX)) {
           output.args.prompt = PLANNING_CONSULT_WARNING + prompt
          log(`[${HOOK_NAME}] Injected planning warning to ${toolName}`, {
            sessionID: input.sessionID,
            tool: toolName,
            agent: agentName,
          })
        }

        if (await isPlanWriteDelegationBlocked(ctx, input.sessionID, output.args)) {
          const delegatedTarget = getDelegatedTarget(output.args)
          log(`[${HOOK_NAME}] Blocked: plan-write delegation during final plan synthesis`, {
            sessionID: input.sessionID,
            tool: toolName,
            agent: agentName,
            delegatedTarget: delegatedTarget ?? "(unknown)",
          })
          throw new Error(
            `${PLAN_WRITE_DELEGATION_BLOCK} Blocked target: ${delegatedTarget ?? "(unknown)"}.`
          )
        }

        return
      }

      if (!BLOCKED_TOOLS.includes(toolName)) {
        return
      }

      const filePath = (output.args.filePath ?? output.args.path ?? output.args.file) as string | undefined
      if (!filePath) {
        return
      }

       if (!isAllowedFile(filePath, ctx.directory)) {
         log(`[${HOOK_NAME}] Blocked: Prometheus can only write to .sisyphus/*.md`, {
           sessionID: input.sessionID,
           tool: toolName,
           filePath,
           agent: agentName,
         })
         throw new Error(
           `[${HOOK_NAME}] Prometheus is a planning agent. File operations restricted to .sisyphus/*.md plan files only. Use task() to delegate implementation. ` +
           `Attempted to modify: ${filePath}. ` +
           `APOLOGIZE TO THE USER, REMIND OF YOUR PLAN WRITING PROCESSES, TELL USER WHAT YOU WILL GOING TO DO AS THE PROCESS, WRITE THE PLAN`
         )
       }

      const normalizedPath = filePath.toLowerCase().replace(/\\/g, "/")
      if (normalizedPath.includes(".sisyphus/plans/") || normalizedPath.includes(".sisyphus\\plans\\")) {
        log(`[${HOOK_NAME}] Injecting workflow reminder for plan write`, {
          sessionID: input.sessionID,
          tool: toolName,
          filePath,
          agent: agentName,
        })
        output.message = (output.message || "") + PROMETHEUS_WORKFLOW_REMINDER
      }

      log(`[${HOOK_NAME}] Allowed: .sisyphus/*.md write permitted`, {
        sessionID: input.sessionID,
        tool: toolName,
        filePath,
        agent: agentName,
      })
    },
  }
}

async function isPlanWriteDelegationBlocked(
  ctx: PluginInput,
  sessionID: string,
  args: Record<string, unknown>
): Promise<boolean> {
  const todos = await readSessionTodos(ctx, sessionID)
  if (!hasPlanWriteTodoInProgress(todos)) {
    return false
  }

  const delegatedTarget = getDelegatedTarget(args)
  if (!delegatedTarget) {
    return true
  }

  return !PLAN_WRITE_ALLOWED_SUBAGENTS.has(delegatedTarget)
}

function getDelegatedTarget(args: Record<string, unknown>): string | undefined {
  const candidates = [
    args.subagent_type,
    args.subagentType,
    args.agent,
    args.agent_name,
    args.agentName,
    args.category,
  ]

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim().toLowerCase()
    }
  }

  return undefined
}

function hasPlanWriteTodoInProgress(
  todos: Array<{ content?: unknown; status?: unknown }>
): boolean {
  return todos.some((todo) => {
    if (todo.status !== "in_progress" || typeof todo.content !== "string") {
      return false
    }

    const content = todo.content.toLowerCase()
    return (
      content.includes("generate") &&
      content.includes("plan") &&
      (content.includes(".sisyphus/plans") || content.includes("work plan"))
    )
  })
}

async function readSessionTodos(
  ctx: PluginInput,
  sessionID: string
): Promise<Array<{ content?: unknown; status?: unknown }>> {
  const todoReader = (ctx as { client?: { session?: { todo?: (input: unknown) => Promise<unknown> } } }).client?.session
    ?.todo

  if (typeof todoReader !== "function") {
    return []
  }

  try {
    const response = await todoReader({ path: { id: sessionID } })
    const data = (response as { data?: unknown[]; error?: unknown })?.data
    if (!Array.isArray(data)) {
      return []
    }

    return data.filter(
      (todo): todo is { content?: unknown; status?: unknown } =>
        typeof todo === "object" && todo !== null
    )
  } catch {
    return []
  }
}
