import { Database } from "bun:sqlite"
import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { HookDeps, RuntimeFallbackPluginInput } from "./types"
import type { AutoRetryHelpers } from "./auto-retry"
import { createFallbackState } from "./fallback-state"
import { createEventHandler } from "./event-handler"
import { resetRuntimeFallbackSessionIDCache } from "./session-id"
import * as dataPathModule from "../../shared/data-path"

type TestHelpers = AutoRetryHelpers & {
  __scheduleCallsForTest: Array<{ sessionID: string; source?: string; resolvedAgent?: string; timeoutMsOverride?: number }>
  __clearTransientCallsForTest: string[]
  __retryCurrentModelCallsForTest: Array<{
    sessionID: string
    resolvedAgent?: string
    source: string
    immediate?: boolean
    persistent?: boolean
  }>
  __freshRetryCallsForTest: Array<{
    sessionID: string
    resolvedAgent?: string
    source: string
  }>
}

function createContext(): RuntimeFallbackPluginInput {
  return {
    client: {
      session: {
        abort: async () => ({}),
        update: async () => ({}),
        messages: async () => ({ data: [] }),
        promptAsync: async () => ({}),
      },
      tui: {
        showToast: async () => ({}),
      },
    },
    directory: "/test/dir",
  }
}

function createDeps(): HookDeps {
  return {
    ctx: createContext(),
    config: {
      enabled: true,
      retry_on_errors: [429, 503, 529],
      max_fallback_attempts: 3,
      max_full_chain_cycles: 5,
      cooldown_seconds: 60,
      timeout_seconds: 30,
      transient_retry_window_seconds: 900,
      transient_retry_initial_delay_seconds: 10,
      transient_retry_max_delay_seconds: 300,
      notify_on_fallback: false,
    },
    options: undefined,
    pluginConfig: {},
    sessionStates: new Map(),
    sessionLastAccess: new Map(),
    sessionLastUserMessageIDs: new Map(),
    sessionRecentCompletionUntil: new Map(),
    sessionRecentActiveStatusUntil: new Map(),
    sessionSilentAssistantUpdateCounts: new Map(),
    sessionScopedFallbackHints: new Map(),
    sessionRetryInFlight: new Set(),
    sessionAwaitingFallbackResult: new Set(),
    sessionFallbackTimeouts: new Map(),
    sessionTransientRetryTimeouts: new Map(),
    sessionStatusRetryKeys: new Map(),
  }
}

function createHelpers(deps: HookDeps, abortCalls: string[], clearCalls: string[]): TestHelpers {
  const scheduleCalls: Array<{ sessionID: string; source?: string; resolvedAgent?: string; timeoutMsOverride?: number }> = []
  const clearTransientCalls: string[] = []
  const retryCurrentModelCalls: Array<{
    sessionID: string
    resolvedAgent?: string
    source: string
    immediate?: boolean
    persistent?: boolean
  }> = []
  const freshRetryCalls: Array<{
    sessionID: string
    resolvedAgent?: string
    source: string
  }> = []

  return {
    abortSessionRequest: async (sessionID: string) => {
      abortCalls.push(sessionID)
    },
    clearSessionTransientRetryTimeout: (sessionID: string) => {
      clearTransientCalls.push(sessionID)
      deps.sessionTransientRetryTimeouts.delete(sessionID)
    },
    clearSessionFallbackTimeout: (sessionID: string) => {
      clearCalls.push(sessionID)
      deps.sessionFallbackTimeouts.delete(sessionID)
      deps.sessionTransientRetryTimeouts.delete(sessionID)
    },
    scheduleSessionFallbackTimeout: (
      sessionID: string,
      options?: { source?: string; resolvedAgent?: string; timeoutMsOverride?: number },
    ) => {
      scheduleCalls.push({
        sessionID,
        source: options?.source,
        resolvedAgent: options?.resolvedAgent,
        ...(options?.timeoutMsOverride !== undefined ? { timeoutMsOverride: options.timeoutMsOverride } : {}),
      })
      deps.sessionFallbackTimeouts.set(sessionID, 1)
    },
    autoRetryWithFallback: async () => {},
    retryCurrentModel: async (sessionID, resolvedAgent, source, options) => {
      retryCurrentModelCalls.push({
        sessionID,
        resolvedAgent,
        source,
        immediate: options?.immediate,
        persistent: options?.persistent,
      })
      return false
    },
    retryCurrentModelInFreshSession: async (sessionID, resolvedAgent, source) => {
      freshRetryCalls.push({
        sessionID,
        resolvedAgent,
        source,
      })
      return true
    },
    resolveAgentForSessionFromContext: async () => undefined,
    cleanupStaleSessions: () => {},
    recoverPreferredModels: async () => {},
    __scheduleCallsForTest: scheduleCalls,
    __clearTransientCallsForTest: clearTransientCalls,
    __retryCurrentModelCallsForTest: retryCurrentModelCalls,
    __freshRetryCallsForTest: freshRetryCalls,
  }
}

let tempDbDir: string | undefined
let getDataDirSpy: ReturnType<typeof spyOn> | undefined

afterEach(() => {
  getDataDirSpy?.mockRestore()
  getDataDirSpy = undefined
  resetRuntimeFallbackSessionIDCache()

  if (tempDbDir) {
    rmSync(tempDbDir, { recursive: true, force: true })
    tempDbDir = undefined
  }
})

function withRuntimeFallbackDb(
  sessionID: string,
  ids: {
    messageID?: string
    partID?: string
  },
): void {
  tempDbDir = mkdtempSync(join(tmpdir(), "runtime-fallback-session-id-"))
  const opencodeDir = join(tempDbDir, "opencode")
  mkdirSync(opencodeDir, { recursive: true })
  const dbPath = join(opencodeDir, "opencode.db")
  const db = new Database(dbPath)

  db.run(`
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created TEXT NOT NULL DEFAULT (datetime('now')),
      time_updated TEXT NOT NULL DEFAULT (datetime('now')),
      data TEXT NOT NULL DEFAULT '{}'
    )
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      time_created TEXT NOT NULL DEFAULT (datetime('now')),
      time_updated TEXT NOT NULL DEFAULT (datetime('now')),
      data TEXT NOT NULL DEFAULT '{}'
    )
  `)

  if (ids.messageID) {
    db.run(
      "INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)",
      [ids.messageID, sessionID, "{}"],
    )
  }

  if (ids.partID) {
    const messageID = ids.messageID ?? "msg-runtime-fallback-session-id"
    if (!ids.messageID) {
      db.run(
        "INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)",
        [messageID, sessionID, "{}"],
      )
    }
    db.run(
      "INSERT INTO part (id, message_id, data) VALUES (?, ?, ?)",
      [ids.partID, messageID, "{}"],
    )
  }

  db.close()
  getDataDirSpy = spyOn(dataPathModule, "getDataDir").mockReturnValue(tempDbDir)
}

