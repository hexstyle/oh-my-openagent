export interface RunResult {
  sessionId: string
  success: boolean
  durationMs: number
  messageCount: number
  summary: string
}

export type StreamEvent =
  | {
    type: "session.started"
    sessionId: string
    agent: string
    resumed: boolean
    model?: { providerID: string; modelID: string }
  }
  | {
    type: "message.delta"
    sessionId: string
    messageId?: string
    partId?: string
    delta: string
  }
  | {
    type: "message.completed"
    sessionId: string
    messageId?: string
    partId?: string
    text: string
  }
  | {
    type: "tool.started"
    sessionId: string
    toolName: string
    input?: unknown
  }
  | {
    type: "tool.completed"
    sessionId: string
    toolName: string
    output?: string
    status: "completed" | "error"
  }
  | {
    type: "session.idle"
    sessionId: string
  }
  | {
    type: "session.question"
    sessionId: string
    toolName: string
    input?: unknown
    question?: string
  }
  | {
    type: "session.completed"
    sessionId: string
    result: RunResult
  }
  | {
    type: "session.error"
    sessionId: string
    error: string
  }
  | {
    type: "raw"
    sessionId: string
    payload: unknown
  }

export interface OmoRunInvocationOptions {
  sessionId?: string
  signal?: AbortSignal
  agent?: string
  model?: string
}

export interface CreateOmoRunnerOptions {
  directory: string
  agent?: string
  port?: number
  model?: string
  attach?: string
  includeRawEvents?: boolean
  onIdle?: (event: Extract<StreamEvent, { type: "session.idle" }>) => void | Promise<void>
  onQuestion?: (event: Extract<StreamEvent, { type: "session.question" }>) => void | Promise<void>
  onComplete?: (event: Extract<StreamEvent, { type: "session.completed" }>) => void | Promise<void>
  onError?: (event: Extract<StreamEvent, { type: "session.error" }>) => void | Promise<void>
}

export interface OmoRunner {
  run(prompt: string, options?: OmoRunInvocationOptions): Promise<RunResult>
  stream(prompt: string, options?: OmoRunInvocationOptions): AsyncIterable<StreamEvent>
  close(): Promise<void>
}
