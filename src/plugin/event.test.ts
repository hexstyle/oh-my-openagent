import { Database } from "bun:sqlite"
import { describe, it, expect, afterEach, spyOn, jest } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createEventHandler } from "./event"
import { createChatMessageHandler } from "./chat-message"
import { _resetForTesting, setMainSession } from "../features/claude-code-session-state"
import { clearPendingModelFallback, createModelFallbackHook } from "../hooks/model-fallback/hook"
import { resetRuntimeFallbackSessionIDCache } from "../hooks/runtime-fallback/session-id"
import { getSessionPromptParams, setSessionPromptParams } from "../shared/session-prompt-params-state"
import { markRecentRuntimeFallbackContinuationDispatch, resetRecentRuntimeFallbackContinuationDispatchesForTests } from "../shared/recent-runtime-fallback-continuation"
import * as loggerModule from "../shared/logger"
import * as dataPathModule from "../shared/data-path"

type EventInput = { event: { type: string; properties?: unknown } }

let tempDbDir: string | undefined
let getDataDirSpy: ReturnType<typeof spyOn> | undefined

afterEach(() => {
	_resetForTesting()
	jest.useRealTimers()
	resetRuntimeFallbackSessionIDCache()
	resetRecentRuntimeFallbackContinuationDispatchesForTests()
	getDataDirSpy?.mockRestore()
	getDataDirSpy = undefined
	if (tempDbDir) {
		rmSync(tempDbDir, { recursive: true, force: true })
		tempDbDir = undefined
	}
})

function withEventSessionDb(
	sessionID: string,
	ids: {
		messageID?: string
		partID?: string
	},
): void {
	tempDbDir = join(
		tmpdir(),
		`plugin-event-session-id-${Date.now()}-${Math.random().toString(16).slice(2)}`,
	)
	mkdirSync(join(tempDbDir, "opencode"), { recursive: true })
	const db = new Database(join(tempDbDir, "opencode", "opencode.db"))
	db.exec(`
		CREATE TABLE IF NOT EXISTS message (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			time_created TEXT NOT NULL DEFAULT (datetime('now')),
			time_updated TEXT NOT NULL DEFAULT (datetime('now')),
			data TEXT NOT NULL DEFAULT '{}'
		);
		CREATE TABLE IF NOT EXISTS part (
			id TEXT PRIMARY KEY,
			message_id TEXT NOT NULL,
			time_created TEXT NOT NULL DEFAULT (datetime('now')),
			time_updated TEXT NOT NULL DEFAULT (datetime('now')),
			data TEXT NOT NULL DEFAULT '{}'
		);
	`)

	if (ids.messageID) {
		db.run(
			"INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)",
			[ids.messageID, sessionID, "{}"],
		)
	}

	if (ids.partID) {
		const messageID = ids.messageID ?? "msg-plugin-event-session-id"
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

	describe("createEventHandler - idle deduplication", () => {
	it("Order A (status→idle): synthetic idle deduped - real idle not dispatched again", async () => {
		//#given
		const dispatchCalls: EventInput[] = []
		const mockDispatchToHooks = async (input: EventInput) => {
			if (input.event.type === "session.idle") {
				dispatchCalls.push(input)
			}
		}

		const eventHandler = createEventHandler({
			ctx: {} as any,
			pluginConfig: {} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				autoUpdateChecker: { event: mockDispatchToHooks as any },
				claudeCodeHooks: { event: async () => {} },
				backgroundNotificationHook: { event: async () => {} },
				sessionNotification: async () => {},
				todoContinuationEnforcer: { handler: async () => {} },
				unstableAgentBabysitter: { event: async () => {} },
				contextWindowMonitor: { event: async () => {} },
				directoryAgentsInjector: { event: async () => {} },
				directoryReadmeInjector: { event: async () => {} },
				rulesInjector: { event: async () => {} },
				thinkMode: { event: async () => {} },
				anthropicContextWindowLimitRecovery: { event: async () => {} },
				agentUsageReminder: { event: async () => {} },
				categorySkillReminder: { event: async () => {} },
				interactiveBashSession: { event: async () => {} },
				ralphLoop: { event: async () => {} },
				stopContinuationGuard: { event: async () => {} },
				compactionTodoPreserver: { event: async () => {} },
				atlasHook: { handler: async () => {} },
			} as any,
		})

		const sessionId = "ses_test123"

		//#when - session.status with idle (generates synthetic idle first)
		await eventHandler({
			event: {
				type: "session.status",
				properties: {
					sessionID: sessionId,
					status: { type: "idle" },
				},
			},
		})

		//#then - synthetic idle dispatched once
		expect(dispatchCalls.length).toBe(1)
		expect(dispatchCalls[0].event.type).toBe("session.idle")
		expect((dispatchCalls[0].event.properties as { sessionID?: string } | undefined)?.sessionID).toBe(sessionId)

		//#when - real session.idle arrives
		await eventHandler({
			event: {
				type: "session.idle",
				properties: {
					sessionID: sessionId,
				},
			},
		})

		//#then - real idle deduped, no additional dispatch
		expect(dispatchCalls.length).toBe(1)
	})

	it("Order B (idle→status): real idle deduped - synthetic idle not dispatched", async () => {
		//#given
		const dispatchCalls: EventInput[] = []
		const mockDispatchToHooks = async (input: EventInput) => {
			if (input.event.type === "session.idle") {
				dispatchCalls.push(input)
			}
		}

		const eventHandler = createEventHandler({
			ctx: {} as any,
			pluginConfig: {} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				autoUpdateChecker: { event: mockDispatchToHooks as any },
				claudeCodeHooks: { event: async () => {} },
				backgroundNotificationHook: { event: async () => {} },
				sessionNotification: async () => {},
				todoContinuationEnforcer: { handler: async () => {} },
				unstableAgentBabysitter: { event: async () => {} },
				contextWindowMonitor: { event: async () => {} },
				directoryAgentsInjector: { event: async () => {} },
				directoryReadmeInjector: { event: async () => {} },
				rulesInjector: { event: async () => {} },
				thinkMode: { event: async () => {} },
				anthropicContextWindowLimitRecovery: { event: async () => {} },
				agentUsageReminder: { event: async () => {} },
				categorySkillReminder: { event: async () => {} },
				interactiveBashSession: { event: async () => {} },
				ralphLoop: { event: async () => {} },
				stopContinuationGuard: { event: async () => {} },
				compactionTodoPreserver: { event: async () => {} },
				atlasHook: { handler: async () => {} },
			} as any,
		})

		const sessionId = "ses_test456"

		//#when - real session.idle arrives first
		await eventHandler({
			event: {
				type: "session.idle",
				properties: {
					sessionID: sessionId,
				},
			},
		})

		//#then - real idle dispatched once
		expect(dispatchCalls.length).toBe(1)
		expect(dispatchCalls[0].event.type).toBe("session.idle")
		expect((dispatchCalls[0].event.properties as { sessionID?: string } | undefined)?.sessionID).toBe(sessionId)

		//#when - session.status with idle (generates synthetic idle)
		await eventHandler({
			event: {
				type: "session.status",
				properties: {
					sessionID: sessionId,
					status: { type: "idle" },
				},
			},
		})

		//#then - synthetic idle deduped, no additional dispatch
		expect(dispatchCalls.length).toBe(1)
	})

	it("both maps pruned on every event", async () => {
		//#given
		const eventHandler = createEventHandler({
			ctx: {} as any,
			pluginConfig: {} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				autoUpdateChecker: { event: async () => {} },
				claudeCodeHooks: { event: async () => {} },
				backgroundNotificationHook: { event: async () => {} },
				sessionNotification: async () => {},
				todoContinuationEnforcer: { handler: async () => {} },
				unstableAgentBabysitter: { event: async () => {} },
				contextWindowMonitor: { event: async () => {} },
				directoryAgentsInjector: { event: async () => {} },
				directoryReadmeInjector: { event: async () => {} },
				rulesInjector: { event: async () => {} },
				thinkMode: { event: async () => {} },
				anthropicContextWindowLimitRecovery: { event: async () => {} },
				agentUsageReminder: { event: async () => {} },
				categorySkillReminder: { event: async () => {} },
				interactiveBashSession: { event: async () => {} },
				ralphLoop: { event: async () => {} },
				stopContinuationGuard: { event: async () => {} },
				compactionTodoPreserver: { event: async () => {} },
				atlasHook: { handler: async () => {} },
			} as any,
		})

		// Trigger some synthetic idles
		await eventHandler({
			event: {
				type: "session.status",
				properties: {
					sessionID: "ses_stale_1",
					status: { type: "idle" },
				},
			},
		})

		await eventHandler({
			event: {
				type: "session.status",
				properties: {
					sessionID: "ses_stale_2",
					status: { type: "idle" },
				},
			},
		})

		// Trigger some real idles
		await eventHandler({
			event: {
				type: "session.idle",
				properties: {
					sessionID: "ses_stale_3",
				},
			},
		})

		await eventHandler({
			event: {
				type: "session.idle",
				properties: {
					sessionID: "ses_stale_4",
				},
			},
		})

		//#when - wait for dedup window to expire (600ms > 500ms)
		await new Promise((resolve) => setTimeout(resolve, 600))

		// Trigger any event to trigger pruning
		await eventHandler({
			event: {
				type: "message.updated",
			},
		} as any)

		//#then - both maps should be pruned (no dedup should occur for new events)
		// We verify by checking that a new idle event for same session is dispatched
		const dispatchCalls: EventInput[] = []
		const eventHandlerWithMock = createEventHandler({
			ctx: {} as any,
			pluginConfig: {} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				autoUpdateChecker: {
					event: async (input: EventInput) => {
						dispatchCalls.push(input)
					},
				},
				claudeCodeHooks: { event: async () => {} },
				backgroundNotificationHook: { event: async () => {} },
				sessionNotification: async () => {},
				todoContinuationEnforcer: { handler: async () => {} },
				unstableAgentBabysitter: { event: async () => {} },
				contextWindowMonitor: { event: async () => {} },
				directoryAgentsInjector: { event: async () => {} },
				directoryReadmeInjector: { event: async () => {} },
				rulesInjector: { event: async () => {} },
				thinkMode: { event: async () => {} },
				anthropicContextWindowLimitRecovery: { event: async () => {} },
				agentUsageReminder: { event: async () => {} },
				categorySkillReminder: { event: async () => {} },
				interactiveBashSession: { event: async () => {} },
				ralphLoop: { event: async () => {} },
				stopContinuationGuard: { event: async () => {} },
				compactionTodoPreserver: { event: async () => {} },
				atlasHook: { handler: async () => {} },
			} as any,
		})

		await eventHandlerWithMock({
			event: {
				type: "session.idle",
				properties: {
					sessionID: "ses_stale_1",
				},
			},
		})

		expect(dispatchCalls.length).toBe(1)
		expect(dispatchCalls[0].event.type).toBe("session.idle")
	})

	it("dedup only applies within window - outside window both dispatch", async () => {
		//#given
		const dispatchCalls: EventInput[] = []
		const eventHandler = createEventHandler({
			ctx: {} as any,
			pluginConfig: {} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				autoUpdateChecker: {
					event: async (input: EventInput) => {
						if (input.event.type === "session.idle") {
							dispatchCalls.push(input)
						}
					},
				},
				claudeCodeHooks: { event: async () => {} },
				backgroundNotificationHook: { event: async () => {} },
				sessionNotification: async () => {},
				todoContinuationEnforcer: { handler: async () => {} },
				unstableAgentBabysitter: { event: async () => {} },
				contextWindowMonitor: { event: async () => {} },
				directoryAgentsInjector: { event: async () => {} },
				directoryReadmeInjector: { event: async () => {} },
				rulesInjector: { event: async () => {} },
				thinkMode: { event: async () => {} },
				anthropicContextWindowLimitRecovery: { event: async () => {} },
				agentUsageReminder: { event: async () => {} },
				categorySkillReminder: { event: async () => {} },
				interactiveBashSession: { event: async () => {} },
				ralphLoop: { event: async () => {} },
				stopContinuationGuard: { event: async () => {} },
				compactionTodoPreserver: { event: async () => {} },
				atlasHook: { handler: async () => {} },
			} as any,
		})

		const sessionId = "ses_outside_window"

		//#when - synthetic idle first
		await eventHandler({
			event: {
				type: "session.status",
				properties: {
					sessionID: sessionId,
					status: { type: "idle" },
				},
			},
		})

		//#then - synthetic dispatched
		expect(dispatchCalls.length).toBe(1)

		//#when - wait for dedup window to expire (600ms > 500ms)
		await new Promise((resolve) => setTimeout(resolve, 600))

		//#when - real idle arrives outside window
		await eventHandler({
			event: {
				type: "session.idle",
				properties: {
					sessionID: sessionId,
				},
			},
		})

		//#then - real idle dispatched (outside dedup window)
		expect(dispatchCalls.length).toBe(2)
		expect(dispatchCalls[0].event.type).toBe("session.idle")
		expect(dispatchCalls[1].event.type).toBe("session.idle")
	})
})

