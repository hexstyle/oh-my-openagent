import pc from "picocolors"
import type {
  EventPayload,
  MessagePartDeltaProps,
  MessagePartUpdatedProps,
  RunContext,
  RunEventObserver,
  SessionErrorEvent,
  SessionIdleEvent,
  SessionQuestionEvent,
  StreamEvent,
  ToolCompletedEvent,
  ToolExecuteProps,
  ToolResultProps,
  ToolStartedEvent,
} from "./types"
import type { EventState } from "./event-state"
import { logEventVerbose } from "./event-formatting"
import {
  handleSessionError,
  handleSessionIdle,
  handleSessionStatus,
  handleMessagePartUpdated,
  handleMessagePartDelta,
  handleMessageUpdated,
  handleToolExecute,
  handleToolResult,
  handleTuiToast,
} from "./event-handlers"

const QUESTION_TOOL_NAMES = new Set(["question", "ask_user_question", "askuserquestion"])

async function emitObservedEvent(
  observer: RunEventObserver | undefined,
  event: StreamEvent,
): Promise<void> {
  if (!observer) return

  await observer.onEvent?.(event)
  if (event.type === "session.idle") {
    await observer.onIdle?.(event as SessionIdleEvent)
  }
  if (event.type === "session.question") {
    await observer.onQuestion?.(event as SessionQuestionEvent)
  }
  if (event.type === "session.error") {
    await observer.onError?.(event as SessionErrorEvent)
  }
}

function getEventSessionId(payload: EventPayload): string | undefined {
  const props = payload.properties as Record<string, unknown> | undefined
  if (!props) return undefined
  if (typeof props.sessionID === "string") return props.sessionID
  if (typeof props.sessionId === "string") return props.sessionId
  const info = props.info as Record<string, unknown> | undefined
  if (typeof info?.sessionID === "string") return info.sessionID
  if (typeof info?.sessionId === "string") return info.sessionId
  const part = props.part as Record<string, unknown> | undefined
  if (typeof part?.sessionID === "string") return part.sessionID
  if (typeof part?.sessionId === "string") return part.sessionId
  return undefined
}

function getQuestionText(input: unknown): string | undefined {
  const args = input as { questions?: Array<{ question?: unknown }> } | undefined
  const question = args?.questions?.[0]?.question
  return typeof question === "string" && question.length > 0 ? question : undefined
}

function getToolStartFromPayload(
  payload: EventPayload,
  sessionId: string,
  fallbackToolName: string,
): ToolStartedEvent | SessionQuestionEvent | undefined {
  if (payload.type === "tool.execute") {
    const props = payload.properties as ToolExecuteProps | undefined
    const toolName = props?.name ?? fallbackToolName
    if (QUESTION_TOOL_NAMES.has(toolName.toLowerCase())) {
      return {
        type: "session.question",
        sessionId,
        toolName,
        input: props?.input,
        question: getQuestionText(props?.input),
      }
    }
    return {
      type: "tool.started",
      sessionId,
      toolName,
      input: props?.input,
    }
  }

  if (payload.type === "message.part.updated") {
    const props = payload.properties as MessagePartUpdatedProps | undefined
    const toolName = props?.part?.tool ?? props?.part?.name ?? fallbackToolName
    if (!toolName) return undefined
    const input = props?.part?.state?.input
    if (QUESTION_TOOL_NAMES.has(toolName.toLowerCase())) {
      return {
        type: "session.question",
        sessionId,
        toolName,
        input,
        question: getQuestionText(input),
      }
    }
    return {
      type: "tool.started",
      sessionId,
      toolName,
      input,
    }
  }

  return undefined
}

