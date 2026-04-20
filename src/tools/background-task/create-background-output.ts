import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { BackgroundTask } from "../../features/background-agent"
import { storeToolMetadata } from "../../features/tool-metadata-store"
import type { BackgroundOutputArgs } from "./types"
import type { BackgroundOutputClient, BackgroundOutputManager, BackgroundOutputMessage } from "./clients"
import { BACKGROUND_OUTPUT_DESCRIPTION } from "./constants"
import { delay } from "./delay"
import { formatFullSession } from "./full-session-format"
import { formatTaskResult } from "./task-result-format"
import { extractMessages, getErrorMessage } from "./session-messages"
import { formatTaskStatus } from "./task-status-format"

import { getAgentDisplayName, normalizeAgentForDisplay } from "../../shared/agent-display-names"
import { recordBackgroundOutputConsumption } from "../../shared/background-output-consumption"
import { log } from "../../shared/logger"

const SISYPHUS_JUNIOR_AGENT = getAgentDisplayName("sisyphus-junior")

type ToolContextWithMetadata = {
  sessionID: string
  messageID?: string
  metadata?: (input: { title?: string; metadata?: Record<string, unknown> }) => void
  callID?: string
  callId?: string
  call_id?: string
}

function resolveToolCallID(ctx: ToolContextWithMetadata): string | undefined {
  if (typeof ctx.callID === "string" && ctx.callID.trim() !== "") return ctx.callID
  if (typeof ctx.callId === "string" && ctx.callId.trim() !== "") return ctx.callId
  if (typeof ctx.call_id === "string" && ctx.call_id.trim() !== "") return ctx.call_id
  return undefined
}

function formatResolvedTitle(task: BackgroundTask): string {
  const displayAgent = normalizeAgentForDisplay(task.agent) ?? task.agent
  const label = displayAgent === SISYPHUS_JUNIOR_AGENT && task.category ? task.category : displayAgent
  return `${label} - ${task.description}`
}

function isTaskActiveStatus(status: BackgroundTask["status"]): boolean {
  return status === "pending" || status === "running"
}

function appendTimeoutNote(output: string, timeoutMs: number): string {
  return `${output}\n\n> **Timed out waiting** after ${timeoutMs}ms. Task is still running; showing latest available output.`
}

function extractTextCandidates(part: NonNullable<BackgroundOutputMessage["parts"]>[number]): string[] {
  const result: string[] = []

  if (typeof part.text === "string" && part.text.length > 0) {
    result.push(part.text)
  }

  if (typeof part.output === "string" && part.output.length > 0) {
    result.push(part.output)
  }

  if (typeof part.content === "string" && part.content.length > 0) {
    result.push(part.content)
  }

  if (Array.isArray(part.content)) {
    for (const block of part.content) {
      if ((block.type === "text" || block.type === "reasoning") && typeof block.text === "string" && block.text.length > 0) {
        result.push(block.text)
      }
    }
  }

  return result
}

function extractRecoveredTaskReference(text: string, taskID: string): { sessionID: string; description?: string; agent?: string } | null {
  const metadataBlocks = [...text.matchAll(/<task_metadata>([\s\S]*?)<\/task_metadata>/gi)]
  if (metadataBlocks.length === 0) return null

  const description = text.match(/Description:\s*([^\n\r]+)/i)?.[1]?.trim()
  const agentFromBody = text.match(/Agent:\s*([^\n\r]+)/i)?.[1]?.trim()

  for (let index = metadataBlocks.length - 1; index >= 0; index -= 1) {
    const block = metadataBlocks[index]?.[1] ?? ""
    const blockTaskID = block.match(/(?:background_task_id|task_id):\s*([^\s<]+)/i)?.[1]
    if (blockTaskID !== taskID) continue

    const sessionID = block.match(/session_id:\s*(ses_[^\s<]+)/i)?.[1]
    if (!sessionID) continue

    const subagent = block.match(/subagent:\s*([^\n\r<]+)/i)?.[1]?.trim()
    return {
      sessionID,
      description,
      agent: subagent ?? agentFromBody,
    }
  }

  return null
}

async function recoverTaskFromParentHistory(
  client: BackgroundOutputClient,
  parentSessionID: string,
  parentMessageID: string | undefined,
  taskID: string,
): Promise<BackgroundTask | null> {
  log("[background_output] attempting task recovery from parent history", {
    parentSessionID,
    parentMessageID,
    taskID,
  })
  const parentMessagesResult = await client.session.messages({
    path: { id: parentSessionID },
  })

  const parentError = getErrorMessage(parentMessagesResult)
  if (parentError) {
    log("[background_output] parent history recovery failed: parent messages error", {
      parentSessionID,
      taskID,
      error: parentError,
    })
    return null
  }

  const parentMessages = extractMessages(parentMessagesResult)
  for (let messageIndex = parentMessages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = parentMessages[messageIndex]
    const parts = message.parts ?? []
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex]
      for (const candidate of extractTextCandidates(part)) {
        const recovered = extractRecoveredTaskReference(candidate, taskID)
        if (!recovered) continue

        const childMessagesResult = await client.session.messages({
          path: { id: recovered.sessionID },
        })
        const childError = getErrorMessage(childMessagesResult)
        const childMessages = childError ? [] : extractMessages(childMessagesResult)
        const detectedAgent = recovered.agent
          ?? childMessages.find((childMessage) => typeof childMessage.info?.agent === "string" && childMessage.info.agent.length > 0)?.info?.agent
          ?? "Recovered background task"
        const now = new Date()

        return {
          id: taskID,
          sessionID: recovered.sessionID,
          parentSessionID,
          parentMessageID: parentMessageID ?? "recovered",
          description: recovered.description ?? "Recovered background task",
          prompt: "Recovered from session history after process restart",
          agent: detectedAgent,
          status: childError ? "error" : "completed",
          startedAt: now,
          completedAt: now,
          ...(childError ? { error: childError } : {}),
        }
      }
    }
  }

  log("[background_output] parent history recovery found no matching task metadata", {
    parentSessionID,
    taskID,
  })
  return null
}

