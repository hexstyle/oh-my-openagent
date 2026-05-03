import { describe, test, expect, beforeEach } from "bun:test"
import {
  setSessionTools,
  getSessionTools,
  clearSessionTools,
  isSessionToolDisabled,
  setSessionFlag,
  hasSessionFlag,
} from "./session-tools-store"

describe("session-tools-store", () => {
  beforeEach(() => {
    clearSessionTools()
  })

  test("returns undefined for unknown session", () => {
    //#given
    const sessionID = "ses_unknown"

    //#when
    const result = getSessionTools(sessionID)

    //#then
    expect(result).toBeUndefined()
  })

  test("stores and retrieves tools for a session", () => {
    //#given
    const sessionID = "ses_abc123"
    const tools = { question: false, task: true, call_omo_agent: true }

    //#when
    setSessionTools(sessionID, tools)
    const result = getSessionTools(sessionID)

    //#then
    expect(result).toEqual({ question: false, task: true, call_omo_agent: true })
  })

  test("overwrites existing tools for same session", () => {
    //#given
    const sessionID = "ses_abc123"
    setSessionTools(sessionID, { question: false })

    //#when
    setSessionTools(sessionID, { question: true, task: false })
    const result = getSessionTools(sessionID)

    //#then
    expect(result).toEqual({ question: true, task: false })
  })

  test("clearSessionTools removes all entries", () => {
    //#given
    setSessionTools("ses_1", { question: false })
    setSessionTools("ses_2", { task: true })

    //#when
    clearSessionTools()

    //#then
    expect(getSessionTools("ses_1")).toBeUndefined()
    expect(getSessionTools("ses_2")).toBeUndefined()
  })

  test("returns a copy, not a reference", () => {
    //#given
    const sessionID = "ses_abc123"
    const tools = { question: false }
    setSessionTools(sessionID, tools)

    //#when
    const result = getSessionTools(sessionID)!
    result.question = true

    //#then
    expect(getSessionTools(sessionID)).toEqual({ question: false })
  })

  test("matches wildcard tool disables case-insensitively", () => {
    //#given
    const sessionID = "ses_wildcard"
    setSessionTools(sessionID, { "task_*": false })

    //#when / #then
    expect(isSessionToolDisabled(sessionID, "task_background")).toBe(true)
    expect(isSessionToolDisabled(sessionID, "TASK_sync")).toBe(true)
    expect(isSessionToolDisabled(sessionID, "task")).toBe(false)
  })

  test("stores and clears session flags with tool state", () => {
    //#given
    const sessionID = "ses_flags"

    //#when
    setSessionFlag(sessionID, "ci-fast-path")

    //#then
    expect(hasSessionFlag(sessionID, "ci-fast-path")).toBe(true)

    //#when
    clearSessionTools()

    //#then
    expect(hasSessionFlag(sessionID, "ci-fast-path")).toBe(false)
  })
})