describe("createEventHandler - event forwarding", () => {
	it("logs readable hook failure details instead of an empty error object", async () => {
		const logCalls: Array<{ message: string; data?: unknown }> = []
		const logSpy = spyOn(loggerModule, "log").mockImplementation((message: string, data?: unknown) => {
			logCalls.push({ message, data })
		})

		const eventHandler = createEventHandler({
			ctx: {} as never,
			pluginConfig: {} as never,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as never,
			hooks: {
				autoUpdateChecker: {
					event: async () => {
						throw new Error("hook boom")
					},
				},
				claudeCodeHooks: { event: async () => {} },
				backgroundNotificationHook: { event: async () => {} },
				sessionNotification: async () => {},
				todoContinuationEnforcer: { handler: async () => {} },
				unstableAgentBabysitter: { event: async () => {} },
				contextWindowMonitor: { event: async () => {} },
				directoryAgentsInjector: { event: async () => {} },
				directoryReadmeInjector: { event: async () => {} },
				rulesInjector: { event: async () => {} },
				thinkMode: { event: async () => {} },
				anthropicContextWindowLimitRecovery: { event: async () => {} },
				agentUsageReminder: { event: async () => {} },
				categorySkillReminder: { event: async () => {} },
				interactiveBashSession: { event: async () => {} },
				ralphLoop: { event: async () => {} },
				stopContinuationGuard: { event: async () => {} },
				compactionTodoPreserver: { event: async () => {} },
				atlasHook: { handler: async () => {} },
			} as never,
		})

		await eventHandler({
			event: {
				type: "session.idle",
				properties: { sessionID: "ses_hook_failure" },
			},
		})

		expect(logCalls).toContainEqual({
			message: "[event] hook execution failed",
			data: {
				hook: "autoUpdateChecker",
				eventType: "session.idle",
				sessionID: "ses_hook_failure",
				errorName: "Error",
				errorMessage: "hook boom",
			},
		})

		logSpy.mockRestore()
	})

	it("forwards session.deleted to write-existing-file-guard hook", async () => {
		//#given
		const forwardedEvents: EventInput[] = []
		const disconnectedSessions: string[] = []
		const deletedSessions: string[] = []
		const eventHandler = createEventHandler({
			ctx: {} as never,
			pluginConfig: {} as never,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				skillMcpManager: {
					disconnectSession: async (sessionID: string) => {
						disconnectedSessions.push(sessionID)
					},
				},
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async ({ sessionID }: { sessionID: string }) => {
						deletedSessions.push(sessionID)
					},
				},
			} as never,
			hooks: {
				writeExistingFileGuard: {
					event: async (input: EventInput) => {
						forwardedEvents.push(input)
					},
				},
			} as never,
		})
		const sessionID = "ses_forward_delete_event"

		//#when
		await eventHandler({
			event: {
				type: "session.deleted",
				properties: { info: { id: sessionID } },
			},
		} as any)

		//#then
		expect(forwardedEvents.length).toBe(1)
		expect(forwardedEvents[0]?.event.type).toBe("session.deleted")
		expect(disconnectedSessions).toEqual([sessionID])
		expect(deletedSessions).toEqual([sessionID])
	})

	it("clears stored prompt params on session.deleted", async () => {
		//#given
		const eventHandler = createEventHandler({
			ctx: {} as never,
			pluginConfig: {} as never,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				skillMcpManager: {
					disconnectSession: async () => {},
				},
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as never,
			hooks: {} as never,
		})
		const sessionID = "ses_prompt_params_deleted"
		setSessionPromptParams(sessionID, {
			temperature: 0.4,
			topP: 0.7,
			options: { reasoningEffort: "high" },
		})

		//#when
		await eventHandler({
			event: {
				type: "session.deleted",
				properties: { info: { id: sessionID } },
			},
		})

		//#then
		expect(getSessionPromptParams(sessionID)).toBeUndefined()
	})
})

describe("createEventHandler - retry dedupe lifecycle", () => {
	it("re-handles same retry key after session recovers to idle status", async () => {
		//#given
		const sessionID = "ses_retry_recovery_rearm"
		setMainSession(sessionID)
		clearPendingModelFallback(sessionID)

		const abortCalls: string[] = []
		const promptCalls: string[] = []
		const modelFallback = createModelFallbackHook()

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						abort: async ({ path }: { path: { id: string } }) => {
							abortCalls.push(path.id)
							return {}
						},
						prompt: async ({ path }: { path: { id: string } }) => {
							promptCalls.push(path.id)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
				skillMcpManager: {
					disconnectSession: async () => {},
				},
			} as any,
			hooks: {
				modelFallback,
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		const chatMessageHandler = createChatMessageHandler({
			ctx: {
				client: {
					tui: {
						showToast: async () => ({}),
					},
				},
			} as any,
			pluginConfig: {} as any,
			firstMessageVariantGate: {
				shouldOverride: () => false,
				markApplied: () => {},
			},
			hooks: {
				modelFallback,
				stopContinuationGuard: null,
				keywordDetector: null,
				claudeCodeHooks: null,
				autoSlashCommand: null,
				startWork: null,
				ralphLoop: null,
			} as any,
		})

		const retryStatus = {
			type: "retry",
			attempt: 1,
			message: "All credentials for model claude-opus-4-6-thinking are cooling down [retrying in 7m 56s attempt #1]",
			next: 476,
		} as const

		await eventHandler({
			event: {
				type: "message.updated",
				properties: {
					info: {
						id: "msg_user_retry_rearm",
						sessionID,
						role: "user",
						modelID: "claude-opus-4-6-thinking",
						providerID: "anthropic",
						agent: "Sisyphus (Ultraworker)",
					},
				},
			},
		} as any)

		//#when - first retry key is handled
		await eventHandler({
			event: {
				type: "session.status",
				properties: {
					sessionID,
					status: retryStatus,
				},
			},
		} as any)

		const firstOutput = { message: {}, parts: [] as Array<{ type: string; text?: string }> }
		await chatMessageHandler(
			{
				sessionID,
				agent: "sisyphus",
				model: { providerID: "anthropic", modelID: "claude-opus-4-6-thinking" },
			},
			firstOutput,
		)

		//#when - session recovers to non-retry idle state
		await eventHandler({
			event: {
				type: "session.status",
				properties: {
					sessionID,
					status: { type: "idle" },
				},
			},
		} as any)

		//#when - same retry key appears again after recovery
		await eventHandler({
			event: {
				type: "session.status",
				properties: {
					sessionID,
					status: retryStatus,
				},
			},
		} as any)

		//#then
		expect(abortCalls).toEqual([sessionID, sessionID])
		expect(promptCalls).toEqual([sessionID, sessionID])
	})
})

describe("createEventHandler - session recovery compaction", () => {
	it("triggers compaction before sending continue after session error recovery", async () => {
		//#given
		const sessionID = "ses_recovery_compaction"
		setMainSession(sessionID)
		const callOrder: string[] = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						abort: async () => ({}),
						summarize: async () => {
							callOrder.push("summarize")
							return {}
						},
						prompt: async () => {
							callOrder.push("prompt")
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				sessionRecovery: {
					isRecoverableError: () => true,
					handleSessionRecovery: async () => true,
				},
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "session.error",
				properties: {
					sessionID,
					messageID: "msg_123",
					error: { name: "Error", message: "tool_result block(s) that are not immediately" },
				},
			},
		} as any)

		//#then - summarize (compaction) must be called before prompt (continue)
		expect(callOrder).toEqual(["summarize", "prompt"])
	})

	it("sends continue even if compaction fails", async () => {
		//#given
		const sessionID = "ses_recovery_compaction_fail"
		setMainSession(sessionID)
		const callOrder: string[] = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						abort: async () => ({}),
						summarize: async () => {
							callOrder.push("summarize")
							throw new Error("compaction failed")
						},
						prompt: async () => {
							callOrder.push("prompt")
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				sessionRecovery: {
					isRecoverableError: () => true,
					handleSessionRecovery: async () => true,
				},
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "session.error",
				properties: {
					sessionID,
					messageID: "msg_456",
					error: { name: "Error", message: "tool_result block(s) that are not immediately" },
				},
			},
		} as any)

		//#then - continue is still sent even when compaction fails
		expect(callOrder).toEqual(["summarize", "prompt"])
	})

	it("still runs session recovery before runtime-fallback short-circuit for recoverable tool transcript errors", async () => {
		//#given
		const sessionID = "ses_recovery_before_runtime_fallback"
		setMainSession(sessionID)
		const callOrder: string[] = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						abort: async () => ({}),
						summarize: async () => {
							callOrder.push("summarize")
							return {}
						},
						prompt: async () => {
							callOrder.push("prompt")
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: {
					auto_resume: true,
				},
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				sessionRecovery: {
					isRecoverableError: () => true,
					handleSessionRecovery: async () => true,
				},
				runtimeFallback: { event: async () => {} },
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "session.error",
				properties: {
					sessionID,
					messageID: "msg_runtime_fallback_bypass",
					error: {
						name: "Error",
						message: "messages.2: `tool_use` ids were found without `tool_result` blocks immediately after",
					},
				},
			},
		} as any)

		//#then
		expect(callOrder).toEqual(["summarize", "prompt"])
	})

	it("continues dispatching later event hooks when an earlier hook throws", async () => {
		//#given
		const runtimeFallbackCalls: EventInput[] = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						abort: async () => ({}),
						prompt: async () => ({}),
					},
				},
			} as any,
			pluginConfig: {} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				autoUpdateChecker: {
					event: async () => {
						throw new Error("upstream hook failed")
					},
				},
				runtimeFallback: {
					event: async (input: EventInput) => {
						runtimeFallbackCalls.push(input)
					},
				},
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		let thrownError: unknown
		try {
			await eventHandler({
				event: {
					type: "session.error",
					properties: {
						sessionID: "ses_hook_isolation",
						error: { name: "Error", message: "retry me" },
					},
				},
			} as any)
		} catch (error) {
			thrownError = error
		}

		//#then
		expect(thrownError).toBeUndefined()
		expect(runtimeFallbackCalls).toHaveLength(1)
		expect(runtimeFallbackCalls[0]?.event.type).toBe("session.error")
	})
})

