import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import {
  readBoulderState,
  writeBoulderState,
  appendSessionId,
  clearBoulderState,
  getBoulderWorktreePath,
  getPlanProgress,
  getPlanName,
  createBoulderState,
  findPrometheusPlans,
  getTaskSessionState,
  resolveBoulderExecutionDirectory,
  upsertTaskSessionState,
  clearTaskSessionState,
} from "./storage"
import type { BoulderState } from "./types"
import { readCurrentTopLevelTask } from "./top-level-task"

describe("boulder-state", () => {
  const TEST_DIR = join(tmpdir(), "boulder-state-test-" + Date.now())
  const SISYPHUS_DIR = join(TEST_DIR, ".sisyphus")

  beforeEach(() => {
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true })
    }
    if (!existsSync(SISYPHUS_DIR)) {
      mkdirSync(SISYPHUS_DIR, { recursive: true })
    }
    clearBoulderState(TEST_DIR)
  })

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true })
    }
  })

  describe("readBoulderState", () => {
    test("should return null when no boulder.json exists", () => {
      // given - no boulder.json file
      // when
      const result = readBoulderState(TEST_DIR)
      // then
      expect(result).toBeNull()
    })

    test("should return null for JSON null value", () => {
      //#given - boulder.json containing null
      const boulderFile = join(SISYPHUS_DIR, "boulder.json")
      writeFileSync(boulderFile, "null")

      //#when
      const result = readBoulderState(TEST_DIR)

      //#then
      expect(result).toBeNull()
    })

    test("should return null for JSON primitive value", () => {
      //#given - boulder.json containing a string
      const boulderFile = join(SISYPHUS_DIR, "boulder.json")
      writeFileSync(boulderFile, '"just a string"')

      //#when
      const result = readBoulderState(TEST_DIR)

      //#then
      expect(result).toBeNull()
    })

    test("should default session_ids to [] when missing from JSON", () => {
      //#given - boulder.json without session_ids field
      const boulderFile = join(SISYPHUS_DIR, "boulder.json")
      writeFileSync(boulderFile, JSON.stringify({
        active_plan: "/path/to/plan.md",
        started_at: "2026-01-01T00:00:00Z",
        plan_name: "plan",
      }))

      //#when
      const result = readBoulderState(TEST_DIR)

      //#then
      expect(result).not.toBeNull()
      expect(result!.session_ids).toEqual([])
    })

    test("should default session_ids to [] when not an array", () => {
      //#given - boulder.json with session_ids as a string
      const boulderFile = join(SISYPHUS_DIR, "boulder.json")
      writeFileSync(boulderFile, JSON.stringify({
        active_plan: "/path/to/plan.md",
        started_at: "2026-01-01T00:00:00Z",
        session_ids: "not-an-array",
        plan_name: "plan",
      }))

      //#when
      const result = readBoulderState(TEST_DIR)

      //#then
      expect(result).not.toBeNull()
      expect(result!.session_ids).toEqual([])
    })

    test("should default session_ids to [] for empty object", () => {
      //#given - boulder.json with empty object
      const boulderFile = join(SISYPHUS_DIR, "boulder.json")
      writeFileSync(boulderFile, JSON.stringify({}))

      //#when
      const result = readBoulderState(TEST_DIR)

      //#then
      expect(result).not.toBeNull()
      expect(result!.session_ids).toEqual([])
    })

    test("should read valid boulder state", () => {
      // given - valid boulder.json
      const state: BoulderState = {
        active_plan: "/path/to/plan.md",
        started_at: "2026-01-02T10:00:00Z",
        session_ids: ["session-1", "session-2"],
        plan_name: "my-plan",
      }
      writeBoulderState(TEST_DIR, state)

      // when
      const result = readBoulderState(TEST_DIR)

      // then
      expect(result).not.toBeNull()
      expect(result?.active_plan).toBe("/path/to/plan.md")
      expect(result?.session_ids).toEqual(["session-1", "session-2"])
      expect(result?.plan_name).toBe("plan")
    })

    test("should default task_sessions to empty object when missing from JSON", () => {
      // given - boulder.json without task_sessions field
      const boulderFile = join(SISYPHUS_DIR, "boulder.json")
      writeFileSync(boulderFile, JSON.stringify({
        active_plan: "/path/to/plan.md",
        started_at: "2026-01-01T00:00:00Z",
        session_ids: ["session-1"],
        plan_name: "plan",
      }))

      // when
      const result = readBoulderState(TEST_DIR)

      // then
      expect(result).not.toBeNull()
      expect(result!.task_sessions).toEqual({})
    })

    test("should clear stale task_sessions when active_plan and plan_name disagree", () => {
      // given - a mismatched boulder state copied from another plan/worktree
      const boulderFile = join(SISYPHUS_DIR, "boulder.json")
      writeFileSync(boulderFile, JSON.stringify({
        active_plan: "/Users/redff00xx/eurochemeopt-hotfix-4797/.sisyphus/plans/ci-green-builds.md",
        started_at: "2026-01-01T00:00:00Z",
        session_ids: ["session-1"],
        plan_name: "ci-green-playwright-parity",
        task_sessions: {
          "todo:6": {
            task_key: "todo:6",
            task_label: "6",
            task_title: "Old task from another plan",
            session_id: "ses_old_task",
            updated_at: "2026-01-01T00:00:00Z",
          },
        },
      }))

      // when
      const result = readBoulderState(TEST_DIR)

      // then
      expect(result).not.toBeNull()
      expect(result?.plan_name).toBe("ci-green-builds")
      expect(result?.task_sessions).toEqual({})
    })
  })

  describe("writeBoulderState", () => {
    test("should write state and create .sisyphus directory if needed", () => {
      // given - state to write
      const state: BoulderState = {
        active_plan: "/test/plan.md",
        started_at: "2026-01-02T12:00:00Z",
        session_ids: ["ses-123"],
        plan_name: "test-plan",
      }

      // when
      const success = writeBoulderState(TEST_DIR, state)
      const readBack = readBoulderState(TEST_DIR)

      // then
      expect(success).toBe(true)
      expect(readBack).not.toBeNull()
      expect(readBack?.active_plan).toBe("/test/plan.md")
    })
  })

  describe("appendSessionId", () => {
    test("should append new session id to existing state", () => {
      // given - existing state with one session
      const state: BoulderState = {
        active_plan: "/plan.md",
        started_at: "2026-01-02T10:00:00Z",
        session_ids: ["session-1"],
        plan_name: "plan",
      }
      writeBoulderState(TEST_DIR, state)

      // when
      const result = appendSessionId(TEST_DIR, "session-2")

      // then
      expect(result).not.toBeNull()
      expect(result?.session_ids).toEqual(["session-1", "session-2"])
    })

    test("should not duplicate existing session id", () => {
      // given - state with session-1 already
      const state: BoulderState = {
        active_plan: "/plan.md",
        started_at: "2026-01-02T10:00:00Z",
        session_ids: ["session-1"],
        plan_name: "plan",
      }
      writeBoulderState(TEST_DIR, state)

      // when
      appendSessionId(TEST_DIR, "session-1")
      const result = readBoulderState(TEST_DIR)

      // then
      expect(result?.session_ids).toEqual(["session-1"])
    })

    test("should return null when no state exists", () => {
      // given - no boulder.json
      // when
      const result = appendSessionId(TEST_DIR, "new-session")
      // then
      expect(result).toBeNull()
    })

    test("should not crash when boulder.json has no session_ids field", () => {
      //#given - boulder.json without session_ids
      const boulderFile = join(SISYPHUS_DIR, "boulder.json")
      writeFileSync(boulderFile, JSON.stringify({
        active_plan: "/plan.md",
        started_at: "2026-01-01T00:00:00Z",
        plan_name: "plan",
      }))

      //#when
      const result = appendSessionId(TEST_DIR, "ses-new")

      //#then - should not crash and should contain the new session
      expect(result).not.toBeNull()
      expect(result!.session_ids).toContain("ses-new")
    })
  })

  describe("clearBoulderState", () => {
    test("should remove boulder.json", () => {
      // given - existing state
      const state: BoulderState = {
        active_plan: "/plan.md",
        started_at: "2026-01-02T10:00:00Z",
        session_ids: ["session-1"],
        plan_name: "plan",
      }
      writeBoulderState(TEST_DIR, state)

      // when
      const success = clearBoulderState(TEST_DIR)
      const result = readBoulderState(TEST_DIR)

      // then
      expect(success).toBe(true)
      expect(result).toBeNull()
    })

    test("should succeed even when no file exists", () => {
      // given - no boulder.json
      // when
      const success = clearBoulderState(TEST_DIR)
      // then
      expect(success).toBe(true)
    })
  })

  describe("task session state", () => {
    test("should persist and read preferred session for a top-level plan task", () => {
      // given - existing boulder state
      const state: BoulderState = {
        active_plan: "/plan.md",
        started_at: "2026-01-02T10:00:00Z",
        session_ids: ["session-1"],
        plan_name: "plan",
      }
      writeBoulderState(TEST_DIR, state)

      // when
      upsertTaskSessionState(TEST_DIR, {
        taskKey: "todo:1",
        taskLabel: "1",
        taskTitle: "Implement auth flow",
        sessionId: "ses_task_123",
        agent: "sisyphus-junior",
        category: "deep",
      })
      const result = getTaskSessionState(TEST_DIR, "todo:1")

      // then
      expect(result).not.toBeNull()
      expect(result?.session_id).toBe("ses_task_123")
      expect(result?.task_title).toBe("Implement auth flow")
      expect(result?.agent).toBe("sisyphus-junior")
      expect(result?.category).toBe("deep")
    })

    test("should overwrite preferred session for the same top-level plan task", () => {
      // given - existing boulder state with prior preferred session
      const state: BoulderState = {
        active_plan: "/plan.md",
        started_at: "2026-01-02T10:00:00Z",
        session_ids: ["session-1"],
        plan_name: "plan",
        task_sessions: {
          "todo:1": {
            task_key: "todo:1",
            task_label: "1",
            task_title: "Implement auth flow",
            session_id: "ses_old",
            updated_at: "2026-01-02T10:00:00Z",
          },
        },
      }
      writeBoulderState(TEST_DIR, state)

      // when
      upsertTaskSessionState(TEST_DIR, {
        taskKey: "todo:1",
        taskLabel: "1",
        taskTitle: "Implement auth flow",
        sessionId: "ses_new",
      })
      const result = getTaskSessionState(TEST_DIR, "todo:1")

      // then
      expect(result?.session_id).toBe("ses_new")
    })

    test("should clear the preferred session for a top-level plan task", () => {
      const state: BoulderState = {
        active_plan: "/plan.md",
        started_at: "2026-01-02T10:00:00Z",
        session_ids: ["session-1"],
        plan_name: "plan",
        task_sessions: {
          "todo:1": {
            task_key: "todo:1",
            task_label: "1",
            task_title: "Implement auth flow",
            session_id: "ses_old",
            updated_at: "2026-01-02T10:00:00Z",
          },
        },
      }
      writeBoulderState(TEST_DIR, state)

      clearTaskSessionState(TEST_DIR, "todo:1")

      expect(getTaskSessionState(TEST_DIR, "todo:1")).toBeNull()
    })
  })

  describe("readCurrentTopLevelTask", () => {
    test("should return the first unchecked top-level task in TODOs", () => {
      // given - plan with nested and top-level unchecked tasks
      const planPath = join(TEST_DIR, "current-task-plan.md")
      writeFileSync(planPath, `# Plan

## TODOs
- [x] 1. Finished task
  - [ ] nested acceptance checkbox
- [ ] 2. Current task

## Final Verification Wave
- [ ] F1. Final review
`)

      // when
      const result = readCurrentTopLevelTask(planPath)

      // then
      expect(result).not.toBeNull()
      expect(result?.key).toBe("todo:2")
      expect(result?.title).toBe("Current task")
    })

    test("should fall back to final-wave task when implementation tasks are complete", () => {
      // given - plan with only final-wave work remaining
      const planPath = join(TEST_DIR, "final-wave-current-task-plan.md")
      writeFileSync(planPath, `# Plan

## TODOs
- [x] 1. Finished task

## Final Verification Wave
- [ ] F1. Final review
`)

      // when
      const result = readCurrentTopLevelTask(planPath)

      // then
      expect(result).not.toBeNull()
      expect(result?.key).toBe("final-wave:f1")
      expect(result?.title).toBe("Final review")
    })
  })

  describe("getPlanProgress", () => {
    test("should count completed and uncompleted top-level checkboxes", () => {
      // given - plan file with checkboxes
      const planPath = join(TEST_DIR, "test-plan.md")
      writeFileSync(planPath, `# Plan
- [ ] Task 1
- [x] Task 2  
- [ ] Task 3
- [X] Task 4
`)

      // when
      const progress = getPlanProgress(planPath)

      // then
      expect(progress.total).toBe(4)
      expect(progress.completed).toBe(2)
      expect(progress.isComplete).toBe(false)
    })

    test("should ignore space-indented checkbox entries", () => {
      // given - plan file with a two-space indented checkbox
      const planPath = join(TEST_DIR, "space-indented-plan.md")
      writeFileSync(planPath, `# Plan
  - [ ] indented task
`)

      // when
      const progress = getPlanProgress(planPath)

      // then
      expect(progress.total).toBe(0)
      expect(progress.completed).toBe(0)
      expect(progress.isComplete).toBe(false)
    })

    test("should ignore tab-indented checkbox entries", () => {
      // given - plan file with a tab-indented checkbox
      const planPath = join(TEST_DIR, "tab-indented-plan.md")
      writeFileSync(planPath, `# Plan
	- [ ] tab-indented task
`)

      // when
      const progress = getPlanProgress(planPath)

      // then
      expect(progress.total).toBe(0)
      expect(progress.completed).toBe(0)
      expect(progress.isComplete).toBe(false)
    })

    test("should ignore nested checklist items when a top-level task exists", () => {
      // given - plan file with checked top-level and unchecked indented task
      const planPath = join(TEST_DIR, "mixed-indented-plan.md")
      writeFileSync(planPath, `# Plan
- [x] top-level completed task
  - [ ] nested unchecked task
`)

      // when
      const progress = getPlanProgress(planPath)

      // then
      expect(progress.total).toBe(1)
      expect(progress.completed).toBe(1)
      expect(progress.isComplete).toBe(true)
    })

    test("should use only top-level TODO and Final Verification Wave tasks when present", () => {
      // given - a Prometheus-style plan with nested acceptance criteria
      const planPath = join(TEST_DIR, "structured-plan.md")
      writeFileSync(planPath, `# Plan

## TODOs
- [x] 1. Finished implementation
  - [ ] Acceptance criteria left unchecked on purpose
- [ ] 2. Pending implementation

## Final Verification Wave
- [ ] F1. Final review
  - [ ] Evidence artifact
`)

      // when
      const progress = getPlanProgress(planPath)

      // then
      expect(progress.total).toBe(3)
      expect(progress.completed).toBe(1)
      expect(progress.isComplete).toBe(false)
    })

    test("should return isComplete true when all checked", () => {
      // given - all tasks completed
      const planPath = join(TEST_DIR, "complete-plan.md")
      writeFileSync(planPath, `# Plan
- [x] Task 1
- [X] Task 2
`)

      // when
      const progress = getPlanProgress(planPath)

      // then
      expect(progress.total).toBe(2)
      expect(progress.completed).toBe(2)
      expect(progress.isComplete).toBe(true)
    })

    test("should treat checked tasks with missing evidence files as incomplete", () => {
      const planPath = join(SISYPHUS_DIR, "plans", "evidence-file-plan.md")
      mkdirSync(dirname(planPath), { recursive: true })
      writeFileSync(planPath, `# Plan

## TODOs
- [x] 23. Full suite performance audit under PERF_FAIL_MS=3000
  - QA: \`PERF_FAIL_MS=3000 ...\`. Evidence: .sisyphus/evidence/task-23-perf-audit.txt
`)

      const progress = getPlanProgress(planPath)

      expect(progress.total).toBe(1)
      expect(progress.completed).toBe(0)
      expect(progress.isComplete).toBe(false)
    })

    test("should treat checked tasks with present evidence files as complete", () => {
      const planPath = join(SISYPHUS_DIR, "plans", "evidence-present-plan.md")
      const evidencePath = join(TEST_DIR, ".sisyphus", "evidence", "task-23-perf-audit.txt")
      mkdirSync(dirname(planPath), { recursive: true })
      mkdirSync(dirname(evidencePath), { recursive: true })
      writeFileSync(evidencePath, "perf audit ok")
      writeFileSync(planPath, `# Plan

## TODOs
- [x] 23. Full suite performance audit under PERF_FAIL_MS=3000
  - QA: \`PERF_FAIL_MS=3000 ...\`. Evidence: .sisyphus/evidence/task-23-perf-audit.txt
`)

      const progress = getPlanProgress(planPath)

      expect(progress.total).toBe(1)
      expect(progress.completed).toBe(1)
      expect(progress.isComplete).toBe(true)
    })

    test("should treat checked tasks with empty evidence directories as incomplete", () => {
      const planPath = join(SISYPHUS_DIR, "plans", "evidence-dir-plan.md")
      const evidenceDir = join(TEST_DIR, ".sisyphus", "evidence", "final-qa")
      mkdirSync(dirname(planPath), { recursive: true })
      mkdirSync(evidenceDir, { recursive: true })
      writeFileSync(planPath, `# Plan

## Final Verification Wave
- [x] F3. Real Manual QA
  - Execute every task QA scenario, capture evidence in .sisyphus/evidence/final-qa/, verify cross-category behavior.
`)

      const progress = getPlanProgress(planPath)

      expect(progress.total).toBe(1)
      expect(progress.completed).toBe(0)
      expect(progress.isComplete).toBe(false)
    })

    test("should treat checked tasks with populated evidence directories as complete", () => {
      const planPath = join(SISYPHUS_DIR, "plans", "evidence-dir-populated-plan.md")
      const evidenceDir = join(TEST_DIR, ".sisyphus", "evidence", "final-qa")
      mkdirSync(dirname(planPath), { recursive: true })
      mkdirSync(evidenceDir, { recursive: true })
      writeFileSync(join(evidenceDir, "smoke.txt"), "ok")
      writeFileSync(planPath, `# Plan

## Final Verification Wave
- [x] F3. Real Manual QA
  - Execute every task QA scenario, capture evidence in .sisyphus/evidence/final-qa/, verify cross-category behavior.
`)

      const progress = getPlanProgress(planPath)

      expect(progress.total).toBe(1)
      expect(progress.completed).toBe(1)
      expect(progress.isComplete).toBe(true)
    })

    test("should return isComplete false for empty plan", () => {
      // given - plan with no checkboxes
      const planPath = join(TEST_DIR, "empty-plan.md")
      writeFileSync(planPath, "# Plan\nNo tasks here")

      // when
      const progress = getPlanProgress(planPath)

      // then
      expect(progress.total).toBe(0)
      expect(progress.isComplete).toBe(false)
    })

    test("should handle non-existent file", () => {
      // given - non-existent file
      // when
      const progress = getPlanProgress("/non/existent/file.md")
      // then
      expect(progress.total).toBe(0)
      expect(progress.isComplete).toBe(true)
    })
  })

  describe("getPlanName", () => {
    test("should extract plan name from path", () => {
      // given
      const path = "/home/user/.sisyphus/plans/project/my-feature.md"
      // when
      const name = getPlanName(path)
      // then
      expect(name).toBe("my-feature")
    })
  })

  describe("resolveBoulderExecutionDirectory", () => {
    test("should prefer existing worktree_path when boulder is active", () => {
      const worktreePath = join(TEST_DIR, "worktree")
      mkdirSync(worktreePath, { recursive: true })
      writeBoulderState(TEST_DIR, {
        active_plan: join(worktreePath, ".sisyphus", "plans", "feature.md"),
        started_at: "2026-04-10T00:00:00.000Z",
        session_ids: ["ses-1"],
        plan_name: "feature",
        worktree_path: worktreePath,
      })

      expect(getBoulderWorktreePath(TEST_DIR)).toBe(worktreePath)
      expect(resolveBoulderExecutionDirectory(TEST_DIR, "/fallback")).toBe(worktreePath)
    })

    test("should fall back when stored worktree_path no longer exists", () => {
      writeBoulderState(TEST_DIR, {
        active_plan: "/tmp/missing/.sisyphus/plans/feature.md",
        started_at: "2026-04-10T00:00:00.000Z",
        session_ids: ["ses-1"],
        plan_name: "feature",
        worktree_path: "/tmp/definitely-missing-worktree-path",
      })

      expect(getBoulderWorktreePath(TEST_DIR)).toBeUndefined()
      expect(resolveBoulderExecutionDirectory(TEST_DIR, "/fallback")).toBe("/fallback")
    })

    test("should handle missing directory by using the fallback directory", () => {
      expect(getBoulderWorktreePath(undefined)).toBeUndefined()
      expect(resolveBoulderExecutionDirectory(undefined, "/fallback")).toBe("/fallback")
    })
  })

  describe("createBoulderState", () => {
    test("should create state with correct fields", () => {
      // given
      const planPath = "/path/to/auth-refactor.md"
      const sessionId = "ses-abc123"

      // when
      const state = createBoulderState(planPath, sessionId)

      // then
      expect(state.active_plan).toBe(planPath)
      expect(state.session_ids).toEqual([sessionId])
      expect(state.plan_name).toBe("auth-refactor")
      expect(state.started_at).toBeDefined()
    })

    test("should include agent field when provided", () => {
      //#given - plan path, session id, and agent type
      const planPath = "/path/to/feature.md"
      const sessionId = "ses-xyz789"
      const agent = "atlas"

      //#when - createBoulderState is called with agent
      const state = createBoulderState(planPath, sessionId, agent)

      //#then - state should include the agent field
      expect(state.agent).toBe("atlas")
      expect(state.active_plan).toBe(planPath)
      expect(state.session_ids).toEqual([sessionId])
      expect(state.plan_name).toBe("feature")
    })

    test("should allow agent to be undefined", () => {
      //#given - plan path and session id without agent
      const planPath = "/path/to/legacy.md"
      const sessionId = "ses-legacy"

      //#when - createBoulderState is called without agent
      const state = createBoulderState(planPath, sessionId)

      //#then - state should not have agent field (backward compatible)
      expect(state.agent).toBeUndefined()
    })
  })
})
