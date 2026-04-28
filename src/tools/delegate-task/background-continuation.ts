import type { DelegateTaskArgs, ToolContextWithMetadata } from "./types"
import type { ExecutorContext, ParentContext } from "./executor-types"
import { storeToolMetadata } from "../../features/tool-metadata-store"
import { formatDetailedError } from "./error-formatting"
import { getSessionTools } from "../../shared/session-tools-store"
import { normalizeAgentForDisplay } from "../../shared/agent-display-names"

export async function executeBackgroundContinuation(
  args: DelegateTaskArgs,
  ctx: ToolContextWithMetadata,
  executorCtx: ExecutorContext,
  parentContext: ParentContext
): Promise<string> {
  const { manager } = executorCtx

  try {
    const task = await manager.resume({
      sessionId: args.session_id!,
      prompt: args.prompt,
      parentSessionID: parentContext.sessionID,
      parentMessageID: parentContext.messageID,
      parentModel: parentContext.model,
      parentAgent: parentContext.agent,
      parentTools: getSessionTools(parentContext.sessionID),
    })
    const displayAgent = normalizeAgentForDisplay(task.agent) ?? task.agent

    const bgContMeta = {
      title: `Continue: ${task.description}`,
      metadata: {
        prompt: args.prompt,
        agent: displayAgent,
        load_skills: args.load_skills,
        description: args.description,
        run_in_background: args.run_in_background,
        sessionId: task.sessionID,
        command: args.command,
        model: task.model ? { providerID: task.model.providerID, modelID: task.model.modelID } : undefined,
      },
    }
    await ctx.metadata?.(bgContMeta)
    if (ctx.callID) {
      storeToolMetadata(ctx.sessionID, ctx.callID, bgContMeta)
    }

    return `Background task continued.
Task ID: ${task.id}
Agent: ${displayAgent}

Use \`background_output\` with task_id="${task.id}" to check.

<task_metadata>
session_id: ${task.sessionID}
task_id: ${task.id}${displayAgent ? `\nsubagent: ${displayAgent}` : ""}
</task_metadata>`
  } catch (error) {
    return formatDetailedError(error, {
      operation: "Continue background task",
      args,
      sessionID: args.session_id,
    })
  }
}
