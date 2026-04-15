import { OMO_INTERNAL_INITIATOR_MARKER } from "../../shared/internal-initiator-marker"
import { createSystemDirective, SystemDirectiveTypes } from "../../shared/system-directive"
import { WATCHDOG_CONTINUATION_PROMPT } from "./constants"

export type LoopDetectionResult = {
  isTerminal: boolean
  count: number
}

type MessagePart = {
  type?: string
  text?: string
}

type MessageLike = {
  info?: {
    role?: string
  }
  parts?: MessagePart[]
}

export const DEFAULT_INTERNAL_CONTINUATION_LOOP_THRESHOLD = 3

export interface LoopDetector {
  recordInternalContinuation(sessionID: string): LoopDetectionResult
  recordVisibleResponse(sessionID: string): void
  reset(sessionID: string): void
}

function normalizeInternalPromptText(text: string): string {
  let normalized = text.trim()

  while (normalized.length >= 2) {
    const firstChar = normalized[0]
    const lastChar = normalized[normalized.length - 1]
    const hasWrappingQuotes =
      firstChar === lastChar &&
      (firstChar === "\"" || firstChar === "'" || firstChar === "`")

    if (!hasWrappingQuotes) {
      break
    }

    normalized = normalized.slice(1, -1).trim()
  }

  return normalized.replace(/\s+/g, " ").trim()
}

const NORMALIZED_WATCHDOG_CONTINUATION_PROMPT = normalizeInternalPromptText(
  WATCHDOG_CONTINUATION_PROMPT,
)
const BOULDER_CONTINUATION_DIRECTIVE = createSystemDirective(SystemDirectiveTypes.BOULDER_CONTINUATION)
const TODO_CONTINUATION_DIRECTIVE = createSystemDirective(SystemDirectiveTypes.TODO_CONTINUATION)

function stripInternalInitiatorMarker(text: string): string {
  return text.replaceAll(OMO_INTERNAL_INITIATOR_MARKER, "").trim()
}

export function isInternalInitiatorMessage(
  parts: MessagePart[] | undefined,
): boolean {
  return (parts ?? []).some(
    (part) => {
      if (part.type !== "text" || typeof part.text !== "string") {
        return false
      }

      return part.text.includes(OMO_INTERNAL_INITIATOR_MARKER)
        || normalizeInternalPromptText(part.text) === NORMALIZED_WATCHDOG_CONTINUATION_PROMPT
    },
  )
}

export function isInternalContinuationMessage(
  parts: MessagePart[] | undefined,
): boolean {
  return (parts ?? []).some(
    (part) => {
      if (part.type !== "text" || typeof part.text !== "string") {
        return false
      }

      const textWithoutMarker = stripInternalInitiatorMarker(part.text)
      const normalizedText = normalizeInternalPromptText(textWithoutMarker)
      const isSystemReminder = textWithoutMarker.trimStart().startsWith("<system-reminder>")

      return normalizedText === NORMALIZED_WATCHDOG_CONTINUATION_PROMPT
        || (part.text.includes(OMO_INTERNAL_INITIATOR_MARKER) && !isSystemReminder)
        || textWithoutMarker.includes(BOULDER_CONTINUATION_DIRECTIVE)
        || textWithoutMarker.includes(TODO_CONTINUATION_DIRECTIVE)
    },
  )
}

export function isLatestStoredInternalContinuation(
  messages: MessageLike[] | undefined,
): boolean {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = messages?.[index]
    if (!message) {
      continue
    }

    const hasTextPart = (message.parts ?? []).some(
      (part) => part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0,
    )
    if (!hasTextPart) {
      continue
    }

    return message.info?.role === "user" && isInternalContinuationMessage(message.parts)
  }
  return false
}

export function createLoopDetector(
  threshold: number = DEFAULT_INTERNAL_CONTINUATION_LOOP_THRESHOLD,
): LoopDetector {
  const sessionCounts = new Map<string, number>()

  return {
    recordInternalContinuation(sessionID: string): LoopDetectionResult {
      const current = (sessionCounts.get(sessionID) ?? 0) + 1
      sessionCounts.set(sessionID, current)
      return {
        isTerminal: current >= threshold,
        count: current,
      }
    },

    recordVisibleResponse(sessionID: string): void {
      sessionCounts.delete(sessionID)
    },

    reset(sessionID: string): void {
      sessionCounts.delete(sessionID)
    },
  }
}
