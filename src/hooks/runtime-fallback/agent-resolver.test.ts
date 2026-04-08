import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { _resetForTesting, setSessionAgent } from "../../features/claude-code-session-state"
import { resolveAgentForSession } from "./agent-resolver"

describe("runtime-fallback agent resolver", () => {
  beforeEach(() => {
    _resetForTesting()
  })

  afterEach(() => {
    _resetForTesting()
  })

  test("prefers the stored session agent over a transient event agent", () => {
    const sessionID = "ses_prometheus_session"
    setSessionAgent(sessionID, "Prometheus (Plan Builder)")

    expect(resolveAgentForSession(sessionID, "Explore (Code Search)")).toBe("prometheus")
  })

  test("falls back to the event agent when no session agent is stored", () => {
    expect(resolveAgentForSession("ses_transient_agent", "Explore (Code Search)")).toBe("explore")
  })
})
