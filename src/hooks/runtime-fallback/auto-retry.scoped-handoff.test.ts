import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"

import { createAutoRetryHelpers } from "./auto-retry"
import { createFallbackState } from "./fallback-state"
import type { HookDeps } from "./types"
import { OMO_INTERNAL_INITIATOR_MARKER } from "../../shared/internal-initiator-marker"
import {
  resetRecentRuntimeFallbackContinuationDispatchesForTests,
  wasRecentRuntimeFallbackContinuationDispatched,
} from "../../shared/recent-runtime-fallback-continuation"

function createDeps(args: {
  createCalls: Array<unknown>
  promptCalls: Array<unknown>
  messagesResponse?: unknown
  messagesBySessionID?: Record<string, unknown>
  messagesImpl?: (input?: { path?: { id?: string } }) => Promise<unknown>
  messageCalls?: string[]
  bindCreateToSessionObject?: boolean
  timeoutSeconds?: number
  sessionTimeoutMs?: number
  sessionMessagesRequestTimeoutMs?: number
  sessionData?: {
    directory?: string
    parentID?: string
  }
}): HookDeps {
  const sessionApi = {
    _client: args.bindCreateToSessionObject ? { tag: "bound-client" } : undefined,
    create: async function(this: { _client?: { tag: string } } | undefined, input: unknown) {
      if (args.bindCreateToSessionObject && this?._client?.tag !== "bound-client") {
        throw new TypeError("undefined is not an object (evaluating 'this._client')")
      }
      args.createCalls.push(input)
      return { data: { id: "ses_scoped_child" } }
    },
    get: async () => ({
      data: {
        directory: args.sessionData?.directory ?? "/tmp/runtime-fallback-scoped-handoff/project",
        ...(typeof args.sessionData?.parentID === "string" ? { parentID: args.sessionData.parentID } : {}),
      },
    }),
    abort: async () => undefined,
    messages: async (input?: { path?: { id?: string } }) => {
      if (args.messagesImpl) {
        return await args.messagesImpl(input)
      }
      const targetSessionID = input?.path?.id
      args.messageCalls?.push(targetSessionID ?? "")

      const sessionSpecificResponse =
        typeof targetSessionID === "string"
          ? args.messagesBySessionID?.[targetSessionID]
          : undefined

      return {
        data: [
          {
            info: { role: "user" },
            parts: [{ type: "text", text: "Implement the current plan and keep the todo state intact." }],
          },
        ],
        ...(typeof (sessionSpecificResponse ?? args.messagesResponse) === "object"
          && (sessionSpecificResponse ?? args.messagesResponse) !== null
          ? (sessionSpecificResponse ?? args.messagesResponse) as Record<string, unknown>
          : {}),
      }
    },
    promptAsync: async (input: unknown) => {
      args.promptCalls.push(input)
      return undefined
    },
  }

  return {
    ctx: {
      directory: "/tmp/runtime-fallback-scoped-handoff",
      client: {
        session: sessionApi,
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
      timeout_seconds: args.timeoutSeconds ?? 0,
      transient_retry_window_seconds: 900,
      transient_retry_initial_delay_seconds: 10,
      transient_retry_max_delay_seconds: 300,
      notify_on_fallback: false,
    },
    options: typeof args.sessionTimeoutMs === "number" || typeof args.sessionMessagesRequestTimeoutMs === "number"
      ? {
          ...(typeof args.sessionTimeoutMs === "number"
            ? { session_timeout_ms: args.sessionTimeoutMs }
            : {}),
          ...(typeof args.sessionMessagesRequestTimeoutMs === "number"
            ? { session_messages_request_timeout_ms: args.sessionMessagesRequestTimeoutMs }
            : {}),
        }
      : undefined,
    pluginConfig: {} as HookDeps["pluginConfig"],
    loopDetector: { record: () => 0, reset: () => {}, get: () => 0 },
    sessionStates: new Map(),
    sessionLastAccess: new Map(),
    sessionLastUserMessageIDs: new Map(),
    sessionRecentCompletionUntil: new Map(),
    sessionRecentActiveStatusUntil: new Map(),
    sessionSilentAssistantUpdateCounts: new Map(),
    sessionScopedFallbackHints: new Map(),
    globalModelCooldowns: new Map(),
    sessionRetryInFlight: new Set(),
    sessionAwaitingFallbackResult: new Set(),
    sessionFallbackTimeouts: new Map(),
    sessionTransientRetryTimeouts: new Map(),
    sessionStatusRetryKeys: new Map(),
  }
}

describe("runtime fallback scoped handoff", () => {
  afterEach(() => {
    resetRecentRuntimeFallbackContinuationDispatchesForTests()
  })

  it("launches a child session instead of replaying a paid planner session onto spark", async () => {
    const createCalls: Array<unknown> = []
    const promptCalls: Array<unknown> = []
    const deps = createDeps({
      createCalls,
      promptCalls,
      timeoutSeconds: 30,
    })
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
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(true)
    expect(deps.sessionFallbackTimeouts.has(sessionID)).toBe(true)
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
    expect(
      (promptCalls[0] as { body?: { agent?: string } }).body?.agent,
    ).toBe("Prometheus (Plan Builder)")
  })

  it("keeps the explicit planner agent on fresh same-model retry children after a paid model switch", async () => {
    const createCalls: Array<unknown> = []
    const promptCalls: Array<unknown> = []
    const deps = createDeps({ createCalls, promptCalls })
    const sessionID = "ses_prometheus_fresh_retry"
    const state = createFallbackState("anthropic/claude-opus-4-6", [
      "openai/gpt-5.4",
    ])

    state.currentModel = "openai/gpt-5.4"
    deps.sessionStates.set(sessionID, state)

    const helpers = createAutoRetryHelpers(deps)
    const dispatched = await helpers.retryCurrentModelInFreshSession(
      sessionID,
      "Prometheus (Plan Builder)",
      "session.error",
    )

    expect(dispatched).toBe(true)
    expect(createCalls).toHaveLength(1)
    expect(promptCalls).toHaveLength(1)
    expect(
      (promptCalls[0] as { path?: { id?: string } }).path?.id,
    ).toBe("ses_scoped_child")
    expect(
      (promptCalls[0] as { body?: { agent?: string } }).body?.agent,
    ).toBe("Prometheus (Plan Builder)")
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
    expect(retryText).toContain("No reusable brief from parent session.")
  })

  it("uses canonical retry parts from state when transcript no longer has a reusable user brief", async () => {
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
    const sessionID = "ses_scoped_canonical_brief"
    const state = createFallbackState("anthropic/claude-opus-4-6", [
      "openai/gpt-5.3-codex-spark",
    ])
    state.canonicalRetryParts = [{ type: "text", text: "Fix the failing eurochemeopt CI plan end-to-end." }]

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
    const retryText = (
      promptCalls[0] as { body?: { parts?: Array<{ text?: string }> } }
    ).body?.parts?.[0]?.text
    expect(retryText).toContain("Fix the failing eurochemeopt CI plan end-to-end.")
    expect(retryText).not.toContain("No reusable brief from parent session.")
  })

  it("uses canonical retry parts when retry-brief transcript fetch times out", async () => {
    const createCalls: Array<unknown> = []
    const promptCalls: Array<unknown> = []
    const deps = createDeps({
      createCalls,
      promptCalls,
      messagesImpl: async () => await new Promise<never>(() => {}),
      sessionMessagesRequestTimeoutMs: 1,
    })
    const sessionID = "ses_scoped_canonical_brief_timeout"
    const state = createFallbackState("anthropic/claude-opus-4-6", [
      "openai/gpt-5.3-codex-spark",
    ])
    state.canonicalRetryParts = [{ type: "text", text: "Keep the original eurochemeopt planning brief intact." }]

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
    const retryText = (
      promptCalls[0] as { body?: { parts?: Array<{ text?: string }> } }
    ).body?.parts?.[0]?.text
    expect(retryText).toContain("Keep the original eurochemeopt planning brief intact.")
    expect(retryText).not.toContain("No reusable brief from parent session.")
  })

  it("creates a fresh same-model handoff for exhausted paid transient retries", async () => {
    const createCalls: Array<unknown> = []
    const promptCalls: Array<unknown> = []
    const deps = createDeps({ createCalls, promptCalls })
    const sessionID = "ses_paid_fresh_retry_handoff"
    const state = createFallbackState("openai/gpt-5.4", [
      "anthropic/claude-sonnet-4-6",
      "openai/gpt-5.3-codex-spark",
    ])

    deps.sessionStates.set(sessionID, state)

    const helpers = createAutoRetryHelpers(deps)
    const dispatched = await helpers.retryCurrentModelInFreshSession(
      sessionID,
      "Sisyphus Junior (Focused Executor)",
      "session.error.transient_forbidden",
    )

    expect(dispatched).toBe(true)
    expect(createCalls).toHaveLength(1)
    expect(promptCalls).toHaveLength(1)
    expect(
      (promptCalls[0] as { path?: { id?: string } }).path?.id,
    ).toBe("ses_scoped_child")
    expect(
      (promptCalls[0] as { body?: { model?: { providerID?: string; modelID?: string } } }).body?.model,
    ).toEqual({
      providerID: "openai",
      modelID: "gpt-5.4",
    })

    const retryText = (
      promptCalls[0] as { body?: { parts?: Array<{ text?: string }> } }
    ).body?.parts?.[0]?.text
    expect(retryText).toContain("Fresh paid retry")
    expect(retryText).toContain("Continue from parent context")
  })

  it("preserves the session.create binding when opening a fresh same-model handoff", async () => {
    const createCalls: Array<unknown> = []
    const promptCalls: Array<unknown> = []
    const deps = createDeps({
      createCalls,
      promptCalls,
      bindCreateToSessionObject: true,
    })
    const sessionID = "ses_paid_fresh_retry_bound_create"
    const state = createFallbackState("anthropic/claude-opus-4-6", [
      "openai/gpt-5.4",
      "anthropic/claude-sonnet-4-6",
    ])

    deps.sessionStates.set(sessionID, state)

    const helpers = createAutoRetryHelpers(deps)
    const dispatched = await helpers.retryCurrentModelInFreshSession(
      sessionID,
      "Prometheus (Plan Builder)",
      "message.part.updated.malformed-tool-pending",
    )

    expect(dispatched).toBe(true)
    expect(createCalls).toHaveLength(1)
    expect(promptCalls).toHaveLength(1)
    expect(
      (promptCalls[0] as { body?: { agent?: string } }).body?.agent,
    ).toBe("Prometheus (Plan Builder)")
    expect(wasRecentRuntimeFallbackContinuationDispatched(sessionID)).toBe(true)
  })

  it("marks fresh same-model retry children as bootstrap-pending scoped fallback sessions", async () => {
    const createCalls: Array<unknown> = []
    const promptCalls: Array<unknown> = []
    const deps = createDeps({ createCalls, promptCalls })
    const sessionID = "ses_paid_fresh_retry_bootstrap_hint"
    const state = createFallbackState("anthropic/claude-sonnet-4-6", [
      "openai/gpt-5.4",
    ])

    deps.sessionStates.set(sessionID, state)

    const helpers = createAutoRetryHelpers(deps)
    const dispatched = await helpers.retryCurrentModelInFreshSession(
      sessionID,
      "Sisyphus Junior (Focused Executor)",
      "session.error",
    )

    expect(dispatched).toBe(true)
    expect(deps.sessionScopedFallbackHints?.get("ses_scoped_child")).toEqual({
      isScopedFallbackChild: true,
      parentSessionID: sessionID,
      bootstrapPending: true,
    })
  })

  it("reattaches a scoped paid fresh retry handoff to the original parent session instead of nesting under the stalled child", async () => {
    const createCalls: Array<unknown> = []
    const promptCalls: Array<unknown> = []
    const sessionID = "ses_scoped_paid_fresh_retry_child"
    const rootSessionID = "ses_scoped_paid_fresh_retry_root"
    const deps = createDeps({
      createCalls,
      promptCalls,
      timeoutSeconds: 30,
      sessionData: {
        directory: "/tmp/runtime-fallback-scoped-handoff/project",
        parentID: rootSessionID,
      },
    })
    const state = createFallbackState("anthropic/claude-opus-4-6", [
      "openai/gpt-5.4",
      "anthropic/claude-sonnet-4-6",
    ])
    state.isScopedFallbackChild = true

    deps.sessionStates.set(sessionID, state)

    const helpers = createAutoRetryHelpers(deps)
    const dispatched = await helpers.retryCurrentModelInFreshSession(
      sessionID,
      "Prometheus (Plan Builder)",
      "session.error.transient_forbidden",
    )

    expect(dispatched).toBe(true)
    expect(createCalls).toHaveLength(1)
    expect(
      (createCalls[0] as { body?: { parentID?: string; title?: string } }).body,
    ).toMatchObject({
      parentID: rootSessionID,
      title: "[runtime-fallback] Scoped Fallback: claude-opus-4-6",
    })
    expect(promptCalls).toHaveLength(1)
    expect(
      (promptCalls[0] as { body?: { model?: { providerID?: string; modelID?: string } } }).body?.model,
    ).toEqual({
      providerID: "anthropic",
      modelID: "claude-opus-4-6",
    })
    expect(deps.sessionAwaitingFallbackResult.has(rootSessionID)).toBe(true)
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(false)
    expect(deps.sessionFallbackTimeouts.has(rootSessionID)).toBe(true)
    expect(wasRecentRuntimeFallbackContinuationDispatched(rootSessionID)).toBe(true)
  })

  it("uses the stored scoped parent hint when session.get no longer returns the original parent for a paid fresh retry", async () => {
    const createCalls: Array<unknown> = []
    const promptCalls: Array<unknown> = []
    const sessionID = "ses_scoped_paid_fresh_retry_child_missing_parent"
    const rootSessionID = "ses_scoped_paid_fresh_retry_root_missing_parent"
    const deps = createDeps({
      createCalls,
      promptCalls,
      sessionData: {
        directory: "/tmp/runtime-fallback-scoped-handoff/project",
      },
    })
    const state = createFallbackState("anthropic/claude-opus-4-6", [
      "openai/gpt-5.4",
      "anthropic/claude-sonnet-4-6",
    ])
    state.isScopedFallbackChild = true
    deps.sessionScopedFallbackHints?.set(sessionID, {
      isScopedFallbackChild: true,
      parentSessionID: rootSessionID,
    })

    deps.sessionStates.set(sessionID, state)

    const helpers = createAutoRetryHelpers(deps)
    const dispatched = await helpers.retryCurrentModelInFreshSession(
      sessionID,
      "Prometheus (Plan Builder)",
      "session.error.transient_forbidden",
    )

    expect(dispatched).toBe(true)
    expect(createCalls).toHaveLength(1)
    expect(
      (createCalls[0] as { body?: { parentID?: string; title?: string } }).body,
    ).toMatchObject({
      parentID: rootSessionID,
      title: "[runtime-fallback] Scoped Fallback: claude-opus-4-6",
    })
    expect(promptCalls).toHaveLength(1)
  })

  it("reuses the original parent transcript for a scoped paid fresh retry brief instead of the child handoff transcript", async () => {
    const createCalls: Array<unknown> = []
    const promptCalls: Array<unknown> = []
    const messageCalls: string[] = []
    const sessionID = "ses_scoped_paid_retry_child_brief"
    const rootSessionID = "ses_scoped_paid_retry_root_brief"
    const deps = createDeps({
      createCalls,
      promptCalls,
      messageCalls,
      messagesBySessionID: {
        [sessionID]: {
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
        [rootSessionID]: {
          data: [
            {
              info: { role: "user" },
              parts: [{ type: "text", text: "\"/start-work ci-green-final\"" }],
            },
          ],
        },
      },
      sessionData: {
        directory: "/tmp/runtime-fallback-scoped-handoff/project",
        parentID: rootSessionID,
      },
    })
    const state = createFallbackState("anthropic/claude-opus-4-6", [
      "openai/gpt-5.4",
      "anthropic/claude-sonnet-4-6",
    ])
    state.isScopedFallbackChild = true

    deps.sessionStates.set(sessionID, state)

    const helpers = createAutoRetryHelpers(deps)
    const dispatched = await helpers.retryCurrentModelInFreshSession(
      sessionID,
      "Prometheus (Plan Builder)",
      "session.error.transient_forbidden",
    )

    expect(dispatched).toBe(true)
    expect(messageCalls).toContain(rootSessionID)
    expect(messageCalls).not.toContain(sessionID)
    const retryText = (
      promptCalls[0] as { body?: { parts?: Array<{ text?: string }> } }
    ).body?.parts?.[0]?.text
    expect(retryText).toContain("\"/start-work ci-green-final\"")
    expect(retryText).not.toContain("No reusable brief from parent session.")
  })

  it("stops opening fresh same-model retries once the scoped paid retry window is exhausted", async () => {
    const createCalls: Array<unknown> = []
    const promptCalls: Array<unknown> = []
    const sessionID = "ses_scoped_paid_retry_child_exhausted"
    const rootSessionID = "ses_scoped_paid_retry_root_exhausted"
    const deps = createDeps({
      createCalls,
      promptCalls,
      sessionData: {
        directory: "/tmp/runtime-fallback-scoped-handoff/project",
        parentID: rootSessionID,
      },
    })
    const rootState = createFallbackState("anthropic/claude-opus-4-6", [
      "openai/gpt-5.4",
      "anthropic/claude-sonnet-4-6",
    ])
    rootState.freshSameModelRetryModelIdentity = "anthropic/claude-opus-4-6"
    rootState.freshSameModelRetryStartedAt = Date.now() - (5 * 60 * 1000) - 1
    rootState.freshSameModelRetryCount = 4
    deps.sessionStates.set(rootSessionID, rootState)

    const state = createFallbackState("anthropic/claude-opus-4-6", [
      "openai/gpt-5.4",
      "anthropic/claude-sonnet-4-6",
    ])
    state.isScopedFallbackChild = true
    deps.sessionStates.set(sessionID, state)

    const helpers = createAutoRetryHelpers(deps)
    const dispatched = await helpers.retryCurrentModelInFreshSession(
      sessionID,
      "Prometheus (Plan Builder)",
      "session.timeout",
    )

    expect(dispatched).toBe(false)
    expect(createCalls).toHaveLength(0)
    expect(promptCalls).toHaveLength(0)
  })

  it("preserves an explicit live planner agent on a boulder-tracked paid fallback instead of drifting to atlas", async () => {
    const createCalls: Array<unknown> = []
    const promptCalls: Array<unknown> = []
    const deps = createDeps({ createCalls, promptCalls })
    const sessionID = "ses_boulder_planner_same_session"
    const testDirectory = join(tmpdir(), `runtime-fallback-live-planner-${randomUUID()}`)

    mkdirSync(join(testDirectory, ".sisyphus"), { recursive: true })
    writeFileSync(
      join(testDirectory, ".sisyphus", "boulder.json"),
      JSON.stringify({
        active_plan: "/tmp/test-plan.md",
        started_at: new Date().toISOString(),
        session_ids: [sessionID],
        plan_name: "test-plan",
        agent: "atlas",
      }),
    )
    deps.ctx.directory = testDirectory

    const state = createFallbackState("anthropic/claude-opus-4-6", [
      "openai/gpt-5.4",
    ])
    deps.sessionStates.set(sessionID, state)

    try {
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
      expect(promptCalls).toHaveLength(1)
      expect(
        (promptCalls[0] as { body?: { agent?: string } }).body?.agent,
      ).toBe("Prometheus (Plan Builder)")
    } finally {
      rmSync(testDirectory, { recursive: true, force: true })
    }
  })

  it("preserves an explicit live planner agent on a boulder-tracked fresh paid handoff", async () => {
    const createCalls: Array<unknown> = []
    const promptCalls: Array<unknown> = []
    const deps = createDeps({ createCalls, promptCalls })
    const sessionID = "ses_boulder_planner_fresh_handoff"
    const testDirectory = join(tmpdir(), `runtime-fallback-live-planner-fresh-${randomUUID()}`)

    mkdirSync(join(testDirectory, ".sisyphus"), { recursive: true })
    writeFileSync(
      join(testDirectory, ".sisyphus", "boulder.json"),
      JSON.stringify({
        active_plan: "/tmp/test-plan.md",
        started_at: new Date().toISOString(),
        session_ids: [sessionID],
        plan_name: "test-plan",
        agent: "atlas",
      }),
    )
    deps.ctx.directory = testDirectory

    const state = createFallbackState("anthropic/claude-opus-4-6", [
      "openai/gpt-5.4",
    ])
    state.currentModel = "anthropic/claude-opus-4-6"
    deps.sessionStates.set(sessionID, state)

    try {
      const helpers = createAutoRetryHelpers(deps)
      const dispatched = await helpers.retryCurrentModelInFreshSession(
        sessionID,
        "Prometheus (Plan Builder)",
        "session.error.transient_forbidden",
      )

      expect(dispatched).toBe(true)
      expect(createCalls).toHaveLength(1)
      expect(promptCalls).toHaveLength(1)
      expect(
        (promptCalls[0] as { body?: { agent?: string } }).body?.agent,
      ).toBe("Prometheus (Plan Builder)")
    } finally {
      rmSync(testDirectory, { recursive: true, force: true })
    }
  })

  it("marks the parent session as recently recovered when opening a scoped fallback child", async () => {
    const createCalls: Array<unknown> = []
    const promptCalls: Array<unknown> = []
    const deps = createDeps({ createCalls, promptCalls })
    const sessionID = "ses_parent_recent_runtime_fallback_dispatch"
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
    expect(wasRecentRuntimeFallbackContinuationDispatched(sessionID)).toBe(true)
  })

  it("marks the scoped fallback child session as recently recovered when opening a scoped fallback child", async () => {
    const createCalls: Array<unknown> = []
    const promptCalls: Array<unknown> = []
    const deps = createDeps({ createCalls, promptCalls })
    const sessionID = "ses_child_recent_runtime_fallback_dispatch"
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
    expect(wasRecentRuntimeFallbackContinuationDispatched("ses_scoped_child")).toBe(true)
  })
})
