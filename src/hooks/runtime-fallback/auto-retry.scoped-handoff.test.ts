import { describe, expect, it } from "bun:test"

import { createAutoRetryHelpers } from "./auto-retry"
import { createFallbackState } from "./fallback-state"
import type { HookDeps } from "./types"
import { OMO_INTERNAL_INITIATOR_MARKER } from "../../shared/internal-initiator-marker"

function createDeps(args: {
  createCalls: Array<unknown>
  promptCalls: Array<unknown>
  messagesResponse?: unknown
}): HookDeps {
  return {
    ctx: {
      directory: "/tmp/runtime-fallback-scoped-handoff",
      client: {
        session: {
          create: async (input) => {
            args.createCalls.push(input)
            return { data: { id: "ses_scoped_child" } }
          },
          get: async () => ({
            data: {
              directory: "/tmp/runtime-fallback-scoped-handoff/project",
            },
          }),
          abort: async () => undefined,
          messages: async () => ({
            data: [
              {
                info: { role: "user" },
                parts: [{ type: "text", text: "Implement the current plan and keep the todo state intact." }],
              },
            ],
            ...(typeof args.messagesResponse === "object" && args.messagesResponse !== null
              ? args.messagesResponse as Record<string, unknown>
              : {}),
          }),
          promptAsync: async (input) => {
            args.promptCalls.push(input)
            return undefined
          },
        },
        tui: {
          showToast: async () => undefined,
        },
      },
    },
    config: {
      enabled: true,
      retry_on_errors: [402, 429, 500, 502, 503, 504],
      max_fallback_attempts: 12,
      max_full_chain_cycles: 5,
      cooldown_seconds: 300,
      timeout_seconds: 0,
      transient_retry_window_seconds: 900,
      transient_retry_initial_delay_seconds: 10,
      transient_retry_max_delay_seconds: 300,
      notify_on_fallback: false,
    },
    options: undefined,
    pluginConfig: {} as HookDeps["pluginConfig"],
    loopDetector: { record: () => 0, reset: () => {}, get: () => 0 },
    sessionStates: new Map(),
    sessionLastAccess: new Map(),
    sessionLastUserMessageIDs: new Map(),
    sessionRecentCompletionUntil: new Map(),
    sessionRecentActiveStatusUntil: new Map(),
    sessionSilentAssistantUpdateCounts: new Map(),
    sessionRetryInFlight: new Set(),
    sessionAwaitingFallbackResult: new Set(),
    sessionFallbackTimeouts: new Map(),
    sessionTransientRetryTimeouts: new Map(),
    sessionStatusRetryKeys: new Map(),
  }
}

