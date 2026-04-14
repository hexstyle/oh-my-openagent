import { OMO_INTERNAL_INITIATOR_MARKER } from "../../shared/internal-initiator-marker"
import { WATCHDOG_CONTINUATION_PROMPT } from "./constants"

export type LoopDetectionResult = {
  isTerminal: boolean
  count: number
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

export function isInternalInitiatorMessage(
  parts: Array<{ type?: string; text?: string }> | undefined,
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
