/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test"
import { OMO_INTERNAL_INITIATOR_MARKER } from "../../shared/internal-initiator-marker"
import {
  createLoopDetector,
  DEFAULT_INTERNAL_CONTINUATION_LOOP_THRESHOLD,
  isInternalInitiatorMessage,
} from "./internal-continuation-loop-detector"

const WATCHDOG_CONTINUATION_PROMPT = "Continue the current task from where you left off. The previous request appears stalled. Resume from the existing context, do not redo completed work, and continue."

describe("isInternalInitiatorMessage", () => {
  it("#given parts containing the internal initiator marker #then returns true", () => {
    const parts = [{ type: "text", text: `Continue.\n${OMO_INTERNAL_INITIATOR_MARKER}` }]

    expect(isInternalInitiatorMessage(parts)).toBe(true)
  })

  it("#given the raw watchdog continuation prompt without marker #then returns true", () => {
    const parts = [{ type: "text", text: WATCHDOG_CONTINUATION_PROMPT }]

    expect(isInternalInitiatorMessage(parts)).toBe(true)
  })

  it("#given the quoted watchdog continuation prompt captured from opencode run #then returns true", () => {
    const parts = [{ type: "text", text: `"${WATCHDOG_CONTINUATION_PROMPT}"\n` }]

    expect(isInternalInitiatorMessage(parts)).toBe(true)
  })

  it("#given parts without the marker #then returns false", () => {
    const parts = [{ type: "text", text: "Hello, please help me" }]

    expect(isInternalInitiatorMessage(parts)).toBe(false)
  })

  it("#given undefined parts #then returns false", () => {
    expect(isInternalInitiatorMessage(undefined)).toBe(false)
  })

  it("#given empty parts #then returns false", () => {
    expect(isInternalInitiatorMessage([])).toBe(false)
  })

  it("#given a non-text part type with marker text #then returns false", () => {
    const parts = [{ type: "tool", text: OMO_INTERNAL_INITIATOR_MARKER }]

    expect(isInternalInitiatorMessage(parts)).toBe(false)
  })

  it("#given the marker embedded among multiple parts #then returns true", () => {
    const parts = [
      { type: "text", text: "some preamble" },
      { type: "text", text: `continuation\n${OMO_INTERNAL_INITIATOR_MARKER}` },
    ]

    expect(isInternalInitiatorMessage(parts)).toBe(true)
  })
})

describe("createLoopDetector", () => {
  const DEFAULT_THRESHOLD = DEFAULT_INTERNAL_CONTINUATION_LOOP_THRESHOLD

  it("#given a new session #when recording first internal continuation #then loop is not terminal", () => {
    const detector = createLoopDetector(DEFAULT_THRESHOLD)

    const result = detector.recordInternalContinuation("session-1")

    expect(result.isTerminal).toBe(false)
    expect(result.count).toBe(1)
  })

  it("#given consecutive internal continuations without visible response #when threshold is reached #then loop becomes terminal", () => {
    const detector = createLoopDetector(DEFAULT_THRESHOLD)

    detector.recordInternalContinuation("session-1")
    detector.recordInternalContinuation("session-1")
    const result = detector.recordInternalContinuation("session-1")

    expect(result.isTerminal).toBe(true)
    expect(result.count).toBe(3)
  })

  it("#given a visible response occurs between internal continuations #when recording next continuation #then count resets", () => {
    const detector = createLoopDetector(DEFAULT_THRESHOLD)

    detector.recordInternalContinuation("session-1")
    detector.recordInternalContinuation("session-1")
    detector.recordVisibleResponse("session-1")
    const result = detector.recordInternalContinuation("session-1")

    expect(result.isTerminal).toBe(false)
    expect(result.count).toBe(1)
  })

  it("#given different sessions #when tracking continuations #then counts are independent", () => {
    const detector = createLoopDetector(DEFAULT_THRESHOLD)

    detector.recordInternalContinuation("session-1")
    detector.recordInternalContinuation("session-1")
    const resultSession2 = detector.recordInternalContinuation("session-2")

    expect(resultSession2.isTerminal).toBe(false)
    expect(resultSession2.count).toBe(1)
  })

  it("#given a session exceeding the threshold #when reset is called #then the session state is cleared", () => {
    const detector = createLoopDetector(DEFAULT_THRESHOLD)

    detector.recordInternalContinuation("session-1")
    detector.recordInternalContinuation("session-1")
    detector.recordInternalContinuation("session-1")
    detector.reset("session-1")
    const result = detector.recordInternalContinuation("session-1")

    expect(result.isTerminal).toBe(false)
    expect(result.count).toBe(1)
  })

  it("#given threshold of 1 #when any internal continuation occurs #then immediately terminal", () => {
    const detector = createLoopDetector(1)

    const result = detector.recordInternalContinuation("session-1")

    expect(result.isTerminal).toBe(true)
    expect(result.count).toBe(1)
  })

  it("#given no explicit threshold #when recording continuations #then default threshold is used", () => {
    const detector = createLoopDetector()

    detector.recordInternalContinuation("session-1")
    detector.recordInternalContinuation("session-1")
    const result = detector.recordInternalContinuation("session-1")

    expect(result.isTerminal).toBe(true)
    expect(result.count).toBe(DEFAULT_INTERNAL_CONTINUATION_LOOP_THRESHOLD)
  })
})
