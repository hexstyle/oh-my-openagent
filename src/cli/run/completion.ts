import pc from "picocolors"
import type { RunContext, Todo, ChildSession, SessionStatus } from "./types"
import { normalizeSDKResponse } from "../../shared"
import {
  getContinuationState,
  type ContinuationState,
} from "./continuation-state"

function isBlockingChildStatus(type: string | undefined): boolean {
  return type === "busy" || type === "retry" || type === "running"
}

type CompletionProbeMessagePart = {
  type?: string
  text?: string
  tool?: string
  state?: {
    status?: string
    output?: string
  }
}

type CompletionProbeMessage = {
  info?: {
    id?: string
    role?: string
    finish?: string
  }
  parts?: CompletionProbeMessagePart[]
}

const NON_TERMINAL_FINISH_REASONS = new Set(["tool-calls", "unknown", "other"])
const BACKGROUND_TASK_ID_PATTERN = /\bbg_[a-zA-Z0-9_-]+\b/g
const BACKGROUND_TASK_STATUS_LINE_PATTERN = /`(bg_[a-zA-Z0-9_-]+)`:[^\n]*\[(RUNNING|PENDING|COMPLETED|ERROR|CANCELLED|INTERRUPTED)\]/g
const BACKGROUND_TASK_STATUS_TABLE_ID_PATTERN = /\|\s*Task ID\s*\|\s*`?(bg_[a-zA-Z0-9_-]+)`?\s*\|/i
const BACKGROUND_TASK_STATUS_TABLE_STATE_PATTERN = /\|\s*Status\s*\|\s*\*\*(running|pending|completed|error|cancelled|interrupt(?:ed)?)\*\*\s*\|/i
const BACKGROUND_TASK_ACTIVE_COUNT_PATTERN = /\*\*Active background tasks:\*\*\s*(\d+)/i

type BackgroundTaskActivity = {
  hasActiveTasks: boolean
}

function normalizeBackgroundTaskTerminalStatus(rawStatus: string | undefined): "active" | "inactive" | null {
  switch ((rawStatus ?? "").toLowerCase()) {
    case "running":
    case "pending":
      return "active"
    case "completed":
    case "error":
    case "cancelled":
    case "interrupt":
    case "interrupted":
      return "inactive"
    default:
      return null
  }
}

function extractBackgroundTaskIDs(text: string): string[] {
  return [...text.matchAll(BACKGROUND_TASK_ID_PATTERN)].map((match) => match[0])
}

function inspectBackgroundTaskActivity(messages: CompletionProbeMessage[]): BackgroundTaskActivity {
  const unresolvedTaskIDs = new Set<string>()
  let hasAnonymousActiveTasks = false

  const markTasks = (taskIDs: Iterable<string>, active: boolean): void => {
    for (const taskID of taskIDs) {
      if (active) {
        unresolvedTaskIDs.add(taskID)
      } else {
        unresolvedTaskIDs.delete(taskID)
      }
    }
  }

  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (part.type === "text") {
        const text = (part.text ?? "").trim()
        if (!text) continue

        if (
          text.includes("[ALL BACKGROUND TASKS COMPLETE]") ||
          text.includes("[ALL BACKGROUND TASKS FINISHED")
        ) {
          unresolvedTaskIDs.clear()
          hasAnonymousActiveTasks = false
          continue
        }

        if (text.includes("[BACKGROUND TASK STATUS]")) {
          const activeCountMatch = text.match(BACKGROUND_TASK_ACTIVE_COUNT_PATTERN)
          if (activeCountMatch) {
            hasAnonymousActiveTasks = Number(activeCountMatch[1]) > 0
          }

          for (const [, taskID, rawStatus] of text.matchAll(BACKGROUND_TASK_STATUS_LINE_PATTERN)) {
            const normalized = normalizeBackgroundTaskTerminalStatus(rawStatus)
            if (normalized === "active") unresolvedTaskIDs.add(taskID)
            if (normalized === "inactive") unresolvedTaskIDs.delete(taskID)
          }
          continue
        }

        if (
          text.includes("[BACKGROUND TASK COMPLETED]") ||
          text.includes("[BACKGROUND TASK ERROR]") ||
          text.includes("[BACKGROUND TASK CANCELLED]") ||
          text.includes("[BACKGROUND TASK INTERRUPTED]")
        ) {
          markTasks(extractBackgroundTaskIDs(text), false)
        }
      }

      const toolOutput = (part.state?.output ?? "").trim()
      if (!toolOutput) continue

      if (toolOutput.includes("Background task launched")) {
        markTasks(extractBackgroundTaskIDs(toolOutput), true)
      }

      const tableTaskID = toolOutput.match(BACKGROUND_TASK_STATUS_TABLE_ID_PATTERN)?.[1]
      const tableTaskStatus = normalizeBackgroundTaskTerminalStatus(
        toolOutput.match(BACKGROUND_TASK_STATUS_TABLE_STATE_PATTERN)?.[1],
      )
      if (tableTaskID && tableTaskStatus === "active") {
        unresolvedTaskIDs.add(tableTaskID)
      } else if (tableTaskID && tableTaskStatus === "inactive") {
        unresolvedTaskIDs.delete(tableTaskID)
      }
    }
  }

  return {
    hasActiveTasks: hasAnonymousActiveTasks || unresolvedTaskIDs.size > 0,
  }
}

