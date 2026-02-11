/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BackgroundManager } from "../../features/background-agent"
import { readInbox } from "./inbox-store"
import { createAgentTeamsTools } from "./tools"

interface TestToolContext {
  sessionID: string
  messageID: string
  agent: string
  abort: AbortSignal
}

interface ResumeCall {
  sessionId: string
  prompt: string
}

function createContext(sessionID = "ses-main"): TestToolContext {
  return {
    sessionID,
    messageID: "msg-main",
    agent: "sisyphus",
    abort: new AbortController().signal,
  }
}

async function executeJsonTool(
  tools: ReturnType<typeof createAgentTeamsTools>,
  toolName: keyof ReturnType<typeof createAgentTeamsTools>,
  args: Record<string, unknown>,
  context: TestToolContext,
): Promise<unknown> {
  const output = await tools[toolName].execute(args, context)
  return JSON.parse(output)
}

function uniqueTeam(): string {
  return `msg-${randomUUID().slice(0, 8)}`
}

function createMockManager(): { manager: BackgroundManager; resumeCalls: ResumeCall[] } {
  const resumeCalls: ResumeCall[] = []
  let launchCount = 0

  const manager = {
    launch: async () => {
      launchCount += 1
      return { id: `bg-${launchCount}`, sessionID: `ses-worker-${launchCount}` }
    },
    getTask: () => undefined,
    resume: async (args: ResumeCall) => {
      resumeCalls.push(args)
      return { id: `resume-${resumeCalls.length}` }
    },
  } as unknown as BackgroundManager

  return { manager, resumeCalls }
}

async function setupTeamWithWorker(
  tools: ReturnType<typeof createAgentTeamsTools>,
  context: TestToolContext,
  teamName = "core",
  workerName = "worker_1",
): Promise<void> {
  await executeJsonTool(tools, "team_create", { team_name: teamName }, context)
  await executeJsonTool(
    tools,
    "spawn_teammate",
    { team_name: teamName, name: workerName, prompt: "Handle tasks", category: "quick" },
    context,
  )
}