describe("createEventHandler", () => {
  it("#given a scoped fallback child session.created event #when the parent already has a canonical retry brief #then the child inherits that brief", async () => {
    const deps = createDeps()
    const parentSessionID = "session-parent-canonical-brief"
    const childSessionID = "session-child-canonical-brief"
    const parentState = createFallbackState("anthropic/claude-opus-4-6")
    parentState.canonicalRetryParts = [{ type: "text", text: "Preserve the original eurochemeopt CI request." }]
    deps.sessionStates.set(parentSessionID, parentState)

    const handler = createEventHandler(deps, createHelpers(deps, [], []))

    await handler({
      event: {
        type: "session.created",
        properties: {
          info: {
            id: childSessionID,
            parentID: parentSessionID,
            title: "[runtime-fallback] Scoped Fallback: claude-opus-4-6",
            providerID: "anthropic",
            modelID: "claude-opus-4-6",
          },
        },
      },
    })

    expect(deps.sessionStates.get(childSessionID)?.canonicalRetryParts).toEqual([
      { type: "text", text: "Preserve the original eurochemeopt CI request." },
    ])
  })

  it("#given a session retry dedupe key #when session.stop fires #then the retry dedupe key is cleared", async () => {
    // given
    const sessionID = "session-stop"
    const deps = createDeps()
    const abortCalls: string[] = []
    const clearCalls: string[] = []
    const state = createFallbackState("google/gemini-2.5-pro")
    state.pendingFallbackModel = "openai/gpt-5.4"
    deps.sessionStates.set(sessionID, state)
    deps.sessionRetryInFlight.add(sessionID)
    deps.sessionStatusRetryKeys.set(sessionID, "retry:1")
    const handler = createEventHandler(deps, createHelpers(deps, abortCalls, clearCalls))

    // when
    await handler({ event: { type: "session.stop", properties: { sessionID } } })

    // then
    expect(deps.sessionStatusRetryKeys.has(sessionID)).toBe(false)
    expect(clearCalls).toEqual([sessionID])
    expect(abortCalls).toEqual([sessionID])
  })

  it("#given a session retry dedupe key without a pending fallback result #when session.idle fires #then the retry dedupe key is cleared", async () => {
    // given
    const sessionID = "session-idle"
    const deps = createDeps()
    const abortCalls: string[] = []
    const clearCalls: string[] = []
    const state = createFallbackState("google/gemini-2.5-pro")
    state.pendingFallbackModel = "openai/gpt-5.4"
    deps.sessionStates.set(sessionID, state)
    deps.sessionRetryInFlight.add(sessionID)
    deps.sessionFallbackTimeouts.set(sessionID, 1)
    deps.sessionStatusRetryKeys.set(sessionID, "retry:1")
    const helpers = createHelpers(deps, abortCalls, clearCalls)
    const handler = createEventHandler(deps, helpers)

    // when
    await handler({ event: { type: "session.idle", properties: { sessionID } } })

    // then
    expect(deps.sessionStatusRetryKeys.has(sessionID)).toBe(false)
    expect(clearCalls).toEqual([sessionID])
    expect(abortCalls).toEqual([])
    expect(state.pendingFallbackModel).toBe(undefined)
    expect(helpers.__scheduleCallsForTest).toEqual([])
  })

  it("#given awaiting fallback without an armed timeout #when session.idle fires #then the timeout is re-armed instead of clearing the wait state", async () => {
    // given
    const sessionID = "session-idle-awaiting"
    const deps = createDeps()
    const abortCalls: string[] = []
    const clearCalls: string[] = []
    deps.sessionStates.set(sessionID, createFallbackState("google/gemini-2.5-pro"))
    deps.sessionAwaitingFallbackResult.add(sessionID)
    const helpers = createHelpers(deps, abortCalls, clearCalls)
    const handler = createEventHandler(deps, helpers)

    // when
    await handler({ event: { type: "session.idle", properties: { sessionID } } })

    // then
    expect(clearCalls).toEqual([])
    expect(abortCalls).toEqual([])
    expect(deps.sessionAwaitingFallbackResult.has(sessionID)).toBe(true)
    expect(helpers.__scheduleCallsForTest).toEqual([
      {
        sessionID,
        source: "session.idle.awaiting-fallback-rearm",
        resolvedAgent: undefined,
      },
    ])
  })

  it("#given a delayed transient retry is pending #when session.idle fires #then the retry state is preserved", async () => {
    // given
    const sessionID = "session-idle-transient-retry"
    const deps = createDeps()
    const abortCalls: string[] = []
    const clearCalls: string[] = []
    const state = createFallbackState("anthropic/claude-opus-4-6")
    state.pendingTransientRetry = true
    deps.sessionStates.set(sessionID, state)
    deps.sessionTransientRetryTimeouts.set(sessionID, 1)
    deps.sessionStatusRetryKeys.set(sessionID, "retry:1")
    const helpers = createHelpers(deps, abortCalls, clearCalls)
    const handler = createEventHandler(deps, helpers)

    // when
    await handler({ event: { type: "session.idle", properties: { sessionID } } })

    // then
    expect(clearCalls).toEqual([])
    expect(abortCalls).toEqual([])
    expect(state.pendingTransientRetry).toBe(true)
    expect(deps.sessionTransientRetryTimeouts.has(sessionID)).toBe(true)
    expect(deps.sessionStatusRetryKeys.get(sessionID)).toBe("retry:1")
  })

  it("#given a delayed transient retry but successful progress already happened #when session.idle fires #then stale retry state is cleared and completion proceeds", async () => {
    // given
    const sessionID = "session-idle-transient-retry-completed"
    const deps = createDeps()
    const abortCalls: string[] = []
    const clearCalls: string[] = []
    const state = createFallbackState("anthropic/claude-opus-4-6")
    state.pendingTransientRetry = true
    state.lastErrorAt = 100
    state.lastMeaningfulProgressAt = 200
    deps.sessionStates.set(sessionID, state)
    deps.sessionTransientRetryTimeouts.set(sessionID, 1)
    deps.sessionFallbackTimeouts.set(sessionID, 2)
    deps.sessionStatusRetryKeys.set(sessionID, "retry:1")
    const helpers = createHelpers(deps, abortCalls, clearCalls)
    const handler = createEventHandler(deps, helpers)

    // when
    await handler({ event: { type: "session.idle", properties: { sessionID } } })

    // then
    expect(helpers.__clearTransientCallsForTest).toEqual([sessionID])
    expect(clearCalls).toEqual([sessionID])
    expect(deps.sessionTransientRetryTimeouts.has(sessionID)).toBe(false)
    expect(state.pendingTransientRetry).toBe(false)
    expect(state.persistentTransientRetry).toBe(false)
    expect(abortCalls).toEqual([])
    expect(deps.sessionStatusRetryKeys.has(sessionID)).toBe(false)
  })

  describe("#given an armed active-session watchdog", () => {
    const progressCases: Array<{
      name: string
      properties: Record<string, unknown>
    }> = [
      {
        name: "tool parts",
        properties: {
          part: {
            sessionID: "session-progress-tool",
            type: "tool",
            tool: "data_catalog",
            state: { status: "running" },
          },
        },
      },
      {
        name: "pre-execution write tool parts",
        properties: {
          part: {
            sessionID: "session-progress-write-preexecution",
            type: "tool",
            tool: "write",
          },
        },
      },
      {
        name: "pending task delegation parts",
        properties: {
          part: {
            sessionID: "session-progress-task-pending",
            type: "tool",
            tool: "task",
            state: { status: "pending" },
          },
        },
      },
      {
        name: "pending omo delegation parts",
        properties: {
          part: {
            sessionID: "session-progress-call-omo-pending",
            type: "tool",
            tool: "call_omo_agent",
            state: { status: "pending" },
          },
        },
      },
      {
        name: "todowrite terminal parts",
        properties: {
          part: {
            sessionID: "session-progress-todowrite-terminal",
            type: "tool",
            tool: "todowrite",
            state: { status: "error" },
          },
        },
      },
      {
        name: "tool_use parts",
        properties: {
          part: {
            sessionID: "session-progress-tool-use",
            type: "tool_use",
          },
        },
      },
      {
        name: "tool_result parts",
        properties: {
          part: {
            sessionID: "session-progress-tool-result",
            type: "tool_result",
          },
        },
      },
      {
        name: "text deltas",
        properties: {
          sessionID: "session-progress-text",
          field: "text",
          delta: "next token",
          part: {
            sessionID: "session-progress-text",
            type: "text",
          },
        },
      },
      {
        name: "reasoning text parts",
        properties: {
          part: {
            sessionID: "session-progress-reasoning",
            type: "reasoning",
            text: "thinking...",
          },
        },
      },
      {
        name: "compaction parts",
        properties: {
          part: {
            sessionID: "session-progress-compaction",
            type: "compaction",
          },
        },
      },
    ]

    for (const progressCase of progressCases) {
      it(`#when ${progressCase.name} arrive #then the watchdog is refreshed instead of cleared`, async () => {
        const sessionID = String(
          ((progressCase.properties.part as Record<string, unknown> | undefined)?.sessionID)
          ?? progressCase.properties.sessionID,
        )
        const deps = createDeps()
        const abortCalls: string[] = []
        const clearCalls: string[] = []
        deps.sessionStates.set(sessionID, createFallbackState("anthropic/claude-opus-4-6"))
        deps.sessionFallbackTimeouts.set(sessionID, 1)
        const helpers = createHelpers(deps, abortCalls, clearCalls)
        const handler = createEventHandler(deps, helpers)

        await handler({
          event: {
            type: "message.part.updated",
            properties: progressCase.properties,
          },
        })

        expect(clearCalls).toEqual([])
        expect(abortCalls).toEqual([])
        expect(helpers.__scheduleCallsForTest).toEqual([
          {
            sessionID,
            source: "message.part.updated.progress",
            resolvedAgent: undefined,
            ...((() => {
              const part = progressCase.properties.part as Record<string, unknown> | undefined
              const type = part?.type
              const status = (part?.state as { status?: string } | undefined)?.status
              const toolName = typeof part?.tool === "string" ? part.tool : undefined
              const isLongRunning =
                type === "compaction"
                || type === "reasoning"
                || type === "tool_use"
                || type === "tool-call"
                || (
                  type === "tool" && (
                    status === "running"
                    || (
                      (status === undefined || status === "pending")
                      && ["write", "apply_patch", "todowrite"].includes(toolName ?? "")
                    )
                    || (
                      status === "pending"
                      && ["task", "call_omo_agent"].includes(toolName ?? "")
                    )
                    || (
                      (status === "completed" || status === "error")
                      && ["write", "apply_patch", "todowrite"].includes(toolName ?? "")
                    )
                  )
                )
              return isLongRunning
              ? { timeoutMsOverride: 120_000 }
              : {}
            })()),
          },
        ])
      })
    }

    it("#given a scoped fallback child progress event while the parent awaits fallback #when message.part.updated is handled #then the parent watchdog is refreshed too", async () => {
      const parentSessionID = "session-progress-parent-awaiting"
      const childSessionID = "session-progress-scoped-child"
      const deps = createDeps()
      const abortCalls: string[] = []
      const clearCalls: string[] = []
      deps.sessionStates.set(parentSessionID, createFallbackState("anthropic/claude-opus-4-6"))
      const childState = createFallbackState("openai/gpt-5.4")
      childState.isScopedFallbackChild = true
      childState.scopedFallbackParentSessionID = parentSessionID
      deps.sessionStates.set(childSessionID, childState)
      deps.sessionAwaitingFallbackResult.add(parentSessionID)
      deps.sessionRecentActiveStatusUntil.set(childSessionID, Date.now() + 1_000)
      deps.sessionFallbackTimeouts.set(parentSessionID, 1)
      const helpers = createHelpers(deps, abortCalls, clearCalls)
      const handler = createEventHandler(deps, helpers)

      await handler({
        event: {
          type: "message.part.updated",
          properties: {
            info: {
              sessionID: childSessionID,
              role: "assistant",
            },
            part: {
              sessionID: childSessionID,
              type: "text",
              text: "Analyzing Bamboo failures...",
            },
          },
        },
      })

      expect(clearCalls).toEqual([])
      expect(abortCalls).toEqual([])
      expect(helpers.__scheduleCallsForTest).toEqual([
        {
          sessionID: childSessionID,
          source: "message.part.updated.progress",
          resolvedAgent: undefined,
          timeoutMsOverride: 120_000,
        },
        {
          sessionID: parentSessionID,
          source: "message.part.updated.progress.awaiting-fallback-parent",
          resolvedAgent: undefined,
          timeoutMsOverride: 120_000,
        },
      ])
    })

    it("#when a local tool abort progress part arrives in a paid parent session #then the handler opens a fresh same-model handoff", async () => {
      const sessionID = "session-progress-local-tool-abort"
      const deps = createDeps()
      const abortCalls: string[] = []
      const clearCalls: string[] = []
      const state = createFallbackState("anthropic/claude-opus-4-6")
      state.resolvedAgent = "prometheus"
      deps.sessionStates.set(sessionID, state)
      const helpers = createHelpers(deps, abortCalls, clearCalls)
      const handler = createEventHandler(deps, helpers)

      await handler({
        event: {
          type: "message.part.updated",
          properties: {
            info: { sessionID, role: "assistant", agent: "Prometheus (Plan Builder)" },
            part: {
              sessionID,
              type: "tool",
              tool: "question",
              state: {
                status: "error",
                error: "Tool execution aborted",
              },
            },
          },
        },
      })

      expect(abortCalls).toEqual([])
      expect(clearCalls).toEqual([])
      expect(helpers.__scheduleCallsForTest).toEqual([
        {
          sessionID,
          source: "message.part.updated.progress",
          resolvedAgent: "prometheus",
        },
      ])
      expect(helpers.__retryCurrentModelCallsForTest).toEqual([])
      expect(helpers.__freshRetryCallsForTest).toEqual([
        {
          sessionID,
          resolvedAgent: "prometheus",
          source: "message.part.updated.tool-error",
        },
      ])
    })

    it("#when a local tool abort progress part arrives in a scoped paid child #then the handler opens a fresh same-model handoff", async () => {
      const sessionID = "session-progress-local-tool-abort-scoped-child"
      const deps = createDeps()
      const abortCalls: string[] = []
      const clearCalls: string[] = []
      const state = createFallbackState("anthropic/claude-opus-4-6")
      state.resolvedAgent = "prometheus"
      state.isScopedFallbackChild = true
      deps.sessionStates.set(sessionID, state)
      const helpers = createHelpers(deps, abortCalls, clearCalls)
      const handler = createEventHandler(deps, helpers)

      await handler({
        event: {
          type: "message.part.updated",
          properties: {
            info: { sessionID, role: "assistant", agent: "Prometheus (Plan Builder)" },
            part: {
              sessionID,
              type: "tool",
              tool: "write",
              state: {
                status: "error",
                error: "Tool execution aborted",
              },
            },
          },
        },
      })

      expect(helpers.__retryCurrentModelCallsForTest).toEqual([])
      expect(helpers.__freshRetryCallsForTest).toEqual([
        {
          sessionID,
          resolvedAgent: "prometheus",
          source: "message.part.updated.tool-error",
        },
      ])
    })

    it("#when a paid planner emits an empty pending write payload #then the handler opens a fresh same-model handoff", async () => {
      const sessionID = "session-progress-empty-write-pending"
      const deps = createDeps()
      const abortCalls: string[] = []
      const clearCalls: string[] = []
      const state = createFallbackState("anthropic/claude-opus-4-6")
      state.resolvedAgent = "prometheus"
      deps.sessionStates.set(sessionID, state)
      const helpers = createHelpers(deps, abortCalls, clearCalls)
      const handler = createEventHandler(deps, helpers)

      await handler({
        event: {
          type: "message.part.updated",
          properties: {
            info: { sessionID, role: "assistant", agent: "Prometheus (Plan Builder)" },
            part: {
              sessionID,
              type: "tool",
              tool: "write",
              state: {
                status: "pending",
                input: {},
                raw: "",
              },
            },
          },
        },
      })

      expect(abortCalls).toEqual([])
      expect(clearCalls).toEqual([])
      expect(helpers.__retryCurrentModelCallsForTest).toEqual([])
      expect(helpers.__freshRetryCallsForTest).toEqual([
        {
          sessionID,
          resolvedAgent: "prometheus",
          source: "message.part.updated.malformed-tool-pending",
        },
      ])
      expect(helpers.__scheduleCallsForTest).toEqual([
        {
          sessionID,
          source: "message.part.updated.progress",
          resolvedAgent: "prometheus",
          timeoutMsOverride: 120_000,
        },
      ])
    })

    it("#when a paid planner emits an empty pending write payload with camelCase part.sessionId #then the handler still opens a fresh same-model handoff", async () => {
      const sessionID = "session-progress-empty-write-pending-session-id"
      const deps = createDeps()
      const abortCalls: string[] = []
      const clearCalls: string[] = []
      const state = createFallbackState("anthropic/claude-opus-4-6")
      state.resolvedAgent = "prometheus"
      deps.sessionStates.set(sessionID, state)
      const helpers = createHelpers(deps, abortCalls, clearCalls)
      const handler = createEventHandler(deps, helpers)

      await handler({
        event: {
          type: "message.part.updated",
          properties: {
            info: { role: "assistant", agent: "Prometheus (Plan Builder)" },
            part: {
              sessionId: sessionID,
              type: "tool",
              tool: "write",
              state: {
                status: "pending",
                input: {},
                raw: "",
              },
            },
          },
        },
      })

      expect(abortCalls).toEqual([])
      expect(clearCalls).toEqual([])
      expect(helpers.__retryCurrentModelCallsForTest).toEqual([])
      expect(helpers.__freshRetryCallsForTest).toEqual([
        {
          sessionID,
          resolvedAgent: "prometheus",
          source: "message.part.updated.malformed-tool-pending",
        },
      ])
      expect(helpers.__scheduleCallsForTest).toEqual([
        {
          sessionID,
          source: "message.part.updated.progress",
          resolvedAgent: "prometheus",
          timeoutMsOverride: 120_000,
        },
      ])
    })

    it("#when a paid planner emits an empty pending read payload #then the handler keeps the watchdog alive without opening a fresh handoff", async () => {
      const sessionID = "session-progress-empty-read-pending"
      const deps = createDeps()
      const abortCalls: string[] = []
      const clearCalls: string[] = []
      const state = createFallbackState("anthropic/claude-opus-4-6")
      state.resolvedAgent = "prometheus"
      deps.sessionStates.set(sessionID, state)
      const helpers = createHelpers(deps, abortCalls, clearCalls)
      const handler = createEventHandler(deps, helpers)

      await handler({
        event: {
          type: "message.part.updated",
          properties: {
            info: { sessionID, role: "assistant", agent: "Prometheus (Plan Builder)" },
            part: {
              sessionID,
              type: "tool",
              tool: "read",
              state: {
                status: "pending",
                input: {},
                raw: "",
              },
            },
          },
        },
      })

      expect(abortCalls).toEqual([])
      expect(clearCalls).toEqual([])
      expect(helpers.__retryCurrentModelCallsForTest).toEqual([])
      expect(helpers.__freshRetryCallsForTest).toEqual([])
      expect(helpers.__scheduleCallsForTest).toEqual([
        {
          sessionID,
          source: "message.part.updated.progress",
          resolvedAgent: "prometheus",
        },
      ])
    })

    it("#when a final write error arrives without direct sessionID but with part and message ids #then the handler still opens a fresh same-model handoff", async () => {
      const sessionID = "session-progress-tool-error-db-session-id"
      const messageID = "msg-progress-tool-error-db-session-id"
      const partID = "prt-progress-tool-error-db-session-id"
      withRuntimeFallbackDb(sessionID, { messageID, partID })

      const deps = createDeps()
      const abortCalls: string[] = []
      const clearCalls: string[] = []
      const state = createFallbackState("anthropic/claude-opus-4-6")
      state.resolvedAgent = "prometheus"
      deps.sessionStates.set(sessionID, state)
      const helpers = createHelpers(deps, abortCalls, clearCalls)
      const handler = createEventHandler(deps, helpers)

      await handler({
        event: {
          type: "message.part.updated",
          properties: {
            info: {
              id: messageID,
              role: "assistant",
              agent: "Prometheus (Plan Builder)",
            },
            part: {
              id: partID,
              messageID,
              type: "tool",
              tool: "write",
              state: {
                status: "error",
                error: "Tool execution aborted",
              },
            },
          },
        },
      })

      expect(abortCalls).toEqual([])
      expect(clearCalls).toEqual([])
      expect(helpers.__retryCurrentModelCallsForTest).toEqual([])
      expect(helpers.__freshRetryCallsForTest).toEqual([
        {
          sessionID,
          resolvedAgent: "prometheus",
          source: "message.part.updated.tool-error",
        },
      ])
      expect(helpers.__scheduleCallsForTest).toEqual([
        {
          sessionID,
          source: "message.part.updated.progress",
          resolvedAgent: "prometheus",
          timeoutMsOverride: 120_000,
        },
      ])
    })

    it("#when a malformed pending write arrives without direct sessionID but with part and message ids #then the handler still opens a fresh same-model handoff", async () => {
      const sessionID = "session-progress-empty-write-pending-db-session-id"
      const messageID = "msg-progress-empty-write-pending-db-session-id"
      const partID = "prt-progress-empty-write-pending-db-session-id"
      withRuntimeFallbackDb(sessionID, { messageID, partID })

      const deps = createDeps()
      const abortCalls: string[] = []
      const clearCalls: string[] = []
      const state = createFallbackState("anthropic/claude-opus-4-6")
      state.resolvedAgent = "prometheus"
      deps.sessionStates.set(sessionID, state)
      const helpers = createHelpers(deps, abortCalls, clearCalls)
      const handler = createEventHandler(deps, helpers)

      await handler({
        event: {
          type: "message.part.updated",
          properties: {
            info: {
              id: messageID,
              role: "assistant",
              agent: "Prometheus (Plan Builder)",
            },
            part: {
              id: partID,
              messageID,
              type: "tool",
              tool: "write",
              state: {
                status: "pending",
                input: {},
                raw: "",
              },
            },
          },
        },
      })

      expect(abortCalls).toEqual([])
      expect(clearCalls).toEqual([])
      expect(helpers.__retryCurrentModelCallsForTest).toEqual([])
      expect(helpers.__freshRetryCallsForTest).toEqual([
        {
          sessionID,
          resolvedAgent: "prometheus",
          source: "message.part.updated.malformed-tool-pending",
        },
      ])
      expect(helpers.__scheduleCallsForTest).toEqual([
        {
          sessionID,
          source: "message.part.updated.progress",
          resolvedAgent: "prometheus",
          timeoutMsOverride: 120_000,
        },
      ])
    })

    it("#when visible assistant text arrives right after an active running pulse #then the handler preserves the long-running quiet window", async () => {
      const sessionID = "session-progress-visible-text-after-active-status"
      const deps = createDeps()
      const abortCalls: string[] = []
      const clearCalls: string[] = []
      deps.sessionRecentActiveStatusUntil?.set(sessionID, Date.now() + 5_000)
      deps.sessionStates.set(sessionID, createFallbackState("anthropic/claude-opus-4-6"))
      const helpers = createHelpers(deps, abortCalls, clearCalls)
      const handler = createEventHandler(deps, helpers)

      await handler({
        event: {
          type: "message.part.updated",
          properties: {
            field: "text",
            delta: "Пишу канонический план",
            info: { sessionID, role: "assistant", agent: "Prometheus (Plan Builder)" },
            part: {
              sessionID,
              type: "text",
              text: "Пишу канонический план",
            },
          },
        },
      })

      expect(clearCalls).toEqual([])
      expect(abortCalls).toEqual([])
      expect(helpers.__scheduleCallsForTest).toEqual([
        {
          sessionID,
          source: "message.part.updated.progress",
          resolvedAgent: undefined,
          timeoutMsOverride: 120_000,
        },
      ])
    })
  })

  it("#given a paid request-not-allowed 403 session.error #when the event handler processes it #then it opens a fresh paid handoff before any same-session retry", async () => {
    const sessionID = "session-error-transient-forbidden-fresh-handoff"
    const deps = createDeps()
    deps.pluginConfig = {
      agents: {
        "sisyphus-junior": {
          fallback_models: [
            "openai/gpt-5.4",
            "anthropic/claude-sonnet-4-6",
            "openai/gpt-5.3-codex-spark",
            "opencode/nemotron-3-super-free",
          ],
        },
      },
    }
    const abortCalls: string[] = []
    const clearCalls: string[] = []
    const state = createFallbackState("openai/gpt-5.4")
    state.resolvedAgent = "sisyphus-junior"
    deps.sessionStates.set(sessionID, state)
    const helpers = createHelpers(deps, abortCalls, clearCalls)
    const handler = createEventHandler(deps, helpers)

    await handler({
      event: {
        type: "session.error",
        properties: {
          sessionID,
          agent: "compaction",
          model: "openai/gpt-5.4",
          error: {
            statusCode: 403,
            message: "Request not allowed",
          },
        },
      },
    })

    expect(clearCalls).toEqual([sessionID])
    expect(abortCalls).toEqual([])
    expect(helpers.__retryCurrentModelCallsForTest).toEqual([])
    expect(helpers.__freshRetryCallsForTest).toEqual([
      {
        sessionID,
        resolvedAgent: "sisyphus-junior",
        source: "session.error",
      },
    ])
  })

  it("#given a paid request-not-allowed 403 session.error before the agent is resolved #when no fallback chain is available yet #then it still attempts same-model paid recovery", async () => {
    const sessionID = "session-error-transient-forbidden-without-agent"
    const deps = createDeps()
    const abortCalls: string[] = []
    const clearCalls: string[] = []
    const helpers = createHelpers(deps, abortCalls, clearCalls)
    const handler = createEventHandler(deps, helpers)

    await handler({
      event: {
        type: "session.error",
        properties: {
          sessionID,
          model: "anthropic/claude-opus-4-6",
          error: {
            name: "AI_APICallError",
            data: {
              statusCode: 403,
              message: "Forbidden: {\n  \"error\": {\n    \"type\": \"forbidden\",\n    \"message\": \"Request not allowed\"\n  }\n}",
            },
          },
        },
      },
    })

    expect(clearCalls).toEqual([sessionID])
    expect(abortCalls).toEqual([])
    expect(deps.sessionStates.get(sessionID)?.currentModel).toBe("anthropic/claude-opus-4-6")
    expect(helpers.__retryCurrentModelCallsForTest).toEqual([])
    expect(helpers.__freshRetryCallsForTest).toEqual([
      {
        sessionID,
        resolvedAgent: undefined,
        source: "session.error",
      },
    ])
  })

  it("#given a paid request-not-allowed 403 session.error with camelCase sessionId #when the event handler processes it #then it still opens a fresh paid handoff", async () => {
    const sessionID = "session-error-transient-forbidden-session-id"
    const deps = createDeps()
    deps.pluginConfig = {
      agents: {
        prometheus: {
          fallback_models: [
            "anthropic/claude-opus-4-6",
            "openai/gpt-5.4",
            "anthropic/claude-sonnet-4-6",
            "openai/gpt-5.3-codex-spark",
          ],
        },
      },
    }
    const abortCalls: string[] = []
    const clearCalls: string[] = []
    const state = createFallbackState("anthropic/claude-opus-4-6")
    state.resolvedAgent = "prometheus"
    deps.sessionStates.set(sessionID, state)
    const helpers = createHelpers(deps, abortCalls, clearCalls)
    const handler = createEventHandler(deps, helpers)

    await handler({
      event: {
        type: "session.error",
        properties: {
          sessionId: sessionID,
          error: {
            name: "AI_APICallError",
            data: {
              statusCode: 403,
              message: "Forbidden: {\n  \"error\": {\n    \"type\": \"forbidden\",\n    \"message\": \"Request not allowed\"\n  }\n}",
            },
          },
        },
      },
    })

    expect(clearCalls).toEqual([sessionID])
    expect(abortCalls).toEqual([])
    expect(helpers.__retryCurrentModelCallsForTest).toEqual([])
    expect(helpers.__freshRetryCallsForTest).toEqual([
      {
        sessionID,
        resolvedAgent: "prometheus",
        source: "session.error",
      },
    ])
  })

  it("#given a paid OpenAI gateway-blocked 403 session.error #when the event handler processes it #then it opens a fresh paid handoff on the same model", async () => {
    const sessionID = "session-error-openai-gateway-blocked"
    const deps = createDeps()
    deps.pluginConfig = {
      agents: {
        atlas: {
          fallback_models: [
            "openai/gpt-5.4",
            "anthropic/claude-sonnet-4-6",
            "openai/gpt-5.3-codex-spark",
            "opencode/nemotron-3-super-free",
          ],
        },
      },
    }
    const abortCalls: string[] = []
    const clearCalls: string[] = []
    const state = createFallbackState("openai/gpt-5.4")
    state.resolvedAgent = "atlas"
    deps.sessionStates.set(sessionID, state)
    const helpers = createHelpers(deps, abortCalls, clearCalls)
    const handler = createEventHandler(deps, helpers)

    await handler({
      event: {
        type: "session.error",
        properties: {
          sessionID,
          agent: "Atlas (Plan Executor)",
          model: "openai/gpt-5.4",
          error: {
            name: "AI_APICallError",
            data: {
              statusCode: 403,
              message: "Forbidden: request was blocked by a gateway or proxy.",
              responseBody: "<html><body><p>Unable to load site</p><span>Please try again later.</span></body></html>",
            },
          },
        },
      },
    })

    expect(clearCalls).toEqual([sessionID])
    expect(abortCalls).toEqual([])
    expect(helpers.__retryCurrentModelCallsForTest).toEqual([])
    expect(helpers.__freshRetryCallsForTest).toEqual([
      {
        sessionID,
        resolvedAgent: "atlas",
        source: "session.error",
      },
    ])
  })

  it("#given a scoped paid request-not-allowed 403 session.error #when the event handler processes it #then it still opens a fresh same-model handoff", async () => {
    const sessionID = "session-error-transient-forbidden-scoped-child"
    const deps = createDeps()
    deps.pluginConfig = {
      agents: {
        prometheus: {
          fallback_models: [
            "anthropic/claude-opus-4-6",
            "openai/gpt-5.4",
            "anthropic/claude-sonnet-4-6",
            "openai/gpt-5.3-codex-spark",
          ],
        },
      },
    }
    const abortCalls: string[] = []
    const clearCalls: string[] = []
    const state = createFallbackState("anthropic/claude-opus-4-6")
    state.resolvedAgent = "prometheus"
    state.isScopedFallbackChild = true
    deps.sessionStates.set(sessionID, state)
    const helpers = createHelpers(deps, abortCalls, clearCalls)
    const handler = createEventHandler(deps, helpers)

    await handler({
      event: {
        type: "session.error",
        properties: {
          sessionID,
          error: {
            name: "AI_APICallError",
            data: {
              statusCode: 403,
              message: "Forbidden: {\n  \"error\": {\n    \"type\": \"forbidden\",\n    \"message\": \"Request not allowed\"\n  }\n}",
            },
          },
        },
      },
    })

    expect(clearCalls).toEqual([sessionID])
    expect(abortCalls).toEqual([])
    expect(helpers.__retryCurrentModelCallsForTest).toEqual([])
    expect(helpers.__freshRetryCallsForTest).toEqual([
      {
        sessionID,
        resolvedAgent: "prometheus",
        source: "session.error",
      },
    ])
  })

  it("#given a paid request-not-allowed 403 before any meaningful progress #when fresh handoff is unavailable #then it retries the same paid model in-place immediately", async () => {
    const sessionID = "session-error-transient-forbidden-inline-prelude"
    const deps = createDeps()
    deps.pluginConfig = {
      agents: {
        atlas: {
          fallback_models: [
            "openai/gpt-5.4",
            "anthropic/claude-sonnet-4-6",
            "openai/gpt-5.3-codex-spark",
            "opencode/nemotron-3-super-free",
          ],
        },
      },
    }
    const abortCalls: string[] = []
    const clearCalls: string[] = []
    const updateCalls: Array<{ path?: { id: string }; body?: { title: string }; query?: { directory: string } }> = []
    deps.ctx.client.session.update = async (input) => {
      updateCalls.push(input)
      return {}
    }
    const state = createFallbackState("anthropic/claude-opus-4-6")
    state.resolvedAgent = "atlas"
    deps.sessionStates.set(sessionID, state)
    const helpers = createHelpers(deps, abortCalls, clearCalls)
    helpers.retryCurrentModelInFreshSession = async (retrySessionID, retryResolvedAgent, source) => {
      helpers.__freshRetryCallsForTest.push({
        sessionID: retrySessionID,
        resolvedAgent: retryResolvedAgent,
        source,
      })
      return false
    }
    helpers.retryCurrentModel = async (retrySessionID, retryResolvedAgent, source, options) => {
      helpers.__retryCurrentModelCallsForTest.push({
        sessionID: retrySessionID,
        resolvedAgent: retryResolvedAgent,
        source,
        immediate: options?.immediate,
        persistent: options?.persistent,
      })
      return true
    }
    const handler = createEventHandler(deps, helpers)

    await handler({
      event: {
        type: "session.error",
        properties: {
          sessionID,
          agent: "Atlas (Plan Executor)",
          model: "anthropic/claude-opus-4-6",
          error: {
            statusCode: 403,
            message: "Request not allowed",
          },
        },
      },
    })

    expect(clearCalls).toEqual([sessionID])
    expect(abortCalls).toEqual([])
    expect(updateCalls).toEqual([
      {
        path: { id: sessionID },
        body: { title: "Atlas (Plan Executor)" },
        query: { directory: "/test/dir" },
      },
    ])
    expect(helpers.__freshRetryCallsForTest).toEqual([
      {
        sessionID,
        resolvedAgent: "atlas",
        source: "session.error",
      },
    ])
    expect(helpers.__retryCurrentModelCallsForTest).toEqual([
      {
        sessionID,
        resolvedAgent: "atlas",
        source: "session.error.inline-preamble",
        immediate: true,
        persistent: false,
      },
    ])
  })

  it("#given a paid request-not-allowed 403 after meaningful progress #when fresh handoff is unavailable #then it still retries the same paid model in-place immediately", async () => {
    const sessionID = "session-error-transient-forbidden-inline-midflight"
    const deps = createDeps()
    deps.pluginConfig = {
      agents: {
        atlas: {
          fallback_models: [
            "anthropic/claude-opus-4-6",
            "openai/gpt-5.4",
            "anthropic/claude-sonnet-4-6",
            "openai/gpt-5.3-codex-spark",
            "opencode/nemotron-3-super-free",
          ],
        },
      },
    }
    const abortCalls: string[] = []
    const clearCalls: string[] = []
    const updateCalls: Array<{ path?: { id: string }; body?: { title: string }; query?: { directory: string } }> = []
    deps.ctx.client.session.update = async (input) => {
      updateCalls.push(input)
      return {}
    }
    const state = createFallbackState("anthropic/claude-opus-4-6")
    state.resolvedAgent = "atlas"
    state.lastMeaningfulProgressAt = Date.now()
    deps.sessionStates.set(sessionID, state)
    const helpers = createHelpers(deps, abortCalls, clearCalls)
    helpers.retryCurrentModelInFreshSession = async (retrySessionID, retryResolvedAgent, source) => {
      helpers.__freshRetryCallsForTest.push({
        sessionID: retrySessionID,
        resolvedAgent: retryResolvedAgent,
        source,
      })
      return false
    }
    helpers.retryCurrentModel = async (retrySessionID, retryResolvedAgent, source, options) => {
      helpers.__retryCurrentModelCallsForTest.push({
        sessionID: retrySessionID,
        resolvedAgent: retryResolvedAgent,
        source,
        immediate: options?.immediate,
        persistent: options?.persistent,
      })
      return true
    }
    const handler = createEventHandler(deps, helpers)

    await handler({
      event: {
        type: "session.error",
        properties: {
          sessionID,
          agent: "Atlas (Plan Executor)",
          model: "anthropic/claude-opus-4-6",
          error: {
            statusCode: 403,
            message: "Request not allowed",
          },
        },
      },
    })

    expect(clearCalls).toEqual([sessionID])
    expect(abortCalls).toEqual([])
    expect(updateCalls).toEqual([
      {
        path: { id: sessionID },
        body: { title: "Atlas (Plan Executor)" },
        query: { directory: "/test/dir" },
      },
    ])
    expect(helpers.__freshRetryCallsForTest).toEqual([
      {
        sessionID,
        resolvedAgent: "atlas",
        source: "session.error",
      },
    ])
    expect(helpers.__retryCurrentModelCallsForTest).toEqual([
      {
        sessionID,
        resolvedAgent: "atlas",
        source: "session.error.inline-preamble",
        immediate: true,
        persistent: false,
      },
    ])
  })

  it("#given a paid OpenAI gateway-blocked 403 before any meaningful progress #when fresh handoff is unavailable #then it retries the same paid model in-place immediately", async () => {
    const sessionID = "session-error-openai-gateway-blocked-inline-prelude"
    const deps = createDeps()
    deps.pluginConfig = {
      agents: {
        atlas: {
          fallback_models: [
            "openai/gpt-5.4",
            "anthropic/claude-sonnet-4-6",
            "openai/gpt-5.3-codex-spark",
            "opencode/nemotron-3-super-free",
          ],
        },
      },
    }
    const abortCalls: string[] = []
    const clearCalls: string[] = []
    const updateCalls: Array<{ path?: { id: string }; body?: { title: string }; query?: { directory: string } }> = []
    deps.ctx.client.session.update = async (input) => {
      updateCalls.push(input)
      return {}
    }
    const state = createFallbackState("openai/gpt-5.4")
    state.resolvedAgent = "atlas"
    deps.sessionStates.set(sessionID, state)
    const helpers = createHelpers(deps, abortCalls, clearCalls)
    helpers.retryCurrentModelInFreshSession = async (retrySessionID, retryResolvedAgent, source) => {
      helpers.__freshRetryCallsForTest.push({
        sessionID: retrySessionID,
        resolvedAgent: retryResolvedAgent,
        source,
      })
      return false
    }
    helpers.retryCurrentModel = async (retrySessionID, retryResolvedAgent, source, options) => {
      helpers.__retryCurrentModelCallsForTest.push({
        sessionID: retrySessionID,
        resolvedAgent: retryResolvedAgent,
        source,
        immediate: options?.immediate,
        persistent: options?.persistent,
      })
      return true
    }
    const handler = createEventHandler(deps, helpers)

    await handler({
      event: {
        type: "session.error",
        properties: {
          sessionID,
          agent: "Atlas (Plan Executor)",
          model: "openai/gpt-5.4",
          error: {
            name: "AI_APICallError",
            data: {
              statusCode: 403,
              message: "Forbidden: request was blocked by a gateway or proxy.",
              responseBody: "<html><body><p>Unable to load site</p><span>Please try again later.</span></body></html>",
            },
          },
        },
      },
    })

    expect(clearCalls).toEqual([sessionID])
    expect(abortCalls).toEqual([])
    expect(updateCalls).toEqual([
      {
        path: { id: sessionID },
        body: { title: "Atlas (Plan Executor)" },
        query: { directory: "/test/dir" },
      },
    ])
    expect(helpers.__freshRetryCallsForTest).toEqual([
      {
        sessionID,
        resolvedAgent: "atlas",
        source: "session.error",
      },
    ])
    expect(helpers.__retryCurrentModelCallsForTest).toEqual([
      {
        sessionID,
        resolvedAgent: "atlas",
        source: "session.error.inline-preamble",
        immediate: true,
        persistent: false,
      },
    ])
  })

  it("#given a paid OpenAI gateway-blocked 403 after meaningful progress #when fresh handoff is unavailable #then it still retries the same paid model in-place immediately", async () => {
    const sessionID = "session-error-openai-gateway-blocked-inline-midflight"
    const deps = createDeps()
    deps.pluginConfig = {
      agents: {
        atlas: {
          fallback_models: [
            "openai/gpt-5.4",
            "anthropic/claude-sonnet-4-6",
            "openai/gpt-5.3-codex-spark",
            "opencode/nemotron-3-super-free",
          ],
        },
      },
    }
    const abortCalls: string[] = []
    const clearCalls: string[] = []
    const updateCalls: Array<{ path?: { id: string }; body?: { title: string }; query?: { directory: string } }> = []
    deps.ctx.client.session.update = async (input) => {
      updateCalls.push(input)
      return {}
    }
    const state = createFallbackState("openai/gpt-5.4")
    state.resolvedAgent = "atlas"
    state.lastMeaningfulProgressAt = Date.now()
    deps.sessionStates.set(sessionID, state)
    const helpers = createHelpers(deps, abortCalls, clearCalls)
    helpers.retryCurrentModelInFreshSession = async (retrySessionID, retryResolvedAgent, source) => {
      helpers.__freshRetryCallsForTest.push({
        sessionID: retrySessionID,
        resolvedAgent: retryResolvedAgent,
        source,
      })
      return false
    }
    helpers.retryCurrentModel = async (retrySessionID, retryResolvedAgent, source, options) => {
      helpers.__retryCurrentModelCallsForTest.push({
        sessionID: retrySessionID,
        resolvedAgent: retryResolvedAgent,
        source,
        immediate: options?.immediate,
        persistent: options?.persistent,
      })
      return true
    }
    const handler = createEventHandler(deps, helpers)

    await handler({
      event: {
        type: "session.error",
        properties: {
          sessionID,
          agent: "Atlas (Plan Executor)",
          model: "openai/gpt-5.4",
          error: {
            name: "AI_APICallError",
            data: {
              statusCode: 403,
              message: "Forbidden: request was blocked by a gateway or proxy.",
              responseBody: "<html><body><p>Unable to load site</p><span>Please try again later.</span></body></html>",
            },
          },
        },
      },
    })

    expect(clearCalls).toEqual([sessionID])
    expect(abortCalls).toEqual([])
    expect(updateCalls).toEqual([
      {
        path: { id: sessionID },
        body: { title: "Atlas (Plan Executor)" },
        query: { directory: "/test/dir" },
      },
    ])
    expect(helpers.__freshRetryCallsForTest).toEqual([
      {
        sessionID,
        resolvedAgent: "atlas",
        source: "session.error",
      },
    ])
    expect(helpers.__retryCurrentModelCallsForTest).toEqual([
      {
        sessionID,
        resolvedAgent: "atlas",
        source: "session.error.inline-preamble",
        immediate: true,
        persistent: false,
      },
    ])
  })

  it("#given a tracked paid 403 before any meaningful progress #when the event model belongs to internal title generation #then runtime-fallback retries the resolved agent model in-place and primes the root session title", async () => {
    const sessionID = "session-error-title-prelude-openai-403"
    const deps = createDeps()
    deps.pluginConfig = {
      agents: {
        prometheus: {
          model: "anthropic/claude-opus-4-6",
          fallback_models: [
            "anthropic/claude-opus-4-6",
            "openai/gpt-5.4",
            "anthropic/claude-sonnet-4-6",
            "openai/gpt-5.3-codex-spark",
          ],
        },
      },
    }
    const abortCalls: string[] = []
    const clearCalls: string[] = []
    const updateCalls: Array<{ path?: { id: string }; body?: { title: string }; query?: { directory: string } }> = []
    deps.ctx.client.session.update = async (input) => {
      updateCalls.push(input)
      return {}
    }
    const helpers = createHelpers(deps, abortCalls, clearCalls)
    helpers.resolveAgentForSessionFromContext = async () => "prometheus"
    helpers.retryCurrentModel = async (retrySessionID, retryResolvedAgent, source, options) => {
      helpers.__retryCurrentModelCallsForTest.push({
        sessionID: retrySessionID,
        resolvedAgent: retryResolvedAgent,
        source,
        immediate: options?.immediate,
        persistent: options?.persistent,
      })
      return true
    }
    const handler = createEventHandler(deps, helpers)

    await handler({
      event: {
        type: "session.error",
        properties: {
          sessionID,
          model: "openai/gpt-5.4",
          error: {
            name: "AI_APICallError",
            data: {
              statusCode: 403,
              message: "Forbidden: request was blocked by a gateway or proxy.",
              responseBody: "<html><body><p>Unable to load site</p></body></html>",
            },
          },
        },
      },
    })

    expect(clearCalls).toEqual([sessionID])
    expect(abortCalls).toEqual([])
    expect(updateCalls).toEqual([
      {
        path: { id: sessionID },
        body: { title: "Prometheus (Plan Builder)" },
        query: { directory: "/test/dir" },
      },
    ])
    expect(deps.sessionStates.get(sessionID)?.currentModel).toBe("anthropic/claude-opus-4-6")
    expect(helpers.__retryCurrentModelCallsForTest).toEqual([
      {
        sessionID,
        resolvedAgent: "prometheus",
        source: "session.error.prelude",
        immediate: true,
        persistent: false,
      },
    ])
    expect(helpers.__freshRetryCallsForTest).toEqual([])
  })

  for (const currentModel of ["anthropic/claude-opus-4-6", "openai/gpt-5.4"]) {
    it(`#given ${currentModel} recently observed a local tool abort #when session.error reports a MessageAbortedError wrapper #then runtime-fallback retries the same paid model in a fresh session instead of same-session fallback`, async () => {
      const sessionID = `session-error-wrapped-tool-abort-${currentModel.replaceAll(/[^a-z0-9]+/gi, "-")}`
      const deps = createDeps()
      deps.pluginConfig = {
        agents: {
          prometheus: {
            fallback_models: [
              "anthropic/claude-opus-4-6",
              "openai/gpt-5.4",
              "anthropic/claude-sonnet-4-6",
              "openai/gpt-5.3-codex-spark",
              "opencode/nemotron-3-super-free",
            ],
          },
        },
      }
      const abortCalls: string[] = []
      const clearCalls: string[] = []
      const state = createFallbackState(currentModel)
      state.resolvedAgent = "prometheus"
      state.lastLocalToolAbortAt = Date.now()
      deps.sessionStates.set(sessionID, state)
      const helpers = createHelpers(deps, abortCalls, clearCalls)
      const handler = createEventHandler(deps, helpers)

      await handler({
        event: {
          type: "session.error",
          properties: {
            sessionID,
            agent: "Prometheus (Plan Builder)",
            model: currentModel,
            error: {
              name: "MessageAbortedError",
              message: "Aborted process",
            },
          },
        },
      })

      expect(clearCalls).toEqual([sessionID])
      expect(abortCalls).toEqual([])
      expect(helpers.__retryCurrentModelCallsForTest).toEqual([
        {
          sessionID,
          resolvedAgent: "prometheus",
          source: "session.error",
          immediate: false,
          persistent: true,
        },
      ])
      expect(helpers.__freshRetryCallsForTest).toEqual([
        {
          sessionID,
          resolvedAgent: "prometheus",
          source: "session.error",
        },
      ])
    })
  }
})
