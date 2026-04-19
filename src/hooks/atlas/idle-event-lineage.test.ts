import { afterEach, beforeEach, describe, it } from "bun:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearBoulderState, readBoulderState, writeBoulderState } from "../../features/boulder-state"
import type { BoulderState } from "../../features/boulder-state"
import {
  _resetForTesting,
  registerAgentName,
  setSessionAgent,
  subagentSessions,
  syncSubagentSessions,
} from "../../features/claude-code-session-state"

const { createAtlasHook } = await import("./index")

describe("atlas hook idle-event session lineage", () => {
  const MAIN_SESSION_ID = "main-session-123"

  let testDirectory = ""
  let promptCalls: Array<unknown> = []

  function writeIncompleteBoulder(overrides: Partial<BoulderState> = {}): void {
    const planPath = join(testDirectory, "test-plan.md")
    writeFileSync(planPath, "# Plan\n- [ ] Task 1\n- [ ] Task 2")

    const state: BoulderState = {
      active_plan: planPath,
      started_at: "2026-01-02T10:00:00Z",
      session_ids: [MAIN_SESSION_ID],
      plan_name: "test-plan",
      ...overrides,
    }

    writeBoulderState(testDirectory, state)
  }

  function createHook(parentSessionIDs?: Record<string, string | undefined>) {
    return createAtlasHook({
      directory: testDirectory,
      client: {
        session: {
          get: async (input: { path: { id: string } }) => ({
            data: {
              parentID: parentSessionIDs?.[input.path.id],
            },
          }),
          messages: async () => ({ data: [] }),
          prompt: async (input: unknown) => {
            promptCalls.push(input)
            return { data: {} }
          },
          promptAsync: async (input: unknown) => {
            promptCalls.push(input)
            return { data: {} }
          },
        },
      },
    } as unknown as Parameters<typeof createAtlasHook>[0])
  }

  beforeEach(() => {
    testDirectory = join(tmpdir(), `atlas-idle-lineage-${randomUUID()}`)
    if (!existsSync(testDirectory)) {
      mkdirSync(testDirectory, { recursive: true })
    }

    promptCalls = []
    clearBoulderState(testDirectory)
    _resetForTesting()
    registerAgentName("atlas")
    registerAgentName("sisyphus")
    subagentSessions.clear()
    syncSubagentSessions.clear()
  })

  afterEach(() => {
    clearBoulderState(testDirectory)
    if (existsSync(testDirectory)) {
      rmSync(testDirectory, { recursive: true, force: true })
    }

    _resetForTesting()
  })

  it("does not append unrelated subagent sessions during idle", async () => {
    const unrelatedSubagentSessionID = "subagent-session-unrelated"
    const unrelatedParentSessionID = "unrelated-parent-session"

    writeIncompleteBoulder()
    subagentSessions.add(unrelatedSubagentSessionID)

    const hook = createHook({
      [unrelatedSubagentSessionID]: unrelatedParentSessionID,
    })

    await hook.handler({
      event: {
        type: "session.idle",
        properties: { sessionID: unrelatedSubagentSessionID },
      },
    })

    assert.equal(readBoulderState(testDirectory)?.session_ids.includes(unrelatedSubagentSessionID), false)
    assert.equal(promptCalls.length, 0)
  })

  it("appends boulder-owned subagent sessions during idle when lineage reaches tracked session", async () => {
    const subagentSessionID = "subagent-session-456"
    const intermediateParentSessionID = "subagent-parent-789"

    writeIncompleteBoulder()
    subagentSessions.add(subagentSessionID)
    setSessionAgent(subagentSessionID, "atlas")

    const hook = createHook({
      [subagentSessionID]: intermediateParentSessionID,
      [intermediateParentSessionID]: MAIN_SESSION_ID,
    })

    await hook.handler({
      event: {
        type: "session.idle",
        properties: { sessionID: subagentSessionID },
      },
    })

    assert.equal(readBoulderState(testDirectory)?.session_ids.includes(subagentSessionID), true)
    assert.equal(promptCalls.length, 1)
  })

  it("does not inject continuation for boulder-lineage subagent with non-matching agent", async () => {
    const subagentSessionID = "subagent-session-agent-mismatch"

    writeIncompleteBoulder({ agent: "atlas" })
    subagentSessions.add(subagentSessionID)
    setSessionAgent(subagentSessionID, "sisyphus-junior")

    const hook = createHook({
      [subagentSessionID]: MAIN_SESSION_ID,
    })

    await hook.handler({
      event: {
        type: "session.idle",
        properties: { sessionID: subagentSessionID },
      },
    })

    assert.equal(readBoulderState(testDirectory)?.session_ids.includes(subagentSessionID), false)
    assert.equal(promptCalls.length, 0)
  })

  it("does not append or inject for sync subagent sessions in boulder lineage", async () => {
    const subagentSessionID = "sync-subagent-session"

    writeIncompleteBoulder({ agent: "atlas" })
    subagentSessions.add(subagentSessionID)
    syncSubagentSessions.add(subagentSessionID)
    setSessionAgent(subagentSessionID, "atlas")

    const hook = createHook({
      [subagentSessionID]: MAIN_SESSION_ID,
    })

    await hook.handler({
      event: {
        type: "session.idle",
        properties: { sessionID: subagentSessionID },
      },
    })

    assert.equal(readBoulderState(testDirectory)?.session_ids.includes(subagentSessionID), false)
    assert.equal(promptCalls.length, 0)
  })

  it("does not inject continuation for already-tracked sync subagent sessions", async () => {
    const subagentSessionID = "tracked-sync-subagent-session"

    writeIncompleteBoulder({
      agent: "atlas",
      session_ids: [MAIN_SESSION_ID, subagentSessionID],
    })
    subagentSessions.add(subagentSessionID)
    syncSubagentSessions.add(subagentSessionID)
    setSessionAgent(subagentSessionID, "atlas")

    const hook = createHook({
      [subagentSessionID]: MAIN_SESSION_ID,
    })

    await hook.handler({
      event: {
        type: "session.idle",
        properties: { sessionID: subagentSessionID },
      },
    })

    assert.equal(promptCalls.length, 0)
  })

  it("injects continuation for boulder-lineage subagent with matching agent", async () => {
    const subagentSessionID = "subagent-session-agent-match"

    writeIncompleteBoulder({ agent: "atlas" })
    subagentSessions.add(subagentSessionID)
    setSessionAgent(subagentSessionID, "atlas")

    const hook = createHook({
      [subagentSessionID]: MAIN_SESSION_ID,
    })

    await hook.handler({
      event: {
        type: "session.idle",
        properties: { sessionID: subagentSessionID },
      },
    })

    assert.equal(promptCalls.length, 1)
  })

  it("injects continuation for explicitly tracked boulder session regardless of agent", async () => {
    writeIncompleteBoulder({ agent: "atlas" })
    setSessionAgent(MAIN_SESSION_ID, "hephaestus")

    const hook = createHook()

    await hook.handler({
      event: {
        type: "session.idle",
        properties: { sessionID: MAIN_SESSION_ID },
      },
    })

    assert.equal(promptCalls.length, 1)
  })

  it("does not treat checked tasks with missing evidence as boulder complete during idle", async () => {
    const planPath = join(testDirectory, ".sisyphus", "plans", "evidence-gated-plan.md")
    mkdirSync(join(testDirectory, ".sisyphus", "plans"), { recursive: true })
    writeFileSync(planPath, `# Plan

## TODOs
- [x] 24. Zero-missing QA rerun
  - Evidence: .sisyphus/evidence/task-24-zero-missing.txt
`)

    const state: BoulderState = {
      active_plan: planPath,
      started_at: "2026-01-02T10:00:00Z",
      session_ids: [MAIN_SESSION_ID],
      plan_name: "evidence-gated-plan",
      agent: "atlas",
    }
    writeBoulderState(testDirectory, state)
    setSessionAgent(MAIN_SESSION_ID, "atlas")

    const hook = createHook()

    await hook.handler({
      event: {
        type: "session.idle",
        properties: { sessionID: MAIN_SESSION_ID },
      },
    })

    assert.equal(promptCalls.length, 1)
  })
})