describe("agent-teams messaging tools", () => {
  let originalCwd: string
  let tempProjectDir: string

  beforeEach(() => {
    originalCwd = process.cwd()
    tempProjectDir = mkdtempSync(join(tmpdir(), "agent-teams-messaging-"))
    process.chdir(tempProjectDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    rmSync(tempProjectDir, { recursive: true, force: true })
  })

  describe("message type", () => {
    test("delivers message to recipient inbox", async () => {
      //#given
      const tn = uniqueTeam()
      const { manager } = createMockManager()
      const tools = createAgentTeamsTools(manager)
      const leadContext = createContext()
      await setupTeamWithWorker(tools, leadContext, tn)

      //#when
      const result = await executeJsonTool(
        tools,
        "send_message",
        {
          team_name: tn,
          type: "message",
          recipient: "worker_1",
          content: "Please update status.",
          summary: "status_request",
        },
        leadContext,
      ) as { success?: boolean; message?: string }

      //#then
      expect(result.success).toBe(true)
      expect(result.message).toBe("message_sent:worker_1")
      const inbox = readInbox(tn, "worker_1")
      const delivered = inbox.filter((m) => m.summary === "status_request")
      expect(delivered.length).toBeGreaterThanOrEqual(1)
      expect(delivered[0]?.sender).toBe("team-lead")
      expect(delivered[0]?.content).toBe("Please update status.")
    })

    test("rejects message to nonexistent recipient", async () => {
      //#given
      const tn = uniqueTeam()
      const { manager } = createMockManager()
      const tools = createAgentTeamsTools(manager)
      const leadContext = createContext()
      await setupTeamWithWorker(tools, leadContext, tn)

      //#when
      const result = await executeJsonTool(
        tools,
        "send_message",
        { team_name: tn, type: "message", recipient: "nonexistent", content: "hello", summary: "test" },
        leadContext,
      ) as { error?: string }

      //#then
      expect(result.error).toBe("message_recipient_not_found")
    })

    test("rejects recipient with team suffix mismatch", async () => {
      //#given
      const tn = uniqueTeam()
      const { manager, resumeCalls } = createMockManager()
      const tools = createAgentTeamsTools(manager)
      const leadContext = createContext()
      await setupTeamWithWorker(tools, leadContext, tn)

      //#when
      const result = await executeJsonTool(
        tools,
        "send_message",
        { team_name: tn, type: "message", recipient: "worker_1@other-team", summary: "sync", content: "hi" },
        leadContext,
      ) as { error?: string }

      //#then
      expect(result.error).toBe("recipient_team_mismatch")
      expect(resumeCalls).toHaveLength(0)
    })

    test("rejects recipient with empty team suffix", async () => {
      //#given
      const tn = uniqueTeam()
      const { manager, resumeCalls } = createMockManager()
      const tools = createAgentTeamsTools(manager)
      const leadContext = createContext()
      await setupTeamWithWorker(tools, leadContext, tn)

      //#when
      const result = await executeJsonTool(
        tools,
        "send_message",
        { team_name: tn, type: "message", recipient: "worker_1@", summary: "sync", content: "hi" },
        leadContext,
      ) as { error?: string }

      //#then
      expect(result.error).toBe("recipient_team_invalid")
      expect(resumeCalls).toHaveLength(0)
    })
  })

  describe("broadcast type", () => {
    test("writes to all teammate inboxes", async () => {
      //#given
      const tn = uniqueTeam()
      const { manager } = createMockManager()
      const tools = createAgentTeamsTools(manager)
      const leadContext = createContext()
      await executeJsonTool(tools, "team_create", { team_name: tn }, leadContext)
      for (const name of ["worker_1", "worker_2"]) {
        await executeJsonTool(
          tools,
          "spawn_teammate",
          { team_name: tn, name, prompt: "Handle tasks", category: "quick" },
          leadContext,
        )
      }

      //#when
      const result = await executeJsonTool(
        tools,
        "send_message",
        { team_name: tn, type: "broadcast", summary: "sync", content: "Status update needed" },
        leadContext,
      ) as { success?: boolean; message?: string }

      //#then
      expect(result.success).toBe(true)
      expect(result.message).toBe("broadcast_sent:2")
      for (const name of ["worker_1", "worker_2"]) {
        const inbox = readInbox(tn, name)
        const broadcastMessages = inbox.filter((m) => m.summary === "sync")
        expect(broadcastMessages.length).toBeGreaterThanOrEqual(1)
      }
    })

    test("rejects broadcast without summary", async () => {
      //#given
      const tn = uniqueTeam()
      const { manager } = createMockManager()
      const tools = createAgentTeamsTools(manager)
      const leadContext = createContext()
      await setupTeamWithWorker(tools, leadContext, tn)

      //#when
      const result = await executeJsonTool(
        tools,
        "send_message",
        { team_name: tn, type: "broadcast", content: "hello" },
        leadContext,
      ) as { error?: string }

      //#then
      expect(result.error).toBe("broadcast_requires_summary")
    })
  })

  describe("shutdown_request type", () => {
    test("sends shutdown request and returns request_id", async () => {
      //#given
      const tn = uniqueTeam()
      const { manager } = createMockManager()
      const tools = createAgentTeamsTools(manager)
      const leadContext = createContext()
      await setupTeamWithWorker(tools, leadContext, tn)

      //#when
      const result = await executeJsonTool(
        tools,
        "send_message",
        { team_name: tn, type: "shutdown_request", recipient: "worker_1", content: "Work completed" },
        leadContext,
      ) as { success?: boolean; request_id?: string; target?: string }

      //#then
      expect(result.success).toBe(true)
      expect(result.request_id).toMatch(/^shutdown-worker_1-/)
      expect(result.target).toBe("worker_1")
    })

    test("rejects shutdown targeting team-lead", async () => {
      //#given
      const tn = uniqueTeam()
      const { manager } = createMockManager()
      const tools = createAgentTeamsTools(manager)
      const leadContext = createContext()
      await setupTeamWithWorker(tools, leadContext, tn)

      //#when
      const result = await executeJsonTool(
        tools,
        "send_message",
        { team_name: tn, type: "shutdown_request", recipient: "team-lead" },
        leadContext,
      ) as { error?: string }

      //#then
      expect(result.error).toBe("cannot_shutdown_team_lead")
    })
  })

  describe("shutdown_response type", () => {
    test("sends approved shutdown response to team-lead inbox", async () => {
      //#given
      const tn = uniqueTeam()
      const { manager } = createMockManager()
      const tools = createAgentTeamsTools(manager)
      const leadContext = createContext()
      await setupTeamWithWorker(tools, leadContext, tn)

      //#when
      const result = await executeJsonTool(
        tools,
        "send_message",
        { team_name: tn, type: "shutdown_response", request_id: "shutdown-worker_1-abc12345", approve: true },
        leadContext,
      ) as { success?: boolean; message?: string }

      //#then
      expect(result.success).toBe(true)
      expect(result.message).toBe("shutdown_approved:shutdown-worker_1-abc12345")
      const leadInbox = readInbox(tn, "team-lead")
      const shutdownMessages = leadInbox.filter((m) => m.summary === "shutdown_approved")
      expect(shutdownMessages.length).toBeGreaterThanOrEqual(1)
    })

    test("sends rejected shutdown response", async () => {
      //#given
      const tn = uniqueTeam()
      const { manager } = createMockManager()
      const tools = createAgentTeamsTools(manager)
      const leadContext = createContext()
      await setupTeamWithWorker(tools, leadContext, tn)

      //#when
      const result = await executeJsonTool(
        tools,
        "send_message",
        {
          team_name: tn,
          type: "shutdown_response",
          request_id: "shutdown-worker_1-abc12345",
          approve: false,
          content: "Still working on it",
        },
        leadContext,
      ) as { success?: boolean; message?: string }

      //#then
      expect(result.success).toBe(true)
      expect(result.message).toBe("shutdown_rejected:shutdown-worker_1-abc12345")
    })
  })

  describe("plan_approval_response type", () => {
    test("sends approved plan response", async () => {
      //#given
      const tn = uniqueTeam()
      const { manager } = createMockManager()
      const tools = createAgentTeamsTools(manager)
      const leadContext = createContext()
      await setupTeamWithWorker(tools, leadContext, tn)

      //#when
      const result = await executeJsonTool(
        tools,
        "send_message",
        { team_name: tn, type: "plan_approval_response", request_id: "plan-req-001", approve: true, recipient: "worker_1" },
        leadContext,
      ) as { success?: boolean; message?: string }

      //#then
      expect(result.success).toBe(true)
      expect(result.message).toBe("plan_approved:worker_1")
    })

    test("sends rejected plan response with content", async () => {
      //#given
      const tn = uniqueTeam()
      const { manager } = createMockManager()
      const tools = createAgentTeamsTools(manager)
      const leadContext = createContext()
      await setupTeamWithWorker(tools, leadContext, tn)

      //#when
      const result = await executeJsonTool(
        tools,
        "send_message",
        {
          team_name: tn,
          type: "plan_approval_response",
          request_id: "plan-req-002",
          approve: false,
          recipient: "worker_1",
          content: "Need more details",
        },
        leadContext,
      ) as { success?: boolean; message?: string }

      //#then
      expect(result.success).toBe(true)
      expect(result.message).toBe("plan_rejected:worker_1")
    })
  })

  describe("authorization", () => {
    test("rejects message from unauthorized session", async () => {
      //#given
      const tn = uniqueTeam()
      const { manager } = createMockManager()
      const tools = createAgentTeamsTools(manager)
      const leadContext = createContext()
      await setupTeamWithWorker(tools, leadContext, tn)

      //#when
      const result = await executeJsonTool(
        tools,
        "send_message",
        { team_name: tn, type: "message", recipient: "worker_1", content: "hello", summary: "test" },
        createContext("ses-intruder"),
      ) as { error?: string }

      //#then
      expect(result.error).toBe("unauthorized_sender_session")
    })

    test("rejects message to nonexistent team", async () => {
      //#given
      const { manager } = createMockManager()
      const tools = createAgentTeamsTools(manager)

      //#when
      const result = await executeJsonTool(
        tools,
        "send_message",
        { team_name: "nonexistent-xyz", type: "message", recipient: "w", content: "hello", summary: "test" },
        createContext(),
      ) as { error?: string }

      //#then
      expect(result.error).toBe("team_not_found")
    })
  })
})