function hasVisibleAssistantContent(messages: CompletionProbeMessage[]): boolean {
  return messages.some((message) => {
    if (message.info?.role !== "assistant") return false
    return (message.parts ?? []).some((part) => {
      if (part.type !== "text" && part.type !== "reasoning") return false
      return (part.text ?? "").trim().length > 0
    })
  })
}

function hasUserFacingAssistantContent(message: CompletionProbeMessage | undefined): boolean {
  if (!message || message.info?.role !== "assistant") {
    return false
  }

  return (message.parts ?? []).some((part) => {
    if (part.type !== "text") {
      return false
    }

    return (part.text ?? "").trim().length > 0
  })
}

function hasOpenAssistantExecution(message: CompletionProbeMessage | undefined): boolean {
  if (!message || message.info?.role !== "assistant") {
    return false
  }

  let hasUnclosedStep = false

  for (const part of message.parts ?? []) {
    if (part.type === "step-start") {
      hasUnclosedStep = true
      continue
    }

    if (part.type === "step-finish") {
      hasUnclosedStep = false
      continue
    }

    if (part.type === "tool") {
      const status = part.state?.status
      if (status === "running" || status === "pending") {
        return true
      }
    }
  }

  return hasUnclosedStep
}

function isSessionSettledFromMessages(messages: CompletionProbeMessage[]): boolean {
  if (inspectBackgroundTaskActivity(messages).hasActiveTasks) {
    return false
  }

  let lastUser: CompletionProbeMessage | undefined
  let lastAssistant: CompletionProbeMessage | undefined

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!lastAssistant && message.info?.role === "assistant") lastAssistant = message
    if (!lastUser && message.info?.role === "user") lastUser = message
    if (lastUser && lastAssistant) break
  }

  if (
    lastAssistant?.info?.finish &&
    !NON_TERMINAL_FINISH_REASONS.has(lastAssistant.info.finish) &&
    lastUser &&
    hasUserFacingAssistantContent(lastAssistant)
  ) {
    return true
  }

  if (lastAssistant?.info?.finish) {
    return false
  }

  if (!hasVisibleAssistantContent(messages)) {
    return false
  }

  return !hasOpenAssistantExecution(lastAssistant)
}

async function fetchSessionMessages(
  ctx: RunContext,
  sessionID: string,
): Promise<CompletionProbeMessage[]> {
  const messagesRes = await ctx.client.session.messages({
    path: { id: sessionID },
    query: { directory: ctx.directory },
  })

  return normalizeSDKResponse(messagesRes, [] as CompletionProbeMessage[])
}