describe("runtime fallback scoped handoff", () => {
  it("launches a child session instead of replaying a paid planner session onto spark", async () => {
    const createCalls: Array<unknown> = []
    const promptCalls: Array<unknown> = []
    const deps = createDeps({ createCalls, promptCalls })
    const sessionID = "ses_parent_scoped_handoff"
    const state = createFallbackState("anthropic/claude-opus-4-6", [
      "openai/gpt-5.4",
      "openai/gpt-5.3-codex-spark",
    ])

    deps.sessionStates.set(sessionID, state)

    const helpers = createAutoRetryHelpers(deps)
    const dispatched = await helpers.autoRetryWithFallback(
      sessionID,
      "openai/gpt-5.3-codex-spark",
      "Prometheus (Plan Builder)",
      "session.error.fallback_chain",
      { previousModel: "anthropic/claude-opus-4-6" },
    )

    expect(dispatched).toBe(true)
    expect(createCalls).toHaveLength(1)
    expect(
      (createCalls[0] as { body?: { parentID?: string; title?: string } }).body,
    ).toMatchObject({
      parentID: sessionID,
      title: "[runtime-fallback] Scoped Fallback: gpt-5.3-codex-spark",
    })

    expect(promptCalls).toHaveLength(1)
    expect(
      (promptCalls[0] as { path?: { id?: string } }).path?.id,
    ).toBe("ses_scoped_child")
    expect(
      (promptCalls[0] as { body?: { model?: { providerID?: string; modelID?: string } } }).body?.model,
    ).toEqual({
      providerID: "openai",
      modelID: "gpt-5.3-codex-spark",
    })

    const retryText = (
      promptCalls[0] as { body?: { parts?: Array<{ text?: string }> } }
    ).body?.parts?.[0]?.text
    expect(retryText).toContain(OMO_INTERNAL_INITIATOR_MARKER)
    expect(retryText).toContain("Scoped fallback handoff")
    expect(retryText).toContain("Implement the current plan and keep the todo state intact.")
  })

  it("keeps paid-to-paid fallback in the parent session", async () => {
    const createCalls: Array<unknown> = []
    const promptCalls: Array<unknown> = []
    const deps = createDeps({ createCalls, promptCalls })
    const sessionID = "ses_parent_same_session"
    const state = createFallbackState("anthropic/claude-opus-4-6", [
      "openai/gpt-5.4",
    ])

    deps.sessionStates.set(sessionID, state)

    const helpers = createAutoRetryHelpers(deps)
    const dispatched = await helpers.autoRetryWithFallback(
      sessionID,
      "openai/gpt-5.4",
      "Prometheus (Plan Builder)",
      "session.error.fallback_chain",
      { previousModel: "anthropic/claude-opus-4-6" },
    )

    expect(dispatched).toBe(true)
    expect(createCalls).toHaveLength(0)
    expect(
      (promptCalls[0] as { path?: { id?: string } }).path?.id,
    ).toBe(sessionID)
  })

  it("keeps explore on the narrow same-session lane", async () => {
    const createCalls: Array<unknown> = []
    const promptCalls: Array<unknown> = []
    const deps = createDeps({ createCalls, promptCalls })
    const sessionID = "ses_explore_same_lane"
    const state = createFallbackState("openai/gpt-5.3-codex-spark", [
      "opencode/nemotron-3-super-free",
    ])

    state.currentModel = "openai/gpt-5.3-codex-spark"
    deps.sessionStates.set(sessionID, state)

    const helpers = createAutoRetryHelpers(deps)
    const dispatched = await helpers.autoRetryWithFallback(
      sessionID,
      "opencode/nemotron-3-super-free",
      "Explore (Code Search)",
      "session.error.limit_fallback",
      { previousModel: "openai/gpt-5.3-codex-spark" },
    )

    expect(dispatched).toBe(true)
    expect(createCalls).toHaveLength(0)
    expect(
      (promptCalls[0] as { path?: { id?: string } }).path?.id,
    ).toBe(sessionID)
    expect(
      (promptCalls[0] as { body?: { agent?: string } }).body?.agent,
    ).toBe("explore")
  })

  it("retries spark-to-free in the same session even when only internal continuation messages remain", async () => {
    const createCalls: Array<unknown> = []
    const promptCalls: Array<unknown> = []
    const deps = createDeps({
      createCalls,
      promptCalls,
      messagesResponse: {
        data: [
          {
            info: { role: "user" },
            parts: [{
              type: "text",
              text: `${OMO_INTERNAL_INITIATOR_MARKER}\nContinue the current task from where you left off.`,
            }],
          },
        ],
      },
    })
    const sessionID = "ses_spark_free_internal_only"
    const state = createFallbackState("openai/gpt-5.3-codex-spark", [
      "opencode/nemotron-3-super-free",
    ])

    state.currentModel = "openai/gpt-5.3-codex-spark"
    deps.sessionStates.set(sessionID, state)

    const helpers = createAutoRetryHelpers(deps)
    const dispatched = await helpers.autoRetryWithFallback(
      sessionID,
      "opencode/nemotron-3-super-free",
      "Atlas (Plan Executor)",
      "session.error.limit_fallback",
      { previousModel: "openai/gpt-5.3-codex-spark" },
    )

    expect(dispatched).toBe(true)
    expect(createCalls).toHaveLength(0)
    expect(promptCalls).toHaveLength(1)
    expect(
      (promptCalls[0] as { path?: { id?: string } }).path?.id,
    ).toBe(sessionID)
    expect(
      (promptCalls[0] as { body?: { model?: { providerID?: string; modelID?: string } } }).body?.model,
    ).toEqual({
      providerID: "opencode",
      modelID: "nemotron-3-super-free",
    })
  })

  it("still creates a scoped fallback handoff when no reusable user brief is available", async () => {
    const createCalls: Array<unknown> = []
    const promptCalls: Array<unknown> = []
    const deps = createDeps({
      createCalls,
      promptCalls,
      messagesResponse: {
        data: [
          {
            info: { role: "user" },
            parts: [{
              type: "text",
              text: `${OMO_INTERNAL_INITIATOR_MARKER}\nContinue the current task from where you left off.`,
            }],
          },
        ],
      },
    })
    const sessionID = "ses_scoped_no_brief"
    const state = createFallbackState("anthropic/claude-opus-4-6", [
      "openai/gpt-5.3-codex-spark",
    ])

    deps.sessionStates.set(sessionID, state)

    const helpers = createAutoRetryHelpers(deps)
    const dispatched = await helpers.autoRetryWithFallback(
      sessionID,
      "openai/gpt-5.3-codex-spark",
      "Prometheus (Plan Builder)",
      "session.error.fallback_chain",
      { previousModel: "anthropic/claude-opus-4-6" },
    )

    expect(dispatched).toBe(true)
    expect(createCalls).toHaveLength(1)
    expect(promptCalls).toHaveLength(1)
    expect(
      (promptCalls[0] as { path?: { id?: string } }).path?.id,
    ).toBe("ses_scoped_child")
    const retryText = (
      promptCalls[0] as { body?: { parts?: Array<{ text?: string }> } }
    ).body?.parts?.[0]?.text
    expect(retryText).toContain("No reusable user brief was available from the parent session.")
  })
})
