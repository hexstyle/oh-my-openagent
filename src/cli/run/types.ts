import type { OpencodeClient } from "@opencode-ai/sdk"
export type { OpencodeClient }

export interface RunOptions {
  message: string
  agent?: string
  model?: string
  timestamp?: boolean
  verbose?: boolean
  directory?: string
  port?: number
  attach?: string
  onComplete?: string
  json?: boolean
  sessionId?: string
}

export interface RunLogger {
  log?: (...args: unknown[]) => void
  error?: (...args: unknown[]) => void
}

export interface ServerConnection {
  client: OpencodeClient
  cleanup: () => void
}

export interface RunResult {
  sessionId: string
  success: boolean
  durationMs: number
  messageCount: number
  summary: string
}

export interface RunContext {
  client: OpencodeClient
  sessionID: string
  directory: string
  abortController: AbortController
  verbose?: boolean
  renderOutput?: boolean
  logger?: RunLogger
}

export interface SessionStartedEvent {
  type: "session.started"
  sessionId: string
  agent: string
  resumed: boolean
  model?: { providerID: string; modelID: string }
}

export interface MessageDeltaEvent {
  type: "message.delta"
  sessionId: string
  messageId?: string
  partId?: string
  delta: string
}

export interface MessageCompletedEvent {
  type: "message.completed"
  sessionId: string
  messageId?: string
  partId?: string
  text: string
}

export interface ToolStartedEvent {
  type: "tool.started"
  sessionId: string
  toolName: string
  input?: unknown
}

export interface ToolCompletedEvent {
  type: "tool.completed"
  sessionId: string
  toolName: string
  output?: string
  status: "completed" | "error"
}

export interface SessionIdleEvent {
  type: "session.idle"
  sessionId: string
}

export interface SessionQuestionEvent {
  type: "session.question"
  sessionId: string
  toolName: string
  input?: unknown
  question?: string
}

export interface SessionCompletedEvent {
  type: "session.completed"
  sessionId: string
  result: RunResult
}

export interface SessionErrorEvent {
  type: "session.error"
  sessionId: string
  error: string
}

export interface RawStreamEvent {
  type: "raw"
  sessionId: string
  payload: EventPayload
}

export type StreamEvent =
  | SessionStartedEvent
  | MessageDeltaEvent
  | MessageCompletedEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | SessionIdleEvent
  | SessionQuestionEvent
  | SessionCompletedEvent
  | SessionErrorEvent
  | RawStreamEvent

export interface RunEventObserver {
  includeRawEvents?: boolean
  onEvent?: (event: StreamEvent) => void | Promise<void>
  onIdle?: (event: SessionIdleEvent) => void | Promise<void>
  onQuestion?: (event: SessionQuestionEvent) => void | Promise<void>
  onComplete?: (event: SessionCompletedEvent) => void | Promise<void>
  onError?: (event: SessionErrorEvent) => void | Promise<void>
}

export interface Todo {
  id?: string;
  content: string;
  status: string;
  priority: string;
}

export interface SessionStatus {
  type: "idle" | "busy" | "retry"
}

export interface ChildSession {
  id: string
}

export interface EventPayload {
  type: string
  properties?: Record<string, unknown>
}

export interface SessionIdleProps {
  sessionID?: string
  sessionId?: string
}

export interface SessionStatusProps {
  sessionID?: string
  sessionId?: string
  status?: { type?: string }
}

export interface MessageUpdatedProps {
  info?: {
    id?: string
    sessionID?: string
    sessionId?: string
    role?: string
    modelID?: string
    providerID?: string
    agent?: string
    variant?: string
  }
}

export interface MessagePartUpdatedProps {
  /** @deprecated Legacy structure — current OpenCode puts sessionID inside part */
  info?: { sessionID?: string; sessionId?: string; role?: string }
  part?: {
    id?: string
    sessionID?: string
    sessionId?: string
    messageID?: string
    type?: string
    text?: string
    /** Tool name (for part.type === "tool") */
    tool?: string
    /** Tool state (for part.type === "tool") */
    state?: { status?: string; input?: Record<string, unknown>; output?: string }
    name?: string
    input?: unknown
    time?: { start?: number; end?: number }
  }
}

export interface MessagePartDeltaProps {
  sessionID?: string
  sessionId?: string
  messageID?: string
  partID?: string
  field?: string
  delta?: string
}

export interface ToolExecuteProps {
  sessionID?: string
  sessionId?: string
  name?: string
  input?: Record<string, unknown>
}

export interface ToolResultProps {
  sessionID?: string
  sessionId?: string
  name?: string
  output?: string
}

export interface SessionErrorProps {
  sessionID?: string
  sessionId?: string
  error?: unknown
}

export interface TuiToastShowProps {
  title?: string
  message?: string
  variant?: "info" | "success" | "warning" | "error"
}
