import { OMO_INTERNAL_INITIATOR_MARKER } from "../../shared/internal-initiator-marker"

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

export function isInternalInitiatorMessage(
  parts: Array<{ type?: string; text?: string }> | undefined,
): boolean {
  return (parts ?? []).some(
    (part) =>
      part.type === "text"
      && typeof part.text === "string"
      && part.text.includes(OMO_INTERNAL_INITIATOR_MARKER),
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