export function createBackgroundOutput(manager: BackgroundOutputManager, client: BackgroundOutputClient): ToolDefinition {
  return tool({
    description: BACKGROUND_OUTPUT_DESCRIPTION,
    args: {
      task_id: tool.schema.string().describe("Task ID to get output from"),
      block: tool.schema
        .boolean()
        .optional()
        .describe(
          "Wait for completion (default: false). System notifies when done, so blocking is rarely needed."
        ),
      timeout: tool.schema.number().optional().describe("Max wait time in ms (default: 60000, max: 600000)"),
      full_session: tool.schema.boolean().optional().describe("Return full session messages with filters (default: false)"),
      include_thinking: tool.schema.boolean().optional().describe("Include thinking/reasoning parts in full_session output (default: false)"),
      message_limit: tool.schema.number().optional().describe("Max messages to return (capped at 100)"),
      since_message_id: tool.schema.string().optional().describe("Return messages after this message ID (exclusive)"),
      include_tool_results: tool.schema.boolean().optional().describe("Include tool results in full_session output (default: false)"),
      thinking_max_chars: tool.schema.number().optional().describe("Max characters for thinking content (default: 2000)"),
    },
    async execute(args: BackgroundOutputArgs, toolContext) {
      try {
        const ctx = toolContext as ToolContextWithMetadata
        const directTask = manager.getTask(args.task_id)
        const task = directTask
          ?? (
            ctx.sessionID
              ? await recoverTaskFromParentHistory(client, ctx.sessionID, ctx.messageID, args.task_id)
              : null
          )
        if (!directTask && task) {
          log("[background_output] recovered missing task from parent session history", {
            taskID: args.task_id,
            parentSessionID: ctx.sessionID,
            recoveredSessionID: task.sessionID,
            status: task.status,
          })
        }
        if (!task) {
          log("[background_output] task not found after recovery attempt", {
            taskID: args.task_id,
            parentSessionID: ctx.sessionID,
          })
          return `Task not found: ${args.task_id}`
        }

        const meta = {
          title: formatResolvedTitle(task),
          metadata: {
            task_id: task.id,
            agent: normalizeAgentForDisplay(task.agent) ?? task.agent,
            category: task.category,
            description: task.description,
            ...(task.sessionID ? { sessionId: task.sessionID } : {}),
          } as Record<string, unknown>,
        }
        ctx.metadata?.(meta)

        const callID = resolveToolCallID(ctx)
        if (callID) {
          storeToolMetadata(ctx.sessionID, callID, meta)
        }

        const shouldBlock = args.block === true
        const timeoutMs = Math.min(args.timeout ?? 60000, 600000)

        let resolvedTask = task

        let didTimeoutWhileActive = false

        if (shouldBlock && isTaskActiveStatus(task.status)) {
          const startTime = Date.now()
          while (Date.now() - startTime < timeoutMs) {
            await delay(1000)

            const currentTask = manager.getTask(args.task_id)
            if (!currentTask) {
              return `Task was deleted: ${args.task_id}`
            }

            resolvedTask = currentTask

            if (!isTaskActiveStatus(currentTask.status)) {
              break
            }
          }

          if (isTaskActiveStatus(resolvedTask.status)) {
            const finalCheck = manager.getTask(args.task_id)
            if (finalCheck) {
              resolvedTask = finalCheck
            }
          }

          if (isTaskActiveStatus(resolvedTask.status)) {
            didTimeoutWhileActive = true
          }
        }

        const fullSession = args.full_session ?? false
        const includeThinking = args.include_thinking ?? false
        const includeToolResults = args.include_tool_results ?? false

        if (fullSession) {
          const output = await formatFullSession(resolvedTask, client, {
            includeThinking,
            messageLimit: args.message_limit,
            sinceMessageId: args.since_message_id,
            includeToolResults,
            thinkingMaxChars: args.thinking_max_chars,
          })

          return didTimeoutWhileActive ? appendTimeoutNote(output, timeoutMs) : output
        }

        if (resolvedTask.status === "completed") {
          recordBackgroundOutputConsumption(ctx.sessionID, ctx.messageID, resolvedTask.sessionID)
          return await formatTaskResult(resolvedTask, client)
        }

        if (resolvedTask.status === "error" || resolvedTask.status === "cancelled" || resolvedTask.status === "interrupt") {
          return formatTaskStatus(resolvedTask)
        }

        const statusOutput = formatTaskStatus(resolvedTask)
        return didTimeoutWhileActive ? appendTimeoutNote(statusOutput, timeoutMs) : statusOutput
      } catch (error) {
        return `Error getting output: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  })
}