describe("createEventHandler - pending empty planning tool recovery", () => {
	it("recovers a delayed Prometheus write call emitted without required arguments", async () => {
		//#given
		jest.useFakeTimers()
		const sessionID = "ses_empty_write_delayed"
		const abortCalls: string[] = []
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									info: {
										id: "msg_user",
										role: "user",
										agent: "Prometheus (Plan Builder)",
										model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
										tools: { write: true, read: true },
									},
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									info: {
										id: "msg_assistant",
										role: "assistant",
										agent: "Prometheus (Plan Builder)",
									},
									parts: [
										{ type: "step-start" },
										{
											type: "tool",
											tool: "write",
											raw: "",
											state: { status: "pending", input: {} },
										},
									],
								},
							],
						}),
						abort: async ({ path }: { path: { id: string } }) => {
							abortCalls.push(path.id)
							return {}
						},
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "message.updated",
				properties: {
					info: {
						id: "msg_assistant",
						sessionID,
						role: "assistant",
						agent: "Prometheus (Plan Builder)",
					},
				},
			},
		} as any)
		const jestTimers = jest as unknown as { advanceTimersByTimeAsync?: (ms: number) => Promise<void> }
		if (typeof jestTimers.advanceTimersByTimeAsync === "function") {
			await jestTimers.advanceTimersByTimeAsync(5_000)
		} else {
			jest.advanceTimersByTime(5_000)
		}
		for (let index = 0; index < 10; index += 1) {
			await Promise.resolve()
		}

		//#then
		expect(abortCalls).toEqual([sessionID])
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("previous planning tool call was emitted without the required arguments")
		expect(promptBody?.parts?.[0]?.text).toContain("already exists but still begins with `# Draft:`")
		expect(promptBody?.parts?.[0]?.text).toContain("promote the repaired draft with")
		expect(promptBody?.parts?.[0]?.text).toContain("cp .sisyphus/drafts/{name}.md .sisyphus/plans/{name}.md")
	})

	it("does not run plugin-side pending-tool recovery after an aborted planner turn when runtime fallback is enabled", async () => {
		//#given
		jest.useFakeTimers()
		const sessionID = "ses_empty_write_delayed_cleared_on_error"
		let messagesCallCount = 0
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => {
							messagesCallCount += 1
							return {
								data: [
									{
										info: {
											id: "msg_user_delayed_cleared_on_error",
											role: "user",
											agent: "Prometheus (Plan Builder)",
											model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
										},
										parts: [{ type: "text", text: "Generate the final plan" }],
									},
									{
										info: {
											id: "msg_assistant_delayed_cleared_on_error",
											role: "assistant",
											agent: "Prometheus (Plan Builder)",
											error: {
												name: "MessageAbortedError",
												data: { message: "Aborted" },
											},
										},
										parts: [
											{ type: "step-start" },
											{
												type: "tool",
												tool: "write",
												raw: "",
												state: {
													status: "error",
													input: {},
													error: "Tool execution aborted",
													metadata: { interrupted: true },
												},
											},
										],
									},
								],
							}
						},
						abort: async () => ({}),
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
				runtime_fallback: { enabled: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
				runtimeFallback: { event: async () => {} },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "message.updated",
				properties: {
					info: {
						id: "msg_assistant_delayed_cleared_on_error",
						sessionID,
						role: "assistant",
						agent: "Prometheus (Plan Builder)",
					},
				},
			},
		} as any)
		await eventHandler({
			event: {
				type: "message.part.updated",
				properties: {
					part: {
						id: "part_empty_tool_delayed_cleared_on_error",
						sessionID,
						messageID: "msg_assistant_delayed_cleared_on_error",
						type: "tool",
						tool: "write",
						raw: "",
						state: { status: "pending", input: {} },
					},
				},
			},
		} as any)
		await eventHandler({
			event: {
				type: "message.updated",
				properties: {
					info: {
						id: "msg_assistant_delayed_cleared_on_error",
						sessionID,
						role: "assistant",
						agent: "Prometheus (Plan Builder)",
						error: {
							name: "MessageAbortedError",
							data: { message: "Aborted" },
						},
					},
				},
			},
		} as any)
		const jestTimers = jest as unknown as { advanceTimersByTimeAsync?: (ms: number) => Promise<void> }
		if (typeof jestTimers.advanceTimersByTimeAsync === "function") {
			await jestTimers.advanceTimersByTimeAsync(5_000)
		} else {
			jest.advanceTimersByTime(5_000)
		}
		for (let index = 0; index < 10; index += 1) {
			await Promise.resolve()
		}

		//#then
		expect(messagesCallCount).toBe(0)
		expect(promptAsyncCalls).toHaveLength(0)
	})

	it("does not run delayed pending-tool recovery when runtime fallback is enabled", async () => {
		//#given
		jest.useFakeTimers()
		const sessionID = "ses_empty_write_delayed_runtime_fallback"
		const abortCalls: string[] = []
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									info: {
										id: "msg_user_delayed_runtime_fallback",
										role: "user",
										agent: "Prometheus (Plan Builder)",
										model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
									},
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									info: {
										id: "msg_assistant_delayed_runtime_fallback",
										role: "assistant",
										agent: "Prometheus (Plan Builder)",
									},
									parts: [
										{ type: "step-start" },
										{
											type: "tool",
											tool: "write",
											raw: "",
											state: { status: "pending", input: {} },
										},
									],
								},
							],
						}),
						abort: async ({ path }: { path: { id: string } }) => {
							abortCalls.push(path.id)
							return {}
						},
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
				runtime_fallback: { enabled: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
				runtimeFallback: { event: async () => {} },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "message.updated",
				properties: {
					info: {
						id: "msg_assistant_delayed_runtime_fallback",
						sessionID,
						role: "assistant",
						agent: "Prometheus (Plan Builder)",
					},
				},
			},
		} as any)
		await eventHandler({
			event: {
				type: "message.part.updated",
				properties: {
					part: {
						id: "part_empty_tool_delayed_runtime_fallback",
						sessionID,
						messageID: "msg_assistant_delayed_runtime_fallback",
						type: "tool",
						tool: "write",
						raw: "",
						state: { status: "pending", input: {} },
					},
				},
			},
		} as any)

		const jestTimers = jest as unknown as { advanceTimersByTimeAsync?: (ms: number) => Promise<void> }
		if (typeof jestTimers.advanceTimersByTimeAsync === "function") {
			await jestTimers.advanceTimersByTimeAsync(5_000)
		} else {
			jest.advanceTimersByTime(5_000)
		}
		for (let index = 0; index < 10; index += 1) {
			await Promise.resolve()
		}

		//#then
		expect(abortCalls).toHaveLength(0)
		expect(promptAsyncCalls).toHaveLength(0)
	})

	it("falls back to a simple delayed recovery prompt when scoped empty-tool resume fails", async () => {
		//#given
		jest.useFakeTimers()
		const sessionID = "ses_empty_write_delayed_simple_fallback"
		const abortCalls: string[] = []
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									info: {
										id: "msg_user_delayed_simple_fallback",
										role: "user",
										agent: "Prometheus (Plan Builder)",
										model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
									},
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									info: {
										id: "msg_assistant_delayed_simple_fallback",
										role: "assistant",
										agent: "Prometheus (Plan Builder)",
									},
									parts: [
										{ type: "text", text: "Writing the final plan now." },
										{
											type: "tool",
											tool: "write",
											raw: "",
											state: { status: "pending", input: {} },
										},
									],
								},
							],
						}),
						abort: async ({ path }: { path: { id: string } }) => {
							abortCalls.push(path.id)
							return {}
						},
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							const body = input.body as { agent?: string } | undefined
							if (body?.agent) {
								throw new Error("invalid scoped resume payload")
							}
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "message.updated",
				properties: {
					info: {
						id: "msg_assistant_delayed_simple_fallback",
						sessionID,
						role: "assistant",
						agent: "Prometheus (Plan Builder)",
					},
				},
			},
		} as any)
		const jestTimers = jest as unknown as { advanceTimersByTimeAsync?: (ms: number) => Promise<void> }
		if (typeof jestTimers.advanceTimersByTimeAsync === "function") {
			await jestTimers.advanceTimersByTimeAsync(5_000)
		} else {
			jest.advanceTimersByTime(5_000)
		}
		for (let index = 0; index < 10; index += 1) {
			await Promise.resolve()
		}

		//#then
		expect(abortCalls).toEqual([sessionID])
		expect(promptAsyncCalls).toHaveLength(2)
		expect((promptAsyncCalls[0]?.body as { agent?: string } | undefined)?.agent).toBe("Prometheus (Plan Builder)")
		expect((promptAsyncCalls[1]?.body as { agent?: string } | undefined)?.agent).toBeUndefined()
		const promptBody = promptAsyncCalls[1]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("previous planning tool call was emitted without the required arguments")
	})

	it("recovers a delayed Prometheus write call even when reasoning text arrived before the empty tool call", async () => {
		//#given
		jest.useFakeTimers()
		const sessionID = "ses_empty_write_after_reasoning"
		const abortCalls: string[] = []
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => {
							throw new Error("messages unavailable while streaming")
						},
						abort: async ({ path }: { path: { id: string } }) => {
							abortCalls.push(path.id)
							return {}
						},
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "message.updated",
				properties: {
					info: {
						id: "msg_assistant_after_reasoning",
						sessionID,
						role: "assistant",
						agent: "Prometheus (Plan Builder)",
					},
				},
			},
		} as any)
		await eventHandler({
			event: {
				type: "message.part.updated",
				properties: {
					part: {
						id: "part_reasoning_before_empty_tool",
						sessionID,
						messageID: "msg_assistant_after_reasoning",
						type: "reasoning",
						text: "Now I need to write the final plan artifact.",
					},
				},
			},
		} as any)
		await eventHandler({
			event: {
				type: "message.part.updated",
				properties: {
					part: {
						id: "part_empty_tool_after_reasoning",
						sessionID,
						messageID: "msg_assistant_after_reasoning",
						type: "tool",
						tool: "write",
						raw: "",
						state: { status: "pending", input: {} },
					},
				},
			},
		} as any)
		const jestTimers = jest as unknown as { advanceTimersByTimeAsync?: (ms: number) => Promise<void> }
		if (typeof jestTimers.advanceTimersByTimeAsync === "function") {
			await jestTimers.advanceTimersByTimeAsync(5_000)
		} else {
			jest.advanceTimersByTime(5_000)
		}
		for (let index = 0; index < 10; index += 1) {
			await Promise.resolve()
		}

		//#then
		expect(abortCalls).toEqual([sessionID])
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("previous planning tool call was emitted without the required arguments")
	})

	it("recovers a delayed Prometheus write call even when visible text arrived before the empty tool call", async () => {
		//#given
		jest.useFakeTimers()
		const sessionID = "ses_empty_write_after_text"
		const abortCalls: string[] = []
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => {
							throw new Error("messages unavailable while streaming")
						},
						abort: async ({ path }: { path: { id: string } }) => {
							abortCalls.push(path.id)
							return {}
						},
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "message.updated",
				properties: {
					info: {
						id: "msg_assistant_after_text",
						sessionID,
						role: "assistant",
						agent: "Prometheus (Plan Builder)",
					},
				},
			},
		} as any)
		await eventHandler({
			event: {
				type: "message.part.updated",
				properties: {
					part: {
						id: "part_text_before_empty_tool",
						sessionID,
						messageID: "msg_assistant_after_text",
						type: "text",
						text: "Now I'll compose the full synthesized plan and write it to the draft first.",
					},
				},
			},
		} as any)
		await eventHandler({
			event: {
				type: "message.part.updated",
				properties: {
					part: {
						id: "part_empty_tool_after_text",
						sessionID,
						messageID: "msg_assistant_after_text",
						type: "tool",
						tool: "write",
						raw: "",
						state: { status: "pending", input: {} },
					},
				},
			},
		} as any)
		const jestTimers = jest as unknown as { advanceTimersByTimeAsync?: (ms: number) => Promise<void> }
		if (typeof jestTimers.advanceTimersByTimeAsync === "function") {
			await jestTimers.advanceTimersByTimeAsync(5_000)
		} else {
			jest.advanceTimersByTime(5_000)
		}
		for (let index = 0; index < 10; index += 1) {
			await Promise.resolve()
		}

		//#then
		expect(abortCalls).toEqual([sessionID])
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("previous planning tool call was emitted without the required arguments")
	})

	it("recovers a pending empty Prometheus write call on idle without waiting for the delayed timer", async () => {
		//#given
		const sessionID = "ses_empty_write_idle"
		const abortCalls: string[] = []
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									info: {
										id: "msg_user_idle",
										role: "user",
										agent: "Prometheus (Plan Builder)",
										model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
									},
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									info: {
										id: "msg_assistant_idle",
										role: "assistant",
										agent: "Prometheus (Plan Builder)",
									},
									parts: [
										{ type: "step-start" },
										{
											type: "tool",
											tool: "write",
											raw: "",
											state: { status: "pending", input: {} },
										},
									],
								},
							],
						}),
						abort: async ({ path }: { path: { id: string } }) => {
							abortCalls.push(path.id)
							return {}
						},
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "session.status",
				properties: {
					sessionID,
					status: { type: "idle" },
				},
			},
		} as any)

		//#then
		expect(abortCalls).toEqual([sessionID])
		expect(promptAsyncCalls).toHaveLength(1)
	})

	it("recovers an interrupted empty Prometheus write call on idle after the tool abort wrapper lands", async () => {
		//#given
		const sessionID = "ses_empty_write_interrupted_idle"
		const abortCalls: string[] = []
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									info: {
										id: "msg_user_interrupted_idle",
										role: "user",
										agent: "Prometheus (Plan Builder)",
										model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
									},
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									info: {
										id: "msg_assistant_interrupted_idle",
										role: "assistant",
										agent: "Prometheus (Plan Builder)",
									},
									parts: [
										{ type: "reasoning", text: "Now I need to write the final plan." },
										{
											type: "tool",
											tool: "write",
											raw: "",
											state: {
												status: "error",
												input: {},
												error: "Tool execution aborted",
												metadata: { interrupted: true },
											},
										},
									],
								},
							],
						}),
						abort: async ({ path }: { path: { id: string } }) => {
							abortCalls.push(path.id)
							return {}
						},
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "session.status",
				properties: {
					sessionID,
					status: { type: "idle" },
				},
			},
		} as any)

		//#then
		expect(abortCalls).toEqual([sessionID])
		expect(promptAsyncCalls).toHaveLength(1)
	})

	it("recovers a same-message aborted Prometheus write wrapper on idle after the transcript persists", async () => {
		//#given
		const sessionID = "ses_same_message_aborted_write_wrapper_idle"
		const abortCalls: string[] = []
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									id: "msg_user_same_message_wrapper_idle",
									role: "user",
									agent: "Prometheus (Plan Builder)",
									providerID: "anthropic",
									modelID: "claude-opus-4-6",
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									id: "msg_assistant_same_message_wrapper_idle",
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									error: {
										name: "MessageAbortedError",
										data: { message: "Aborted" },
									},
									parts: [
										{ type: "reasoning", text: "Now I'll write the complete final plan." },
										{ type: "text", text: "Now I'll write the complete final plan. Given the size, I'll write it to the draft first, then promote via copy." },
										{
											type: "tool",
											tool: "write",
											raw: "",
											state: {
												status: "error",
												input: {},
												error: "Tool execution aborted",
												metadata: { interrupted: true },
											},
										},
									],
								},
							],
						}),
						abort: async ({ path }: { path: { id: string } }) => {
							abortCalls.push(path.id)
							return {}
						},
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "session.status",
				properties: {
					sessionID,
					status: { type: "idle" },
				},
			},
		} as any)

		//#then
		expect(abortCalls).toEqual([])
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("previous planning tool call was emitted without the required arguments")
	})

	it("recovers a Prometheus empty write after a separate MessageAbortedError wrapper message arrives", async () => {
		//#given
		const sessionID = "ses_empty_write_wrapper_message"
		const abortCalls: string[] = []
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									info: {
										id: "msg_user_wrapper",
										role: "user",
										agent: "Prometheus (Plan Builder)",
										model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
									},
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									info: {
										id: "msg_assistant_broken_tool",
										role: "assistant",
										agent: "Prometheus (Plan Builder)",
										finish: "tool-calls",
									},
									parts: [
										{ type: "text", text: "Proceeding to write the plan now." },
										{
											type: "tool",
											tool: "write",
											raw: "",
											state: {
												status: "error",
												input: {},
												error: "Tool execution aborted",
												metadata: { interrupted: true },
											},
										},
									],
								},
								{
									info: {
										id: "msg_assistant_wrapper_error",
										role: "assistant",
										agent: "Prometheus (Plan Builder)",
										error: {
											name: "MessageAbortedError",
											data: { message: "Aborted" },
										},
									},
									parts: [],
								},
							],
						}),
						abort: async ({ path }: { path: { id: string } }) => {
							abortCalls.push(path.id)
							return {}
						},
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "message.updated",
				properties: {
					info: {
						id: "msg_assistant_wrapper_error",
						sessionID,
						role: "assistant",
						agent: "Prometheus (Plan Builder)",
						error: {
							name: "MessageAbortedError",
							data: { message: "Aborted" },
						},
					},
				},
			},
		} as any)

		//#then
		expect(abortCalls).toEqual([])
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("previous planning tool call was emitted without the required arguments")
	})

	it("falls back to a simple recovery prompt for a same-message aborted Prometheus write wrapper", async () => {
		//#given
		const sessionID = "ses_same_message_aborted_write_wrapper"
		const abortCalls: string[] = []
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									id: "msg_user_same_message_wrapper",
									role: "user",
									agent: "Prometheus (Plan Builder)",
									providerID: "anthropic",
									modelID: "claude-opus-4-6",
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									id: "msg_assistant_same_message_wrapper",
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									error: {
										name: "MessageAbortedError",
										data: { message: "Aborted" },
									},
									parts: [
										{ type: "step-start" },
										{ type: "text", text: "Writing the final plan now." },
										{
											type: "tool",
											tool: "write",
											raw: "",
											state: {
												status: "error",
												input: {},
												error: "Tool execution aborted",
												metadata: { interrupted: true },
											},
										},
									],
								},
							],
						}),
						abort: async ({ path }: { path: { id: string } }) => {
							abortCalls.push(path.id)
							return {}
						},
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							const body = input.body as { agent?: string } | undefined
							if (body?.agent) {
								throw new Error("invalid scoped resume payload")
							}
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "message.updated",
				properties: {
					info: {
						id: "msg_assistant_same_message_wrapper",
						sessionID,
						role: "assistant",
						agent: "Prometheus (Plan Builder)",
						error: {
							name: "MessageAbortedError",
							data: { message: "Aborted" },
						},
					},
				},
			},
		} as any)

		//#then
		expect(abortCalls).toEqual([])
		expect(promptAsyncCalls).toHaveLength(2)
		expect((promptAsyncCalls[0]?.body as { agent?: string } | undefined)?.agent).toBe("Prometheus (Plan Builder)")
		expect((promptAsyncCalls[1]?.body as { agent?: string } | undefined)?.agent).toBeUndefined()
		const promptBody = promptAsyncCalls[1]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("previous planning tool call was emitted without the required arguments")
	})

	it("recovers a same-message aborted Prometheus write wrapper directly from session.error", async () => {
		//#given
		const sessionID = "ses_same_message_aborted_write_wrapper_session_error"
		const abortCalls: string[] = []
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									id: "msg_user_same_message_wrapper_session_error",
									role: "user",
									agent: "Prometheus (Plan Builder)",
									providerID: "anthropic",
									modelID: "claude-opus-4-6",
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									id: "msg_assistant_same_message_wrapper_session_error",
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									error: {
										name: "MessageAbortedError",
										data: { message: "Aborted" },
									},
									parts: [
										{ type: "step-start" },
										{ type: "text", text: "Writing the final plan now." },
										{
											type: "tool",
											tool: "write",
											raw: "",
											state: {
												status: "error",
												input: {},
												error: "Tool execution aborted",
												metadata: { interrupted: true },
											},
										},
									],
								},
							],
						}),
						abort: async ({ path }: { path: { id: string } }) => {
							abortCalls.push(path.id)
							return {}
						},
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "session.error",
				properties: {
					sessionID,
					messageID: "msg_assistant_same_message_wrapper_session_error",
					error: {
						name: "MessageAbortedError",
						data: { message: "Aborted" },
					},
				},
			},
		} as any)

		//#then
		expect(abortCalls).toEqual([])
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("previous planning tool call was emitted without the required arguments")
	})

	it("recovers a same-message aborted Prometheus write wrapper from session.error when the latest message has not persisted message.error yet", async () => {
		//#given
		const sessionID = "ses_same_message_aborted_write_wrapper_session_error_pending_message_error"
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									id: "msg_user_same_message_wrapper_session_error_pending_message_error",
									role: "user",
									agent: "Prometheus (Plan Builder)",
									providerID: "anthropic",
									modelID: "claude-opus-4-6",
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									id: "msg_assistant_same_message_wrapper_session_error_pending_message_error",
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									parts: [
										{ type: "step-start" },
										{ type: "text", text: "Now I'll write the complete final plan to the draft first, then promote it:" },
										{
											type: "tool",
											tool: "write",
											raw: "",
											state: {
												status: "error",
												input: {},
												error: "Tool execution aborted",
												metadata: { interrupted: true },
											},
										},
									],
								},
							],
						}),
						abort: async () => ({}),
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "session.error",
				properties: {
					sessionID,
					messageID: "msg_assistant_same_message_wrapper_session_error_pending_message_error",
					error: {
						name: "MessageAbortedError",
						data: { message: "Aborted" },
					},
				},
			},
		} as any)

		//#then
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("previous planning tool call was emitted without the required arguments")
	})

	it("immediately recovers an interrupted Prometheus planning write when the tool-error part lands after the wrapper abort", async () => {
		//#given
		const sessionID = "ses_same_message_aborted_write_wrapper_part_update_recovery"
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									id: "msg_user_same_message_wrapper_part_update_recovery",
									role: "user",
									agent: "Prometheus (Plan Builder)",
									providerID: "anthropic",
									modelID: "claude-opus-4-6",
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									id: "msg_assistant_same_message_wrapper_part_update_recovery",
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									parts: [
										{ type: "step-start" },
										{ type: "text", text: "Now I'll write the complete final unified plan." },
										{
											type: "tool",
											tool: "write",
											raw: "",
											state: {
												status: "error",
												input: {},
												error: "Tool execution aborted",
												metadata: { interrupted: true },
											},
										},
									],
								},
							],
						}),
						abort: async () => ({}),
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		await eventHandler({
			event: {
				type: "message.updated",
				properties: {
					info: {
						id: "msg_assistant_same_message_wrapper_part_update_recovery",
						sessionID,
						role: "assistant",
						agent: "Prometheus (Plan Builder)",
					},
				},
			},
		} as any)

		//#when
		await eventHandler({
			event: {
				type: "message.part.updated",
				properties: {
					part: {
						sessionID,
						messageID: "msg_assistant_same_message_wrapper_part_update_recovery",
						type: "tool",
						tool: "write",
						raw: "",
						state: {
							status: "error",
							input: {},
							error: "Tool execution aborted",
							metadata: { interrupted: true },
						},
					},
				},
			},
		} as any)

		//#then
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("previous planning tool call was emitted without the required arguments")
	})

	it("immediately recovers an interrupted Prometheus planning write when the latest message already persisted the aborted wrapper error", async () => {
		//#given
		const sessionID = "ses_same_message_aborted_write_wrapper_part_update_with_persisted_error"
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									id: "msg_user_same_message_wrapper_part_update_with_persisted_error",
									role: "user",
									agent: "Prometheus (Plan Builder)",
									providerID: "anthropic",
									modelID: "claude-opus-4-6",
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									id: "msg_assistant_same_message_wrapper_part_update_with_persisted_error",
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									error: {
										name: "MessageAbortedError",
										data: { message: "Aborted" },
									},
									parts: [
										{ type: "step-start" },
										{ type: "text", text: "Now I'll write the complete final unified plan." },
										{
											type: "tool",
											tool: "write",
											raw: "",
											state: {
												status: "error",
												input: {},
												error: "Tool execution aborted",
												metadata: { interrupted: true },
											},
										},
									],
								},
							],
						}),
						abort: async () => ({}),
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		await eventHandler({
			event: {
				type: "message.updated",
				properties: {
					info: {
						id: "msg_assistant_same_message_wrapper_part_update_with_persisted_error",
						sessionID,
						role: "assistant",
						agent: "Prometheus (Plan Builder)",
						error: {
							name: "MessageAbortedError",
							data: { message: "Aborted" },
						},
					},
				},
			},
		} as any)

		//#when
		await eventHandler({
			event: {
				type: "message.part.updated",
				properties: {
					part: {
						sessionID,
						messageID: "msg_assistant_same_message_wrapper_part_update_with_persisted_error",
						type: "tool",
						tool: "write",
						raw: "",
						state: {
							status: "error",
							input: {},
							error: "Tool execution aborted",
							metadata: { interrupted: true },
						},
					},
				},
			},
		} as any)

		//#then
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("previous planning tool call was emitted without the required arguments")
	})

	it("immediately recovers an interrupted Prometheus planning write when message.part.updated carries ids only via info", async () => {
		//#given
		const sessionID = "ses_same_message_aborted_write_wrapper_part_update_info_ids"
		const messageID = "msg_assistant_same_message_wrapper_part_update_info_ids"
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									id: "msg_user_same_message_wrapper_part_update_info_ids",
									role: "user",
									agent: "Prometheus (Plan Builder)",
									providerID: "anthropic",
									modelID: "claude-opus-4-6",
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									id: messageID,
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									error: {
										name: "MessageAbortedError",
										data: { message: "Aborted" },
									},
									parts: [
										{ type: "step-start" },
										{
											type: "reasoning",
											text: "Now I have all the context. Let me synthesize the final plan.",
										},
										{
											type: "text",
											text: "Now I have all the context. Let me write the final plan.",
										},
										{
											type: "tool",
											tool: "write",
											raw: "",
											state: {
												status: "error",
												input: {},
												error: "Tool execution aborted",
												metadata: { interrupted: true },
											},
										},
									],
								},
							],
						}),
						abort: async () => ({}),
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		await eventHandler({
			event: {
				type: "message.updated",
				properties: {
					info: {
						id: messageID,
						sessionID,
						role: "assistant",
						agent: "Prometheus (Plan Builder)",
					},
				},
			},
		} as any)

		//#when
		await eventHandler({
			event: {
				type: "message.part.updated",
				properties: {
					info: {
						id: messageID,
						sessionID,
						role: "assistant",
					},
					part: {
						type: "tool",
						tool: "write",
						raw: "",
						state: {
							status: "error",
							input: {},
							error: "Tool execution aborted",
							metadata: { interrupted: true },
						},
					},
				},
			},
		} as any)

		//#then
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("previous planning tool call was emitted without the required arguments")
	})

	it("immediately recovers an interrupted Prometheus planning write when message and part events omit sessionID but the db can resolve it", async () => {
		//#given
		const sessionID = "ses_same_message_aborted_write_wrapper_db_ids"
		const messageID = "msg_assistant_same_message_wrapper_db_ids"
		const partID = "prt_assistant_same_message_wrapper_db_ids"
		withEventSessionDb(sessionID, { messageID, partID })
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									id: "msg_user_same_message_wrapper_db_ids",
									role: "user",
									agent: "Prometheus (Plan Builder)",
									providerID: "anthropic",
									modelID: "claude-opus-4-6",
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									id: messageID,
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									error: {
										name: "MessageAbortedError",
										data: { message: "Aborted" },
									},
									parts: [
										{ type: "step-start" },
										{
											type: "reasoning",
											text: "Now I have all the context. Let me synthesize the final plan.",
										},
										{
											type: "text",
											text: "Now I have all the context. Let me write the final plan.",
										},
										{
											type: "tool",
											tool: "write",
											raw: "",
											state: {
												status: "error",
												input: {},
												error: "Tool execution aborted",
												metadata: { interrupted: true },
											},
										},
									],
								},
							],
						}),
						abort: async () => ({}),
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		await eventHandler({
			event: {
				type: "message.updated",
				properties: {
					info: {
						id: messageID,
						role: "assistant",
						agent: "Prometheus (Plan Builder)",
					},
				},
			},
		} as any)

		//#when
		await eventHandler({
			event: {
				type: "message.part.updated",
				properties: {
					info: {
						id: messageID,
						role: "assistant",
					},
					part: {
						id: partID,
						type: "tool",
						tool: "write",
						raw: "",
						state: {
							status: "error",
							input: {},
							error: "Tool execution aborted",
							metadata: { interrupted: true },
						},
					},
				},
			},
		} as any)

		//#then
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("previous planning tool call was emitted without the required arguments")
	})

	it("inherits the Prometheus agent onto a new assistant snapshot when the interrupted write arrives only as a tool part", async () => {
		//#given
		const sessionID = "ses_part_only_new_message_inherits_agent"
		const priorMessageID = "msg_assistant_prior_prometheus_turn"
		const newMessageID = "msg_assistant_part_only_interrupted_write"
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						abort: async () => ({}),
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		await eventHandler({
			event: {
				type: "message.updated",
				properties: {
					info: {
						id: priorMessageID,
						sessionID,
						role: "assistant",
						agent: "Prometheus (Plan Builder)",
					},
				},
			},
		} as any)

		//#when
		await eventHandler({
			event: {
				type: "message.part.updated",
				properties: {
					part: {
						id: "part_new_message_interrupted_write",
						sessionID,
						messageID: newMessageID,
						type: "tool",
						tool: "write",
						raw: "",
						state: {
							status: "error",
							input: {},
							error: "Tool execution aborted",
							metadata: { interrupted: true },
						},
					},
				},
			},
		} as any)

		//#then
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("previous planning tool call was emitted without the required arguments")
	})

	it("immediately recovers an interrupted Prometheus planning write when message.part.updated omits messageID and reuses the current snapshot", async () => {
		//#given
		const sessionID = "ses_same_message_aborted_write_wrapper_part_update_snapshot_fallback"
		const messageID = "msg_assistant_same_message_wrapper_part_update_snapshot_fallback"
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									id: "msg_user_same_message_wrapper_part_update_snapshot_fallback",
									role: "user",
									agent: "Prometheus (Plan Builder)",
									providerID: "anthropic",
									modelID: "claude-opus-4-6",
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									id: messageID,
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									error: {
										name: "MessageAbortedError",
										data: { message: "Aborted" },
									},
									parts: [
										{ type: "step-start" },
										{
											type: "text",
											text: "Now I'll compose the complete final plan and write it to the draft first.",
										},
										{
											type: "tool",
											tool: "write",
											raw: "",
											state: {
												status: "error",
												input: {},
												error: "Tool execution aborted",
												metadata: { interrupted: true },
											},
										},
									],
								},
							],
						}),
						abort: async () => ({}),
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		await eventHandler({
			event: {
				type: "message.updated",
				properties: {
					info: {
						id: messageID,
						sessionID,
						role: "assistant",
						agent: "Prometheus (Plan Builder)",
					},
				},
			},
		} as any)

		//#when
		await eventHandler({
			event: {
				type: "message.part.updated",
				properties: {
					sessionID,
					part: {
						type: "tool",
						tool: "write",
						raw: "",
						state: {
							status: "error",
							input: {},
							error: "Tool execution aborted",
							metadata: { interrupted: true },
						},
					},
				},
			},
		} as any)

		//#then
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("previous planning tool call was emitted without the required arguments")
	})

	it("recovers a same-message aborted Prometheus write wrapper from session.error using the cached tool snapshot when the transcript omits the broken tool part", async () => {
		//#given
		const sessionID = "ses_same_message_aborted_write_wrapper_session_error_cached_snapshot"
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									id: "msg_user_same_message_wrapper_session_error_cached_snapshot",
									role: "user",
									agent: "Prometheus (Plan Builder)",
									providerID: "anthropic",
									modelID: "claude-opus-4-6",
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									id: "msg_assistant_same_message_wrapper_session_error_cached_snapshot",
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									error: {
										name: "MessageAbortedError",
										data: { message: "Aborted" },
									},
									parts: [
										{ type: "step-start" },
										{ type: "text", text: "Now I'll write the complete final plan to the draft." },
									],
								},
							],
						}),
						abort: async () => ({}),
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		await eventHandler({
			event: {
				type: "message.updated",
				properties: {
					info: {
						id: "msg_assistant_same_message_wrapper_session_error_cached_snapshot",
						sessionID,
						role: "assistant",
						agent: "Prometheus (Plan Builder)",
					},
				},
			},
		} as any)

		await eventHandler({
			event: {
				type: "message.part.updated",
				properties: {
					part: {
						sessionID,
						messageID: "msg_assistant_same_message_wrapper_session_error_cached_snapshot",
						type: "tool",
						tool: "write",
						raw: "",
						state: {
							status: "error",
							input: {},
							error: "Tool execution aborted",
							metadata: { interrupted: true },
						},
					},
				},
			},
		} as any)

		//#when
		await eventHandler({
			event: {
				type: "session.error",
				properties: {
					sessionID,
					messageID: "msg_assistant_same_message_wrapper_session_error_cached_snapshot",
					error: {
						name: "MessageAbortedError",
						data: { message: "Aborted" },
					},
				},
			},
		} as any)

		//#then
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("previous planning tool call was emitted without the required arguments")
	})

	it("recovers a same-message aborted Prometheus write wrapper from session.error using the cached tool snapshot when the aborted message is not latest yet", async () => {
		//#given
		const sessionID = "ses_same_message_aborted_write_wrapper_session_error_pending_persist"
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									id: "msg_user_same_message_wrapper_session_error_pending_persist",
									role: "user",
									agent: "Prometheus (Plan Builder)",
									providerID: "anthropic",
									modelID: "claude-opus-4-6",
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									id: "msg_assistant_previous_visible_turn",
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									parts: [
										{ type: "text", text: "Good. I have all the source material. Now I'll synthesize the final unified plan." },
									],
								},
							],
						}),
						abort: async () => ({}),
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		await eventHandler({
			event: {
				type: "message.updated",
				properties: {
					info: {
						id: "msg_assistant_same_message_wrapper_session_error_pending_persist",
						sessionID,
						role: "assistant",
						agent: "Prometheus (Plan Builder)",
					},
				},
			},
		} as any)

		await eventHandler({
			event: {
				type: "message.part.updated",
				properties: {
					part: {
						sessionID,
						messageID: "msg_assistant_same_message_wrapper_session_error_pending_persist",
						type: "tool",
						tool: "write",
						raw: "",
						state: {
							status: "error",
							input: {},
							error: "Tool execution aborted",
							metadata: { interrupted: true },
						},
					},
				},
			},
		} as any)

		//#when
		await eventHandler({
			event: {
				type: "session.error",
				properties: {
					sessionID,
					messageID: "msg_assistant_same_message_wrapper_session_error_pending_persist",
					error: {
						name: "MessageAbortedError",
						data: { message: "Aborted" },
					},
				},
			},
		} as any)

		//#then
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("previous planning tool call was emitted without the required arguments")
	})

	it("recovers a provider-blocked Prometheus planning turn from session.error by resuming the prior visible turn", async () => {
		//#given
		const sessionID = "ses_prometheus_provider_blocked_session_error"
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									id: "msg_user_provider_blocked",
									role: "user",
									agent: "Prometheus (Plan Builder)",
									providerID: "anthropic",
									modelID: "claude-opus-4-6",
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									id: "msg_assistant_provider_visible",
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									finish: "other",
									parts: [
										{ type: "text", text: "I have full context from all 6 artifacts. Now I'll write the complete final plan." },
									],
								},
								{
									id: "msg_assistant_provider_error",
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									error: {
										name: "APIError",
										data: {
											message: "Forbidden: {\"error\":{\"type\":\"forbidden\",\"message\":\"Request not allowed\"}}",
											statusCode: 403,
										},
									},
									parts: [{ type: "patch" }],
								},
							],
						}),
						abort: async () => ({}),
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "session.error",
				properties: {
					sessionID,
					messageID: "msg_assistant_provider_error",
					error: {
						name: "APIError",
						data: {
							message: "Forbidden: {\"error\":{\"type\":\"forbidden\",\"message\":\"Request not allowed\"}}",
							statusCode: 403,
						},
					},
				},
			},
		} as any)

	//#then
	expect(promptAsyncCalls).toHaveLength(1)
	const promptBody = promptAsyncCalls[0]?.body as { parts?: Array<{ text?: string }> } | undefined
	expect(promptBody?.parts?.[0]?.text).toContain("resume interrupted plan generation")
	})

	it("recovers a provider-blocked root Prometheus planning turn from the original user prompt on the next paid model", async () => {
		//#given
		const sessionID = "ses_prometheus_provider_blocked_root_turn"
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									id: "msg_user_provider_blocked_root_turn",
									role: "user",
									agent: "Prometheus (Plan Builder)",
									providerID: "anthropic",
									modelID: "claude-opus-4-6",
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									id: "msg_assistant_provider_blocked_root_turn_error",
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									error: {
										name: "APIError",
										data: {
											message: "Forbidden: {\"error\":{\"type\":\"forbidden\",\"message\":\"Request not allowed\"}}",
											statusCode: 403,
										},
									},
									parts: [{ type: "patch" }],
								},
							],
						}),
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
				agents: {
					prometheus: {
						fallback_models: [
							"openai/gpt-5.4",
							"anthropic/claude-sonnet-4-6",
							"opencode/nemotron-3-super-free",
						],
					},
				},
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "session.error",
				properties: {
					sessionID,
					messageID: "msg_assistant_provider_blocked_root_turn_error",
					error: {
						name: "APIError",
						data: {
							message: "Forbidden: {\"error\":{\"type\":\"forbidden\",\"message\":\"Request not allowed\"}}",
							statusCode: 403,
						},
					},
				},
			},
		} as any)

		//#then
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as {
			model?: { providerID?: string; modelID?: string }
			parts?: Array<{ text?: string }>
		} | undefined
		expect(promptBody?.model).toEqual({
			providerID: "anthropic",
			modelID: "claude-opus-4-6",
		})
		expect(promptBody?.parts?.[0]?.text).toContain("complete plan generation now")
	})

	it("does not double-resume a provider-blocked Prometheus planning turn while runtime fallback has already dispatched recovery", async () => {
		//#given
		const sessionID = "ses_prometheus_provider_blocked_runtime_fallback_guard"
		const promptAsyncCalls: Array<Record<string, unknown>> = []
		markRecentRuntimeFallbackContinuationDispatch(sessionID)

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									id: "msg_user_provider_blocked_runtime_fallback_guard",
									role: "user",
									agent: "Prometheus (Plan Builder)",
									providerID: "anthropic",
									modelID: "claude-opus-4-6",
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									id: "msg_assistant_provider_blocked_runtime_fallback_guard_visible",
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									finish: "other",
									parts: [
										{ type: "reasoning", text: "I have full context and can now write the final plan." },
									],
								},
								{
									id: "msg_assistant_provider_blocked_runtime_fallback_guard_error",
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									error: {
										name: "APIError",
										data: {
											message: "Forbidden: {\"error\":{\"type\":\"forbidden\",\"message\":\"Request not allowed\"}}",
											statusCode: 403,
										},
									},
									parts: [{ type: "patch" }],
								},
							],
						}),
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
				agents: {
					prometheus: {
						fallback_models: [
							"openai/gpt-5.4",
							"anthropic/claude-sonnet-4-6",
							"opencode/nemotron-3-super-free",
						],
					},
				},
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "session.error",
				properties: {
					sessionID,
					messageID: "msg_assistant_provider_blocked_runtime_fallback_guard_error",
					error: {
						name: "APIError",
						data: {
							message: "Forbidden: {\"error\":{\"type\":\"forbidden\",\"message\":\"Request not allowed\"}}",
							statusCode: 403,
						},
					},
				},
			},
		} as any)

		await eventHandler({
			event: {
				type: "session.idle",
				properties: {
					sessionID,
				},
			},
		} as any)

		//#then
		expect(promptAsyncCalls).toHaveLength(0)
	})

	it("does not recover an idle Prometheus reasoning-only turn while runtime fallback recently continued the same session", async () => {
		//#given
		const sessionID = "ses_prometheus_reasoning_idle_runtime_fallback_guard"
		const promptAsyncCalls: Array<Record<string, unknown>> = []
		markRecentRuntimeFallbackContinuationDispatch(sessionID)

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									id: "msg_user_reasoning_idle_runtime_fallback_guard",
									role: "user",
									agent: "Prometheus (Plan Builder)",
									providerID: "anthropic",
									modelID: "claude-opus-4-6",
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									id: "msg_assistant_reasoning_idle_runtime_fallback_guard",
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									finish: "other",
									parts: [
										{ type: "reasoning", text: "I have enough context to write the final plan now." },
										{ type: "patch" },
									],
								},
							],
						}),
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "session.idle",
				properties: {
					sessionID,
				},
			},
		} as any)

		//#then
		expect(promptAsyncCalls).toHaveLength(0)
	})

	it("does not recover an idle Prometheus interrupted visible turn while runtime fallback recently continued the same session", async () => {
		//#given
		const sessionID = "ses_prometheus_visible_idle_runtime_fallback_guard"
		const promptAsyncCalls: Array<Record<string, unknown>> = []
		markRecentRuntimeFallbackContinuationDispatch(sessionID)

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									id: "msg_user_visible_idle_runtime_fallback_guard",
									role: "user",
									agent: "Prometheus (Plan Builder)",
									providerID: "anthropic",
									modelID: "claude-opus-4-6",
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									id: "msg_assistant_visible_idle_runtime_fallback_guard",
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									finish: "other",
									parts: [
										{ type: "text", text: "I have assembled the plan fragments and am ready to write the final artifact." },
										{ type: "patch" },
									],
								},
							],
						}),
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "session.idle",
				properties: {
					sessionID,
				},
			},
		} as any)

		//#then
		expect(promptAsyncCalls).toHaveLength(0)
	})

	it("recovers a persisted provider-blocked Prometheus planning turn from session.idle on the same paid model", async () => {
		//#given
		const sessionID = "ses_prometheus_provider_blocked_idle_recovery"
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									id: "msg_user_provider_blocked_idle_recovery",
									role: "user",
									agent: "Prometheus (Plan Builder)",
									providerID: "anthropic",
									modelID: "claude-opus-4-6",
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									id: "msg_assistant_provider_blocked_idle_recovery_visible",
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									finish: "other",
									parts: [
										{ type: "text", text: "I have full context from all artifacts. Now I'll write the final plan." },
									],
								},
								{
									id: "msg_assistant_provider_blocked_idle_recovery_error",
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									error: {
										name: "APIError",
										data: {
											message: "Forbidden: {\"error\":{\"type\":\"forbidden\",\"message\":\"Request not allowed\"}}",
											statusCode: 403,
										},
									},
									parts: [{ type: "patch" }],
								},
							],
						}),
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
				agents: {
					prometheus: {
						fallback_models: [
							"openai/gpt-5.4",
							"anthropic/claude-sonnet-4-6",
							"opencode/nemotron-3-super-free",
						],
					},
				},
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "session.idle",
				properties: {
					sessionID,
				},
			},
		} as any)

		//#then
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as {
			model?: { providerID?: string; modelID?: string }
			parts?: Array<{ text?: string }>
		} | undefined
		expect(promptBody?.model).toEqual({
			providerID: "anthropic",
			modelID: "claude-opus-4-6",
		})
		expect(promptBody?.parts?.[0]?.text).toContain("resume interrupted plan generation")
	})

	it("retries a provider-blocked Prometheus planning turn on the same paid model before the retry window expires", async () => {
		//#given
		const sessionID = "ses_prometheus_provider_blocked_paid_model_recovery"
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									id: "msg_user_provider_blocked_paid_model_recovery",
									role: "user",
									agent: "Prometheus (Plan Builder)",
									providerID: "anthropic",
									modelID: "claude-opus-4-6",
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									id: "msg_assistant_provider_blocked_paid_model_recovery_prior",
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									finish: "other",
									parts: [
										{ type: "text", text: "I have full context from all artifacts. Now I'll generate the final unified plan." },
									],
								},
								{
									id: "msg_assistant_provider_blocked_paid_model_recovery_error",
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									error: {
										name: "APIError",
										data: {
											message: "Forbidden: {\"error\":{\"type\":\"forbidden\",\"message\":\"Request not allowed\"}}",
											statusCode: 403,
										},
									},
									parts: [{ type: "patch" }],
								},
							],
						}),
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
				agents: {
					prometheus: {
						fallback_models: [
							"openai/gpt-5.4",
							"anthropic/claude-sonnet-4-6",
							"opencode/nemotron-3-super-free",
						],
					},
				},
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "session.error",
				properties: {
					sessionID,
					messageID: "msg_assistant_provider_blocked_paid_model_recovery_error",
					error: {
						name: "APIError",
						data: {
							message: "Forbidden: {\"error\":{\"type\":\"forbidden\",\"message\":\"Request not allowed\"}}",
							statusCode: 403,
						},
					},
				},
			},
		} as any)

		//#then
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as {
			model?: { providerID?: string; modelID?: string }
			parts?: Array<{ text?: string }>
		} | undefined
		expect(promptBody?.model).toEqual({
			providerID: "anthropic",
			modelID: "claude-opus-4-6",
		})
		expect(promptBody?.parts?.[0]?.text).toContain("resume interrupted plan generation")
	})

	it("advances a persisted provider-blocked Prometheus planning turn from session.idle to the next paid model after the retry window expires", async () => {
		//#given
		jest.useFakeTimers()
		const now = new Date("2026-04-21T05:18:25.000Z")
		jest.setSystemTime(now)
		const sessionID = "ses_prometheus_provider_blocked_idle_window_expired"
		const promptAsyncCalls: Array<Record<string, unknown>> = []
		let phase: "first" | "second" = "first"

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: phase === "first"
								? [
									{
										id: "msg_user_provider_blocked_idle_window_expired",
										role: "user",
										agent: "Prometheus (Plan Builder)",
										providerID: "anthropic",
										modelID: "claude-opus-4-6",
										parts: [{ type: "text", text: "Generate the final plan" }],
									},
									{
										id: "msg_assistant_provider_blocked_idle_window_expired_visible",
										role: "assistant",
										agent: "Prometheus (Plan Builder)",
										finish: "other",
										parts: [
											{ type: "text", text: "I have full context from all artifacts. Now I'll write the final plan." },
										],
									},
									{
										id: "msg_assistant_provider_blocked_idle_window_expired_error_one",
										role: "assistant",
										agent: "Prometheus (Plan Builder)",
										error: {
											name: "APIError",
											data: {
												message: "Forbidden: {\"error\":{\"type\":\"forbidden\",\"message\":\"Request not allowed\"}}",
												statusCode: 403,
											},
										},
										parts: [{ type: "patch" }],
									},
								]
								: [
									{
										id: "msg_user_provider_blocked_idle_window_expired",
										role: "user",
										agent: "Prometheus (Plan Builder)",
										providerID: "anthropic",
										modelID: "claude-opus-4-6",
										parts: [{ type: "text", text: "Generate the final plan" }],
									},
									{
										id: "msg_assistant_provider_blocked_idle_window_expired_visible",
										role: "assistant",
										agent: "Prometheus (Plan Builder)",
										finish: "other",
										parts: [
											{ type: "text", text: "I have full context from all artifacts. Now I'll write the final plan." },
										],
									},
									{
										id: "msg_assistant_provider_blocked_idle_window_expired_error_two",
										role: "assistant",
										agent: "Prometheus (Plan Builder)",
										error: {
											name: "APIError",
											data: {
												message: "Forbidden: {\"error\":{\"type\":\"forbidden\",\"message\":\"Request not allowed\"}}",
												statusCode: 403,
											},
										},
										parts: [{ type: "patch" }],
									},
								],
						}),
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
				agents: {
					prometheus: {
						fallback_models: [
							"openai/gpt-5.4",
							"anthropic/claude-sonnet-4-6",
							"opencode/nemotron-3-super-free",
						],
					},
				},
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "session.idle",
				properties: {
					sessionID,
				},
			},
		} as any)

		jest.setSystemTime(now.getTime() + 10 * 60 * 1000 + 1)
		phase = "second"

		await eventHandler({
			event: {
				type: "session.idle",
				properties: {
					sessionID,
				},
			},
		} as any)

		//#then
		expect(promptAsyncCalls).toHaveLength(2)
		const secondPromptBody = promptAsyncCalls[1]?.body as {
			model?: { providerID?: string; modelID?: string }
			parts?: Array<{ text?: string }>
		} | undefined
		expect(secondPromptBody?.model).toEqual({
			providerID: "openai",
			modelID: "gpt-5.4",
		})
		expect(secondPromptBody?.parts?.[0]?.text).toContain("resume interrupted plan generation")
	})

	it("advances a provider-blocked Prometheus planning turn to the next paid model after the same-model retry window expires", async () => {
		//#given
		jest.useFakeTimers()
		const sessionID = "ses_prometheus_provider_blocked_window_expired"
		const promptAsyncCalls: Array<Record<string, unknown>> = []
		let phase: "first" | "second" = "first"

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: phase === "first"
								? [
									{
										id: "msg_user_provider_blocked_window_expired",
										role: "user",
										agent: "Prometheus (Plan Builder)",
										providerID: "anthropic",
										modelID: "claude-opus-4-6",
										parts: [{ type: "text", text: "Generate the final plan" }],
									},
									{
										id: "msg_assistant_provider_blocked_window_expired_visible",
										role: "assistant",
										agent: "Prometheus (Plan Builder)",
										finish: "other",
										parts: [
											{ type: "text", text: "I have full context from all artifacts. Now I'll write the final plan." },
										],
									},
									{
										id: "msg_assistant_provider_blocked_window_expired_error_one",
										role: "assistant",
										agent: "Prometheus (Plan Builder)",
										error: {
											name: "APIError",
											data: {
												message: "Forbidden: {\"error\":{\"type\":\"forbidden\",\"message\":\"Request not allowed\"}}",
												statusCode: 403,
											},
										},
										parts: [{ type: "patch" }],
									},
								]
								: [
									{
										id: "msg_user_provider_blocked_window_expired",
										role: "user",
										agent: "Prometheus (Plan Builder)",
										providerID: "anthropic",
										modelID: "claude-opus-4-6",
										parts: [{ type: "text", text: "Generate the final plan" }],
									},
									{
										id: "msg_assistant_provider_blocked_window_expired_visible",
										role: "assistant",
										agent: "Prometheus (Plan Builder)",
										finish: "other",
										parts: [
											{ type: "text", text: "I have full context from all artifacts. Now I'll write the final plan." },
										],
									},
									{
										id: "msg_assistant_provider_blocked_window_expired_error_two",
										role: "assistant",
										agent: "Prometheus (Plan Builder)",
										error: {
											name: "APIError",
											data: {
												message: "Forbidden: {\"error\":{\"type\":\"forbidden\",\"message\":\"Request not allowed\"}}",
												statusCode: 403,
											},
										},
										parts: [{ type: "patch" }],
									},
								],
						}),
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
				agents: {
					prometheus: {
						fallback_models: [
							"openai/gpt-5.4",
							"anthropic/claude-sonnet-4-6",
							"opencode/nemotron-3-super-free",
						],
					},
				},
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "session.error",
				properties: {
					sessionID,
					messageID: "msg_assistant_provider_blocked_window_expired_error_one",
					error: {
						name: "APIError",
						data: {
							message: "Forbidden: {\"error\":{\"type\":\"forbidden\",\"message\":\"Request not allowed\"}}",
							statusCode: 403,
						},
					},
				},
			},
		} as any)

		jest.setSystemTime(Date.now() + 10 * 60 * 1000 + 1)
		phase = "second"

		await eventHandler({
			event: {
				type: "session.error",
				properties: {
					sessionID,
					messageID: "msg_assistant_provider_blocked_window_expired_error_two",
					error: {
						name: "APIError",
						data: {
							message: "Forbidden: {\"error\":{\"type\":\"forbidden\",\"message\":\"Request not allowed\"}}",
							statusCode: 403,
						},
					},
				},
			},
		} as any)

		//#then
		expect(promptAsyncCalls).toHaveLength(2)
		const secondPromptBody = promptAsyncCalls[1]?.body as {
			model?: { providerID?: string; modelID?: string }
			parts?: Array<{ text?: string }>
		} | undefined
		expect(secondPromptBody?.model).toEqual({
			providerID: "openai",
			modelID: "gpt-5.4",
		})
		expect(secondPromptBody?.parts?.[0]?.text).toContain("resume interrupted plan generation")
	})

	it("re-recovers the same Prometheus planning turn on the next paid model after a second provider block on the recovery turn", async () => {
		//#given
		const sessionID = "ses_prometheus_provider_blocked_recovery_chain"
		const promptAsyncCalls: Array<Record<string, unknown>> = []
		let phase: "first" | "second" = "first"

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: phase === "first"
								? [
									{
										id: "msg_user_provider_blocked_recovery_chain",
										role: "user",
										agent: "Prometheus (Plan Builder)",
										providerID: "anthropic",
										modelID: "claude-opus-4-6",
										parts: [{ type: "text", text: "Generate the final plan" }],
									},
									{
										id: "msg_assistant_provider_blocked_recovery_chain_visible",
										role: "assistant",
										agent: "Prometheus (Plan Builder)",
										finish: "other",
										parts: [
											{ type: "text", text: "I have full context from all artifacts. Now I'll write the final plan." },
										],
									},
									{
										id: "msg_assistant_provider_blocked_recovery_chain_error_one",
										role: "assistant",
										agent: "Prometheus (Plan Builder)",
										providerID: "anthropic",
										modelID: "claude-opus-4-6",
										error: {
											name: "APIError",
											data: {
												message: "Forbidden: {\"error\":{\"type\":\"forbidden\",\"message\":\"Request not allowed\"}}",
												statusCode: 403,
											},
										},
										parts: [{ type: "patch" }],
									},
								]
								: [
									{
										id: "msg_user_provider_blocked_recovery_chain",
										role: "user",
										agent: "Prometheus (Plan Builder)",
										providerID: "anthropic",
										modelID: "claude-opus-4-6",
										parts: [{ type: "text", text: "Generate the final plan" }],
									},
									{
										id: "msg_assistant_provider_blocked_recovery_chain_visible",
										role: "assistant",
										agent: "Prometheus (Plan Builder)",
										finish: "other",
										parts: [
											{ type: "text", text: "I have full context from all artifacts. Now I'll write the final plan." },
										],
									},
									{
										id: "msg_internal_recovery_turn",
										role: "user",
										agent: "Prometheus (Plan Builder)",
										parts: [{ type: "text", text: "[session recovered - resume interrupted plan generation now]" }],
									},
									{
										id: "msg_assistant_provider_blocked_recovery_chain_error_two",
										role: "assistant",
										agent: "Prometheus (Plan Builder)",
										providerID: "openai",
										modelID: "gpt-5.4",
										error: {
											name: "APIError",
											data: {
												message: "Forbidden: <html><title>Cloudflare</title></html>",
												statusCode: 403,
											},
										},
										parts: [{ type: "patch" }],
									},
								],
						}),
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
				agents: {
					prometheus: {
						fallback_models: [
							"openai/gpt-5.4",
							"anthropic/claude-sonnet-4-6",
							"opencode/nemotron-3-super-free",
						],
					},
				},
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "session.error",
				properties: {
					sessionID,
					messageID: "msg_assistant_provider_blocked_recovery_chain_error_one",
					error: {
						name: "APIError",
						data: {
							message: "Forbidden: {\"error\":{\"type\":\"forbidden\",\"message\":\"Request not allowed\"}}",
							statusCode: 403,
						},
					},
				},
			},
		} as any)

		phase = "second"

		await eventHandler({
			event: {
				type: "session.error",
				properties: {
					sessionID,
					messageID: "msg_assistant_provider_blocked_recovery_chain_error_two",
					error: {
						name: "APIError",
						data: {
							message: "Forbidden: <html><title>Cloudflare</title></html>",
							statusCode: 403,
						},
					},
				},
			},
		} as any)

		//#then
		expect(promptAsyncCalls).toHaveLength(2)
		expect((promptAsyncCalls[0]?.body as { model?: { providerID?: string; modelID?: string } } | undefined)?.model).toEqual({
			providerID: "anthropic",
			modelID: "claude-opus-4-6",
		})
		expect((promptAsyncCalls[1]?.body as { model?: { providerID?: string; modelID?: string } } | undefined)?.model).toEqual({
			providerID: "openai",
			modelID: "gpt-5.4",
		})
	})

	it("recovers a provider-blocked Prometheus planning turn from session.error by resuming the prior reasoning-only planner turn", async () => {
		//#given
		const sessionID = "ses_prometheus_provider_blocked_session_error_reasoning_only"
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									id: "msg_user_provider_blocked_reasoning_only",
									role: "user",
									agent: "Prometheus (Plan Builder)",
									providerID: "anthropic",
									modelID: "claude-opus-4-6",
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									id: "msg_assistant_provider_reasoning_only_candidate",
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									finish: "other",
									parts: [
										{
											type: "reasoning",
											text: "Now I have a complete picture. Let me synthesize all of this into one final plan.",
										},
										{ type: "patch" },
									],
								},
								{
									id: "msg_assistant_provider_reasoning_only_error",
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									error: {
										name: "APIError",
										data: {
											message: "Forbidden: {\"error\":{\"type\":\"forbidden\",\"message\":\"Request not allowed\"}}",
											statusCode: 403,
										},
									},
									parts: [{ type: "patch" }],
								},
							],
						}),
						abort: async () => ({}),
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "session.error",
				properties: {
					sessionID,
					messageID: "msg_assistant_provider_reasoning_only_error",
					error: {
						name: "APIError",
						data: {
							message: "Forbidden: {\"error\":{\"type\":\"forbidden\",\"message\":\"Request not allowed\"}}",
							statusCode: 403,
						},
					},
				},
			},
		} as any)

		//#then
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("complete plan generation now")
		expect(promptBody?.parts?.[0]?.text).toContain("already exists but still begins with `# Draft:`")
		expect(promptBody?.parts?.[0]?.text).toContain("promote the repaired draft with")
	})

	it("re-recovers a provider-blocked Prometheus recovery turn when the prior planner step was reasoning-only with an internal recovery user prompt", async () => {
		//#given
		const sessionID = "ses_prometheus_provider_blocked_reasoning_recovery_chain"
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									id: "msg_user_provider_blocked_reasoning_recovery_chain",
									role: "user",
									agent: "Prometheus (Plan Builder)",
									providerID: "anthropic",
									modelID: "claude-opus-4-6",
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									id: "msg_assistant_provider_blocked_reasoning_recovery_chain",
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									finish: "other",
									parts: [
										{ type: "step-start" },
										{ type: "reasoning", text: "Now I need to read the rest of the parity plan and then write the final plan." },
										{ type: "step-finish" },
										{ type: "patch" },
									],
								},
								{
									id: "msg_internal_recovery_turn_reasoning_only",
									role: "user",
									agent: "Prometheus (Plan Builder)",
									parts: [
										{
											type: "text",
											text: "[session recovered - complete plan generation now]\nYou are in Prometheus plan-generation mode.\nDo not stop at reasoning.",
										},
									],
								},
								{
									id: "msg_assistant_provider_blocked_reasoning_recovery_chain_error",
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									providerID: "anthropic",
									modelID: "claude-opus-4-6",
									error: {
										name: "APIError",
										data: {
											message: "Forbidden: {\"error\":{\"type\":\"forbidden\",\"message\":\"Request not allowed\"}}",
											statusCode: 403,
										},
									},
									parts: [{ type: "patch" }],
								},
							],
						}),
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
				agents: {
					prometheus: {
						fallback_models: [
							"openai/gpt-5.4",
							"anthropic/claude-sonnet-4-6",
							"opencode/nemotron-3-super-free",
						],
					},
				},
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "session.error",
				properties: {
					sessionID,
					messageID: "msg_assistant_provider_blocked_reasoning_recovery_chain_error",
					error: {
						name: "APIError",
						data: {
							message: "Forbidden: {\"error\":{\"type\":\"forbidden\",\"message\":\"Request not allowed\"}}",
							statusCode: 403,
						},
					},
				},
			},
		} as any)

		//#then
		expect(promptAsyncCalls).toHaveLength(1)
		expect((promptAsyncCalls[0]?.body as { model?: { providerID?: string; modelID?: string } } | undefined)?.model).toEqual({
			providerID: "anthropic",
			modelID: "claude-opus-4-6",
		})
	})

	it("recovers a provider-blocked Prometheus planning turn from session.error using the cached prior recoverable planner snapshot when transcript parts are missing", async () => {
		//#given
		const sessionID = "ses_prometheus_provider_blocked_session_error_cached_prior_snapshot"
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									id: "msg_user_provider_blocked_cached_prior_snapshot",
									role: "user",
									agent: "Prometheus (Plan Builder)",
									providerID: "anthropic",
									modelID: "claude-opus-4-6",
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									id: "msg_assistant_provider_cached_prior_snapshot_candidate",
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									finish: "tool-calls",
									parts: [],
								},
								{
									id: "msg_assistant_provider_cached_prior_snapshot_error",
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									error: {
										name: "APIError",
										data: {
											message: "Forbidden: {\"error\":{\"type\":\"forbidden\",\"message\":\"Request not allowed\"}}",
											statusCode: 403,
										},
									},
									parts: [{ type: "patch" }],
								},
							],
						}),
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		await eventHandler({
			event: {
				type: "message.updated",
				properties: {
					info: {
						id: "msg_assistant_provider_cached_prior_snapshot_candidate",
						sessionID,
						role: "assistant",
						agent: "Prometheus (Plan Builder)",
					},
				},
			},
		} as any)

		await eventHandler({
			event: {
				type: "message.part.updated",
				properties: {
					part: {
						sessionID,
						messageID: "msg_assistant_provider_cached_prior_snapshot_candidate",
						type: "tool",
						tool: "todowrite",
						state: {
							status: "completed",
							input: {
								todos: [
									{
										content: "Synthesize into single final plan at .sisyphus/plans/ci-green-final.md",
										status: "in_progress",
										priority: "high",
									},
								],
							},
						},
					},
				},
			},
		} as any)

		//#when
		await eventHandler({
			event: {
				type: "session.error",
				properties: {
					sessionID,
					messageID: "msg_assistant_provider_cached_prior_snapshot_error",
					error: {
						name: "APIError",
						data: {
							message: "Forbidden: {\"error\":{\"type\":\"forbidden\",\"message\":\"Request not allowed\"}}",
							statusCode: 403,
						},
					},
				},
			},
		} as any)

		//#then
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("resume interrupted plan generation")
	})

	it("recovers a provider-blocked Prometheus planning turn from session.error even if the error message is not persisted yet", async () => {
		//#given
		const sessionID = "ses_prometheus_provider_blocked_pending_persist"
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									id: "msg_user_provider_blocked_pending_persist",
									role: "user",
									agent: "Prometheus (Plan Builder)",
									providerID: "anthropic",
									modelID: "claude-opus-4-6",
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									id: "msg_assistant_provider_visible_pending_persist",
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									finish: "other",
									parts: [
										{ type: "text", text: "I have all required planning context and I am now writing the final plan artifact." },
									],
								},
							],
						}),
						abort: async () => ({}),
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "session.error",
				properties: {
					sessionID,
					messageID: "msg_assistant_provider_error_pending_persist",
					error: {
						name: "APIError",
						data: {
							message: "Forbidden: {\"error\":{\"type\":\"forbidden\",\"message\":\"Request not allowed\"}}",
							statusCode: 403,
						},
					},
				},
			},
		} as any)

		//#then
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("resume interrupted plan generation")
	})

	it("recovers a provider-blocked Prometheus planning turn from message.updated when session.error is absent", async () => {
		//#given
		const sessionID = "ses_prometheus_provider_blocked_message_updated"
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									id: "msg_user_provider_blocked_message_updated",
									role: "user",
									agent: "Prometheus (Plan Builder)",
									providerID: "anthropic",
									modelID: "claude-opus-4-6",
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									id: "msg_assistant_provider_visible_message_updated",
									role: "assistant",
									agent: "Prometheus (Plan Builder)",
									finish: "other",
									parts: [
										{ type: "text", text: "I have enough context. Next I will write the final plan file." },
									],
								},
							],
						}),
						abort: async () => ({}),
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "message.updated",
				properties: {
					info: {
						sessionID,
						id: "msg_assistant_provider_error_message_updated",
						role: "assistant",
						agent: "Prometheus (Plan Builder)",
						error: {
							name: "APIError",
							data: {
								message: "Forbidden: {\"error\":{\"type\":\"forbidden\",\"message\":\"Request not allowed\"}}",
								statusCode: 403,
							},
						},
					},
				},
			},
		} as any)

		//#then
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("resume interrupted plan generation")
	})

	it("recovers a delayed Prometheus planner turn that only emitted internal parts", async () => {
		//#given
		jest.useFakeTimers()
		const sessionID = "ses_planner_internal_only_runtime_fallback"
		const abortCalls: string[] = []
		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									info: {
										id: "msg_user_internal_only",
										role: "user",
										agent: "Prometheus (Plan Builder)",
										model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
									},
									parts: [{ type: "text", text: "Generate the unified CI plan" }],
								},
								{
									info: {
										id: "msg_assistant_internal_only",
										role: "assistant",
										agent: "Prometheus (Plan Builder)",
									},
									parts: [
										{ type: "step-start" },
										{ type: "reasoning", text: "" },
									],
								},
							],
						}),
						abort: async ({ path }: { path: { id: string } }) => {
							abortCalls.push(path.id)
							return {}
						},
						promptAsync: async () => ({}),
						prompt: async () => ({}),
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "message.updated",
				properties: {
					info: {
						id: "msg_assistant_internal_only",
						sessionID,
						role: "assistant",
						agent: "Prometheus (Plan Builder)",
					},
				},
			},
		} as any)
		const jestTimers = jest as unknown as { advanceTimersByTimeAsync?: (ms: number) => Promise<void> }
		if (typeof jestTimers.advanceTimersByTimeAsync === "function") {
			await jestTimers.advanceTimersByTimeAsync(5_000)
		} else {
			jest.advanceTimersByTime(5_000)
			await Promise.resolve()
			await Promise.resolve()
			await Promise.resolve()
		}

		//#then
		expect(abortCalls).toEqual([])
	})

	it("recovers a Prometheus finish-other planning turn immediately when only internal parts were emitted", async () => {
		//#given
		const sessionID = "ses_planner_finish_other_immediate"
		const abortCalls: string[] = []
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => {
							throw new Error("messages unavailable while streaming")
						},
						abort: async ({ path }: { path: { id: string } }) => {
							abortCalls.push(path.id)
							return {}
						},
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "message.part.updated",
				properties: {
					part: {
						id: "part_reasoning_finish_other",
						sessionID,
						messageID: "msg_assistant_finish_other",
						type: "reasoning",
						text: "I now need to build the complete final plan.",
					},
				},
			},
		} as any)
		await eventHandler({
			event: {
				type: "message.part.updated",
				properties: {
					part: {
						id: "part_patch_finish_other",
						sessionID,
						messageID: "msg_assistant_finish_other",
						type: "patch",
					},
				},
			},
		} as any)
		await eventHandler({
			event: {
				type: "message.updated",
				properties: {
					info: {
						id: "msg_assistant_finish_other",
						sessionID,
						role: "assistant",
						agent: "Prometheus (Plan Builder)",
						finish: "other",
					},
				},
			},
		} as any)

		//#then
		expect(abortCalls).toEqual([])
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("complete plan generation now")
	})

	it("recovers a delayed Prometheus planner turn from cached part updates when session.messages is unavailable", async () => {
		//#given
		jest.useFakeTimers()
		const sessionID = "ses_planner_cached_internal_only"
		const abortCalls: string[] = []
		const promptAsyncCalls: Array<Record<string, unknown>> = []
		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => {
							throw new Error("messages unavailable while streaming")
						},
						abort: async ({ path }: { path: { id: string } }) => {
							abortCalls.push(path.id)
							return {}
						},
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "message.updated",
				properties: {
					info: {
						id: "msg_assistant_cached_internal_only",
						sessionID,
						role: "assistant",
						agent: "Prometheus (Plan Builder)",
					},
				},
			},
		} as any)
		await eventHandler({
			event: {
				type: "message.part.updated",
				properties: {
					part: {
						id: "part_step",
						sessionID,
						messageID: "msg_assistant_cached_internal_only",
						type: "step-start",
					},
				},
			},
		} as any)
		await eventHandler({
			event: {
				type: "message.part.updated",
				properties: {
					part: {
						id: "part_reasoning",
						sessionID,
						messageID: "msg_assistant_cached_internal_only",
						type: "reasoning",
						text: "",
					},
				},
			},
		} as any)
		const jestTimers = jest as unknown as { advanceTimersByTimeAsync?: (ms: number) => Promise<void> }
		if (typeof jestTimers.advanceTimersByTimeAsync === "function") {
			await jestTimers.advanceTimersByTimeAsync(5_000)
		} else {
			jest.advanceTimersByTime(5_000)
		}
		for (let index = 0; index < 10; index += 1) {
			await Promise.resolve()
		}
		expect(abortCalls).toEqual([])
		expect(promptAsyncCalls).toHaveLength(0)

		if (typeof jestTimers.advanceTimersByTimeAsync === "function") {
			await jestTimers.advanceTimersByTimeAsync(115_000)
		} else {
			jest.advanceTimersByTime(115_000)
		}
		for (let index = 0; index < 10; index += 1) {
			await Promise.resolve()
		}

		//#then
		expect(abortCalls).toEqual([])
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("complete plan generation now")
	})

	it("re-arms delayed recovery when planner-only internal parts arrive after the original timer window", async () => {
		//#given
		jest.useFakeTimers()
		const sessionID = "ses_planner_cached_internal_only_late_part"
		const abortCalls: string[] = []
		const promptAsyncCalls: Array<Record<string, unknown>> = []
		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => {
							throw new Error("messages unavailable while streaming")
						},
						abort: async ({ path }: { path: { id: string } }) => {
							abortCalls.push(path.id)
							return {}
						},
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "message.updated",
				properties: {
					info: {
						id: "msg_assistant_cached_internal_only_late_part",
						sessionID,
						role: "assistant",
						agent: "Prometheus (Plan Builder)",
					},
				},
			},
		} as any)
		const jestTimers = jest as unknown as { advanceTimersByTimeAsync?: (ms: number) => Promise<void> }
		if (typeof jestTimers.advanceTimersByTimeAsync === "function") {
			await jestTimers.advanceTimersByTimeAsync(5_000)
		} else {
			jest.advanceTimersByTime(5_000)
		}
		for (let index = 0; index < 10; index += 1) {
			await Promise.resolve()
		}
		expect(abortCalls).toEqual([])
		expect(promptAsyncCalls).toHaveLength(0)
		await eventHandler({
			event: {
				type: "message.part.updated",
				properties: {
					part: {
						id: "part_step_late",
						sessionID,
						messageID: "msg_assistant_cached_internal_only_late_part",
						type: "step-start",
					},
				},
			},
		} as any)
		await eventHandler({
			event: {
				type: "message.part.updated",
				properties: {
					part: {
						id: "part_reasoning_late",
						sessionID,
						messageID: "msg_assistant_cached_internal_only_late_part",
						type: "reasoning",
						text: "",
					},
				},
			},
		} as any)
		if (typeof jestTimers.advanceTimersByTimeAsync === "function") {
			await jestTimers.advanceTimersByTimeAsync(5_000)
		} else {
			jest.advanceTimersByTime(5_000)
		}
		for (let index = 0; index < 10; index += 1) {
			await Promise.resolve()
		}
		expect(abortCalls).toEqual([])
		expect(promptAsyncCalls).toHaveLength(0)

		if (typeof jestTimers.advanceTimersByTimeAsync === "function") {
			await jestTimers.advanceTimersByTimeAsync(115_000)
		} else {
			jest.advanceTimersByTime(115_000)
		}
		for (let index = 0; index < 10; index += 1) {
			await Promise.resolve()
		}

		//#then
		expect(abortCalls).toEqual([])
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("complete plan generation now")
	})

	it("waits for an extended quiet window before recovering a Prometheus turn that is still streaming delta-only planner output", async () => {
		//#given
		jest.useFakeTimers()
		const sessionID = "ses_planner_streaming_delta"
		const abortCalls: string[] = []
		const promptAsyncCalls: Array<Record<string, unknown>> = []
		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => {
							throw new Error("messages unavailable while streaming")
						},
						abort: async ({ path }: { path: { id: string } }) => {
							abortCalls.push(path.id)
							return {}
						},
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "message.updated",
				properties: {
					info: {
						id: "msg_assistant_streaming_delta",
						sessionID,
						role: "assistant",
						agent: "Prometheus (Plan Builder)",
					},
				},
			},
		} as any)
		await eventHandler({
			event: {
				type: "message.part.updated",
				properties: {
					part: {
						id: "part_step_streaming_delta",
						sessionID,
						messageID: "msg_assistant_streaming_delta",
						type: "step-start",
					},
				},
			},
		} as any)
		await eventHandler({
			event: {
				type: "message.part.updated",
				properties: {
					part: {
						id: "part_reasoning_streaming_delta",
						sessionID,
						messageID: "msg_assistant_streaming_delta",
						type: "reasoning",
						text: "",
					},
				},
			},
		} as any)
		await eventHandler({
			event: {
				type: "message.part.delta",
				properties: {
					sessionID,
					field: "text",
					delta: "Now I have a comprehensive picture of the current state.",
				},
			},
		} as any)
		const jestTimers = jest as unknown as { advanceTimersByTimeAsync?: (ms: number) => Promise<void> }
		if (typeof jestTimers.advanceTimersByTimeAsync === "function") {
			await jestTimers.advanceTimersByTimeAsync(5_000)
		} else {
			jest.advanceTimersByTime(5_000)
		}
		for (let index = 0; index < 10; index += 1) {
			await Promise.resolve()
		}
		expect(abortCalls).toEqual([])
		expect(promptAsyncCalls).toHaveLength(0)

		if (typeof jestTimers.advanceTimersByTimeAsync === "function") {
			await jestTimers.advanceTimersByTimeAsync(115_000)
		} else {
			jest.advanceTimersByTime(115_000)
		}
		for (let index = 0; index < 10; index += 1) {
			await Promise.resolve()
		}

		//#then
		expect(abortCalls).toEqual([])
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("complete plan generation now")
	})

	it("waits for an extended quiet window before recovering a Prometheus turn that only emitted internal planner parts", async () => {
		//#given
		jest.useFakeTimers()
		const sessionID = "ses_planner_internal_only"
		const abortCalls: string[] = []
		const promptAsyncCalls: Array<Record<string, unknown>> = []
		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => {
							throw new Error("messages unavailable while planner turn is active")
						},
						abort: async ({ path }: { path: { id: string } }) => {
							abortCalls.push(path.id)
							return {}
						},
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
				runtime_fallback: { enabled: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "message.updated",
				properties: {
					info: {
						id: "msg_assistant_internal_only",
						sessionID,
						role: "assistant",
						agent: "Prometheus (Plan Builder)",
					},
				},
			},
		} as any)
		await eventHandler({
			event: {
				type: "message.part.updated",
				properties: {
					part: {
						id: "part_step_internal_only",
						sessionID,
						messageID: "msg_assistant_internal_only",
						type: "step-start",
					},
				},
			},
		} as any)
		await eventHandler({
			event: {
				type: "message.part.updated",
				properties: {
					part: {
						id: "part_reasoning_internal_only",
						sessionID,
						messageID: "msg_assistant_internal_only",
						type: "reasoning",
						text: "",
					},
				},
			},
		} as any)
		const jestTimers = jest as unknown as { advanceTimersByTimeAsync?: (ms: number) => Promise<void> }
		if (typeof jestTimers.advanceTimersByTimeAsync === "function") {
			await jestTimers.advanceTimersByTimeAsync(5_000)
		} else {
			jest.advanceTimersByTime(5_000)
		}
		for (let index = 0; index < 10; index += 1) {
			await Promise.resolve()
		}
		expect(abortCalls).toEqual([])
		expect(promptAsyncCalls).toHaveLength(0)

		if (typeof jestTimers.advanceTimersByTimeAsync === "function") {
			await jestTimers.advanceTimersByTimeAsync(115_000)
		} else {
			jest.advanceTimersByTime(115_000)
		}
		for (let index = 0; index < 10; index += 1) {
			await Promise.resolve()
		}

		//#then
		expect(abortCalls).toEqual([])
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("complete plan generation now")
	})

	it("recovers an idle Prometheus turn that ended with finish-other visible text before the final plan write", async () => {
		//#given
		const sessionID = "ses_planner_interrupted_visible_turn"
		const promptAsyncCalls: Array<Record<string, unknown>> = []
		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									info: {
										id: "msg_user_visible_turn",
										role: "user",
										agent: "Prometheus (Plan Builder)",
										model: { providerID: "anthropic", modelID: "claude-opus-4-6" },
									},
									parts: [{ type: "text", text: "Generate the final plan" }],
								},
								{
									info: {
										id: "msg_assistant_visible_turn",
										role: "assistant",
										agent: "Prometheus (Plan Builder)",
										finish: "other",
									},
									parts: [
										{ type: "reasoning", text: "I should read the remaining draft and then write the final plan." },
										{ type: "text", text: "Let me read the remaining parts and the draf" },
										{ type: "step-finish", reason: "other" },
									],
								},
							],
						}),
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "session.status",
				properties: {
					sessionID,
					status: { type: "idle" },
				},
			},
		} as any)

		//#then
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("resume interrupted plan generation now")
	})

	it("recovers an idle Prometheus tool-only turn after a completed task call without user-facing text", async () => {
		//#given
		const sessionID = "ses_planner_tool_only_turn"
		const promptAsyncCalls: Array<Record<string, unknown>> = []
		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => ({
							data: [
								{
									info: {
										id: "msg_user_tool_only_turn",
										role: "user",
										agent: "Prometheus (Plan Builder)",
										model: { providerID: "openai", modelID: "gpt-5.4" },
									},
									parts: [{ type: "text", text: "Continue coordinating the plan after background agent updates." }],
								},
								{
									info: {
										id: "msg_assistant_tool_only_turn",
										role: "assistant",
										agent: "Prometheus (Plan Builder)",
										finish: "tool-calls",
									},
									parts: [
										{ type: "step-start" },
										{ type: "reasoning", text: "" },
										{
											type: "tool",
											tool: "task",
											state: {
												status: "completed",
												input: { description: "Retry approval workflow" },
												output: "Background task launched.\n\nBackground Task ID: bg_retry_approval\nDescription: Retry approval workflow",
											},
										},
										{ type: "step-finish", reason: "tool-calls" },
									],
								},
							],
						}),
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "session.status",
				properties: {
					sessionID,
					status: { type: "idle" },
				},
			},
		} as any)

		//#then
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("continue plan generation after the tool call now")
	})

	it("recovers a delayed empty Prometheus write call from cached part updates when session.messages is unavailable", async () => {
		//#given
		jest.useFakeTimers()
		const sessionID = "ses_cached_empty_write"
		const abortCalls: string[] = []
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => {
							throw new Error("messages unavailable while streaming")
						},
						abort: async ({ path }: { path: { id: string } }) => {
							abortCalls.push(path.id)
							return {}
						},
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "message.updated",
				properties: {
					info: {
						id: "msg_assistant_cached_empty_write",
						sessionID,
						role: "assistant",
						agent: "Prometheus (Plan Builder)",
					},
				},
			},
		} as any)
		await eventHandler({
			event: {
				type: "message.part.updated",
				properties: {
					part: {
						id: "part_tool",
						sessionID,
						messageID: "msg_assistant_cached_empty_write",
						type: "tool",
						tool: "write",
						raw: "",
						state: { status: "pending", input: {} },
					},
				},
			},
		} as any)
		const jestTimers = jest as unknown as { advanceTimersByTimeAsync?: (ms: number) => Promise<void> }
		if (typeof jestTimers.advanceTimersByTimeAsync === "function") {
			await jestTimers.advanceTimersByTimeAsync(5_000)
		} else {
			jest.advanceTimersByTime(5_000)
		}
		for (let index = 0; index < 10; index += 1) {
			await Promise.resolve()
		}

		//#then
		expect(abortCalls).toEqual([sessionID])
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("previous planning tool call was emitted without the required arguments")
	})

	it("re-arms delayed recovery when an empty Prometheus write call arrives after the original timer window", async () => {
		//#given
		jest.useFakeTimers()
		const sessionID = "ses_cached_empty_write_late_part"
		const abortCalls: string[] = []
		const promptAsyncCalls: Array<Record<string, unknown>> = []

		const eventHandler = createEventHandler({
			ctx: {
				directory: "/tmp",
				client: {
					session: {
						messages: async () => {
							throw new Error("messages unavailable while streaming")
						},
						abort: async ({ path }: { path: { id: string } }) => {
							abortCalls.push(path.id)
							return {}
						},
						promptAsync: async (input: Record<string, unknown>) => {
							promptAsyncCalls.push(input)
							return {}
						},
					},
				},
			} as any,
			pluginConfig: {
				experimental: { auto_resume: true },
			} as any,
			firstMessageVariantGate: {
				markSessionCreated: () => {},
				clear: () => {},
			},
			managers: {
				tmuxSessionManager: {
					onSessionCreated: async () => {},
					onSessionDeleted: async () => {},
				},
			} as any,
			hooks: {
				stopContinuationGuard: { isStopped: () => false },
			} as any,
		})

		//#when
		await eventHandler({
			event: {
				type: "message.updated",
				properties: {
					info: {
						id: "msg_assistant_cached_empty_write_late_part",
						sessionID,
						role: "assistant",
						agent: "Prometheus (Plan Builder)",
					},
				},
			},
		} as any)
		const jestTimers = jest as unknown as { advanceTimersByTimeAsync?: (ms: number) => Promise<void> }
		if (typeof jestTimers.advanceTimersByTimeAsync === "function") {
			await jestTimers.advanceTimersByTimeAsync(5_000)
		} else {
			jest.advanceTimersByTime(5_000)
		}
		for (let index = 0; index < 10; index += 1) {
			await Promise.resolve()
		}
		await eventHandler({
			event: {
				type: "message.part.updated",
				properties: {
					part: {
						id: "part_tool_late",
						sessionID,
						messageID: "msg_assistant_cached_empty_write_late_part",
						type: "tool",
						tool: "write",
						raw: "",
						state: { status: "pending", input: {} },
					},
				},
			},
		} as any)
		if (typeof jestTimers.advanceTimersByTimeAsync === "function") {
			await jestTimers.advanceTimersByTimeAsync(5_000)
		} else {
			jest.advanceTimersByTime(5_000)
		}
		for (let index = 0; index < 10; index += 1) {
			await Promise.resolve()
		}

		//#then
		expect(abortCalls).toEqual([sessionID])
		expect(promptAsyncCalls).toHaveLength(1)
		const promptBody = promptAsyncCalls[0]?.body as { parts?: Array<{ text?: string }> } | undefined
		expect(promptBody?.parts?.[0]?.text).toContain("previous planning tool call was emitted without the required arguments")
	})
})