function getToolCompletedFromPayload(
  payload: EventPayload,
  sessionId: string,
  fallbackToolName: string,
): ToolCompletedEvent | undefined {
  if (payload.type === "tool.result") {
    const props = payload.properties as ToolResultProps | undefined
    return {
      type: "tool.completed",
      sessionId,
      toolName: props?.name ?? fallbackToolName,
      output: props?.output,
      status: "completed",
    }
  }

  if (payload.type === "message.part.updated") {
    const props = payload.properties as MessagePartUpdatedProps | undefined
    const status = props?.part?.state?.status
    if (status !== "completed" && status !== "error") return undefined
    return {
      type: "tool.completed",
      sessionId,
      toolName: props?.part?.tool ?? props?.part?.name ?? fallbackToolName,
      output: props?.part?.state?.output,
      status,
    }
  }

  return undefined
}

export async function processEvents(
  ctx: RunContext,
  stream: AsyncIterable<unknown>,
  state: EventState,
  observer?: RunEventObserver,
): Promise<void> {
  for await (const event of stream) {
    if (ctx.abortController.signal.aborted) break

    try {
      const payload = event as EventPayload
      if (!payload?.type) {
        if (ctx.verbose) {
          console.error(pc.dim(`[event] no type: ${JSON.stringify(event)}`))
        }
        continue
      }

      if (ctx.verbose) {
        logEventVerbose(ctx, payload)
      }

      // Update last event timestamp for watchdog detection
      state.lastEventTimestamp = Date.now()
      const previousIdle = state.mainSessionIdle
      const previousError = state.mainSessionError
      const previousTool = state.currentTool
      const sessionId = getEventSessionId(payload) ?? ctx.sessionID

      if (observer?.includeRawEvents) {
        await emitObservedEvent(observer, {
          type: "raw",
          sessionId,
          payload,
        })
      }

      handleSessionError(ctx, payload, state)
      handleSessionIdle(ctx, payload, state)
      handleSessionStatus(ctx, payload, state)
      handleMessagePartUpdated(ctx, payload, state)
      handleMessagePartDelta(ctx, payload, state)
      handleMessageUpdated(ctx, payload, state)
      handleToolExecute(ctx, payload, state)
      handleToolResult(ctx, payload, state)
      handleTuiToast(ctx, payload, state)

      if (!previousIdle && state.mainSessionIdle) {
        await emitObservedEvent(observer, {
          type: "session.idle",
          sessionId: ctx.sessionID,
        })
      }

      if (!previousError && state.mainSessionError) {
        await emitObservedEvent(observer, {
          type: "session.error",
          sessionId: ctx.sessionID,
          error: state.lastError ?? "Unknown session error",
        })
      }

      if (payload.type === "message.part.delta") {
        const props = payload.properties as MessagePartDeltaProps | undefined
        if (
          sessionId === ctx.sessionID
          && props?.field === "text"
          && typeof props.delta === "string"
          && props.delta.length > 0
        ) {
          await emitObservedEvent(observer, {
            type: "message.delta",
            sessionId: ctx.sessionID,
            messageId: props.messageID,
            partId: props.partID,
            delta: props.delta,
          })
        }
      }

      if (payload.type === "message.part.updated") {
        const props = payload.properties as MessagePartUpdatedProps | undefined
        if (
          sessionId === ctx.sessionID
          && props?.part?.type === "text"
          && typeof props.part.text === "string"
          && props.part.time?.end
        ) {
          await emitObservedEvent(observer, {
            type: "message.completed",
            sessionId: ctx.sessionID,
            messageId: props.part.messageID,
            partId: props.part.id,
            text: props.part.text,
          })
        }
      }

      if (previousTool === null && state.currentTool !== null && sessionId === ctx.sessionID) {
        const toolEvent = getToolStartFromPayload(payload, ctx.sessionID, state.currentTool)
        if (toolEvent) {
          await emitObservedEvent(observer, toolEvent)
        }
      }

      if (previousTool !== null && state.currentTool === null && sessionId === ctx.sessionID) {
        const toolEvent = getToolCompletedFromPayload(payload, ctx.sessionID, previousTool)
        if (toolEvent) {
          await emitObservedEvent(observer, toolEvent)
        }
      }
    } catch (err) {
      const error = ctx.logger?.error ?? console.error
      error(pc.red(`[event error] ${err}`))
    }
  }
}
