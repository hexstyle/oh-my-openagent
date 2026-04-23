export interface EventState {
  mainSessionIdle: boolean
  mainSessionError: boolean
  /** Recoverable same-model retry is in flight; completion must not exit on a transiently-settled root. */
  pendingSameModelRecovery: boolean
  /** Error sequence that armed the pending same-model recovery window. */
  pendingSameModelRecoverySequence: number
  /** Timestamp when the pending same-model recovery window started. */
  pendingSameModelRecoveryStartedAt: number | null
  lastError: string | null
  /** Monotonic counter of main-session error events */
  errorSequence: number
  /** Timestamp of the latest main-session error event */
  lastErrorTimestamp: number | null
  lastOutput: string
  lastPartText: string
  currentTool: string | null
  /** Set to true when the main session has produced meaningful work (text, tool call, or tool result) */
  hasReceivedMeaningfulWork: boolean
  /** Timestamp of the last meaningful assistant/tool activity observed on the main session. */
  lastMeaningfulWorkTimestamp: number | null
  /** Timestamp of the last received event (for watchdog detection) */
  lastEventTimestamp: number
  /** Count of assistant messages for the main session */
  messageCount: number
  /** Current agent name from the latest assistant message */
  currentAgent: string | null
  /** Current model ID from the latest assistant message */
  currentModel: string | null
  /** Current model variant from the latest assistant message */
  currentVariant: string | null
  /** Current message role (user/assistant) — used to filter user messages from display */
  currentMessageRole: string | null
  /** Agent profile colors keyed by display name */
  agentColorsByName: Record<string, string>
  /** Part type registry keyed by partID (text, reasoning, tool, ...) */
  partTypesById: Record<string, string>
  /** Whether a THINK block is currently open in output */
  inThinkBlock: boolean
  /** Tracks streamed reasoning text to avoid duplicates */
  lastReasoningText: string
  /** Whether compact thinking line already printed for current reasoning block */
  hasPrintedThinkingLine: boolean
  /** Last rendered thinking line width (for in-place padding updates) */
  lastThinkingLineWidth: number
  /** Message role lookup by message ID to filter user parts */
  messageRoleById: Record<string, string>
  /** Last rendered thinking summary (to avoid duplicate re-render) */
  lastThinkingSummary: string
  /** Whether text stream is currently at line start (for padding) */
  textAtLineStart: boolean
  /** Whether reasoning stream is currently at line start (for padding) */
  thinkingAtLineStart: boolean
  /** Current assistant message ID — prevents counter resets on repeated message.updated for same message */
  currentMessageId: string | null
  /** Assistant message start timestamp by message ID */
  messageStartedAtById: Record<string, number>
  /** Prevent duplicate completion metadata lines per message */
  completionMetaPrintedByMessageId: Record<string, boolean>
}

export function createEventState(): EventState {
  return {
    mainSessionIdle: false,
    mainSessionError: false,
    pendingSameModelRecovery: false,
    pendingSameModelRecoverySequence: -1,
    pendingSameModelRecoveryStartedAt: null,
    lastError: null,
    errorSequence: 0,
    lastErrorTimestamp: null,
    lastOutput: "",
    lastPartText: "",
    currentTool: null,
    hasReceivedMeaningfulWork: false,
    lastMeaningfulWorkTimestamp: null,
    lastEventTimestamp: Date.now(),
    messageCount: 0,
    currentAgent: null,
    currentModel: null,
    currentVariant: null,
    currentMessageRole: null,
    agentColorsByName: {},
    partTypesById: {},
    inThinkBlock: false,
    lastReasoningText: "",
    hasPrintedThinkingLine: false,
    lastThinkingLineWidth: 0,
    messageRoleById: {},
    lastThinkingSummary: "",
    textAtLineStart: true,
    thinkingAtLineStart: false,
    currentMessageId: null,
    messageStartedAtById: {},
    completionMetaPrintedByMessageId: {},
  }
}