async function isSessionTranscriptSettled(
  ctx: RunContext,
  sessionID: string,
  options: { allowEmptyTranscript?: boolean } = {},
): Promise<boolean> {
  const messages = await fetchSessionMessages(ctx, sessionID)
  if (messages.length === 0) {
    return options.allowEmptyTranscript === true
  }

  return isSessionSettledFromMessages(messages)
}

export async function checkCompletionConditions(ctx: RunContext): Promise<boolean> {
  try {
    const continuationState = getContinuationState(ctx.directory, ctx.sessionID)

    if (continuationState.hasActiveHookMarker) {
      const reason = continuationState.activeHookMarkerReason ?? "continuation hook is active"
      logWaiting(ctx, reason)
      return false
    }

    if (!await areAllTodosComplete(ctx)) {
      return false
    }

    if (!await areAllChildrenIdle(ctx)) {
      return false
    }

    if (!areContinuationHooksIdle(ctx, continuationState)) {
      return false
    }

    if (!await isSessionTranscriptSettled(ctx, ctx.sessionID)) {
      logWaiting(ctx, "root session transcript is not settled")
      return false
    }

    return true
  } catch (err) {
    console.error(pc.red(`[completion] API error: ${err}`))
    return false
  }
}

function areContinuationHooksIdle(
  ctx: RunContext,
  continuationState: ContinuationState
): boolean {
  if (continuationState.hasActiveBoulder) {
    logWaiting(ctx, "boulder continuation is active")
    return false
  }

  if (continuationState.hasActiveRalphLoop) {
    logWaiting(ctx, "ralph-loop continuation is active")
    return false
  }

  return true
}

async function areAllTodosComplete(ctx: RunContext): Promise<boolean> {
  const todosRes = await ctx.client.session.todo({
    path: { id: ctx.sessionID },
    query: { directory: ctx.directory },
  })
  const todos = normalizeSDKResponse(todosRes, [] as Todo[])

  const incompleteTodos = todos.filter(
    (t) => t.status !== "completed" && t.status !== "cancelled"
  )

  if (incompleteTodos.length > 0) {
    logWaiting(ctx, `${incompleteTodos.length} todos remaining`)
    return false
  }

  return true
}

async function areAllChildrenIdle(ctx: RunContext): Promise<boolean> {
  const allStatuses = await fetchAllStatuses(ctx)
  return areAllDescendantsIdle(ctx, ctx.sessionID, allStatuses)
}

async function fetchAllStatuses(
  ctx: RunContext
): Promise<Record<string, SessionStatus>> {
  const statusRes = await ctx.client.session.status({
    query: { directory: ctx.directory },
  })
  return normalizeSDKResponse(statusRes, {} as Record<string, SessionStatus>)
}

async function areAllDescendantsIdle(
  ctx: RunContext,
  sessionID: string,
  allStatuses: Record<string, SessionStatus>
): Promise<boolean> {
  const childrenRes = await ctx.client.session.children({
    path: { id: sessionID },
    query: { directory: ctx.directory },
  })
  const children = normalizeSDKResponse(childrenRes, [] as ChildSession[])

  for (const child of children) {
    const status = allStatuses[child.id]
    if (status && isBlockingChildStatus(status.type)) {
      logWaiting(ctx, `session ${child.id.slice(0, 8)}... is ${status.type}`)
      return false
    }

    if (!status) {
      if (!await isSessionTranscriptSettled(ctx, child.id)) {
        logWaiting(ctx, `session ${child.id.slice(0, 8)}... status unavailable`)
        return false
      }
    }

    if (status?.type === "idle") {
      if (!await isSessionTranscriptSettled(ctx, child.id, { allowEmptyTranscript: true })) {
        logWaiting(ctx, `session ${child.id.slice(0, 8)}... has unfinished assistant work`)
        return false
      }
    }

    const descendantsIdle = await areAllDescendantsIdle(
      ctx,
      child.id,
      allStatuses
    )
    if (!descendantsIdle) {
      return false
    }
  }

  return true
}

function logWaiting(ctx: RunContext, message: string): void {
  if (!ctx.verbose) {
    return
  }

  console.log(pc.dim(`  Waiting: ${message}`))
}
