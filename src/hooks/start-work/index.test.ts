import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir, homedir } from "node:os"
import { randomUUID } from "node:crypto"
import { createStartWorkHook } from "./index"
import {
  writeBoulderState,
  clearBoulderState,
  readBoulderState,
} from "../../features/boulder-state"
import type { BoulderState } from "../../features/boulder-state"
import * as sessionState from "../../features/claude-code-session-state"
import * as worktreeDetector from "./worktree-detector"

describe("start-work hook", () => {
  let testDir: string
  let sisyphusDir: string

  function wrapStartWorkText(body: string): string {
    return `<command-instruction>You are starting a Sisyphus work session.</command-instruction>\n${body}`
  }

  function createMockPluginInput() {
    return {
      directory: testDir,
      client: {},
    } as Parameters<typeof createStartWorkHook>[0]
  }

  beforeEach(() => {
    sessionState._resetForTesting()
    sessionState.registerAgentName("atlas")
    sessionState.registerAgentName("sisyphus")
    testDir = join(tmpdir(), `start-work-test-${randomUUID()}`)
    sisyphusDir = join(testDir, ".sisyphus")
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true })
    }
    if (!existsSync(sisyphusDir)) {
      mkdirSync(sisyphusDir, { recursive: true })
    }
    clearBoulderState(testDir)
  })

  afterEach(() => {
    sessionState._resetForTesting()
    clearBoulderState(testDir)
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true })
    }
  })

  describe("chat.message handler", () => {
    test("should ignore non-start-work commands", async () => {
      // given - hook and non-start-work message
      const hook = createStartWorkHook(createMockPluginInput())
      const output = {
        parts: [{ type: "text", text: "Just a regular message" }],
      }

      // when
      await hook["chat.message"](
        { sessionID: "session-123" },
        output
      )

      // then - output should be unchanged
      expect(output.parts[0].text).toBe("Just a regular message")
    })

    test("should detect start-work command via wrapped command template", async () => {
      // given - hook and wrapped start-work command template
      const hook = createStartWorkHook(createMockPluginInput())
      const output = {
        parts: [
          {
            type: "text",
            text: `<command-instruction>You are starting a Sisyphus work session.</command-instruction>
<session-context>Some context here</session-context>
<user-request>ci-green-final</user-request>`,
          },
        ],
      }

      // when
      await hook["chat.message"](
        { sessionID: "session-123" },
        output
      )

      // then - output should be modified with context info
      expect(output.parts[0].text).toContain("---")
    })

    test("should detect raw /start-work command without session-context wrapper", async () => {
      const plansDir = join(testDir, ".sisyphus", "plans")
      mkdirSync(plansDir, { recursive: true })
      writeFileSync(
        join(plansDir, "ci-green-final.md"),
        `# Plan

## TODOs
- [ ] 1. Real task
`,
      )

      const hook = createStartWorkHook(createMockPluginInput())
      const output = {
        message: {},
        parts: [{ type: "text", text: "/start-work ci-green-final" }],
      }

      await hook["chat.message"](
        { sessionID: "session-raw-start-work" },
        output,
      )

      expect(output.parts[0].text).toContain("Auto-Selected Plan")
      expect(output.parts[0].text).toContain("ci-green-final")
      expect(output.message?.agent).toBe("Atlas (Plan Executor)")
      expect(readBoulderState(testDir)?.session_ids).toContain("session-raw-start-work")
    })

    test("should inject resume info when existing boulder state found", async () => {
      // given - existing boulder state with incomplete plan
      const planPath = join(testDir, "test-plan.md")
      writeFileSync(planPath, "# Plan\n- [ ] Task 1\n- [x] Task 2")

      const state: BoulderState = {
        active_plan: planPath,
        started_at: "2026-01-02T10:00:00Z",
        session_ids: ["session-1"],
        plan_name: "test-plan",
      }
      writeBoulderState(testDir, state)

      const hook = createStartWorkHook(createMockPluginInput())
      const output = {
        parts: [{ type: "text", text: wrapStartWorkText("<session-context></session-context>") }],
      }

      // when
      await hook["chat.message"](
        { sessionID: "session-123" },
        output
      )

      // then - should show resuming status
      expect(output.parts[0].text).toContain("RESUMING")
      expect(output.parts[0].text).toContain("test-plan")
    })

    test("should reuse existing active boulder plan when raw explicit /start-work plan lookup is requested", async () => {
      const plansDir = join(testDir, ".sisyphus", "plans")
      mkdirSync(plansDir, { recursive: true })
      const planPath = join(plansDir, "ci-green-final.md")
      writeFileSync(
        planPath,
        `# Plan

## TODOs
- [ ] 1. Real task
`,
      )

      const state: BoulderState = {
        active_plan: planPath,
        started_at: "2026-01-02T10:00:00Z",
        session_ids: ["session-1"],
        plan_name: "ci-green-final",
        agent: "atlas",
      }
      writeBoulderState(testDir, state)

      const hook = createStartWorkHook(createMockPluginInput())
      const output = {
        message: {},
        parts: [{ type: "text", text: "/start-work ci-green-final" }],
      }

      await hook["chat.message"](
        { sessionID: "session-123" },
        output,
      )

      expect(output.parts[0].text).toContain("Auto-Selected Plan")
      expect(output.parts[0].text).toContain("ci-green-final")
      expect(readBoulderState(testDir)?.session_ids).toContain("session-123")
    })

    test("should inject delegation-first guidance when resuming an active boulder session", async () => {
      // given - existing boulder state with incomplete plan
      const planPath = join(testDir, "test-plan.md")
      writeFileSync(planPath, "# Plan\n- [ ] Task 1\n- [x] Task 2")

      const state: BoulderState = {
        active_plan: planPath,
        started_at: "2026-01-02T10:00:00Z",
        session_ids: ["session-1"],
        plan_name: "test-plan",
      }
      writeBoulderState(testDir, state)

      const hook = createStartWorkHook(createMockPluginInput())
      const output = {
        parts: [{ type: "text", text: wrapStartWorkText("<session-context></session-context>") }],
      }

      // when
      await hook["chat.message"](
        { sessionID: "session-123" },
        output
      )

      // then - resume prompt should force Atlas back into delegation mode
      const lowerText = output.parts[0].text.toLowerCase()
      expect(lowerText).toContain("delegate tasks immediately")
      expect(lowerText).toContain("delegate it as one task to one agent")
      expect(lowerText).toContain("do not investigate implementation details")
    })

    test("should clear stale boulder state when existing active plan is already complete", async () => {
      const plansDir = join(testDir, ".sisyphus", "plans")
      mkdirSync(plansDir, { recursive: true })

      const completedPlanPath = join(plansDir, "project-completion.md")
      writeFileSync(completedPlanPath, "# Completed Plan\n- [x] Task 1\n- [x] Task 2")

      const state: BoulderState = {
        active_plan: completedPlanPath,
        started_at: "2026-01-02T10:00:00Z",
        session_ids: ["session-1"],
        plan_name: "project-completion",
      }
      writeBoulderState(testDir, state)

      const hook = createStartWorkHook(createMockPluginInput())
      const output = {
        parts: [{ type: "text", text: wrapStartWorkText("<session-context></session-context>") }],
      }

      await hook["chat.message"](
        { sessionID: "session-123" },
        output
      )

      expect(output.parts[0].text).toContain("Previous Work Complete")
      expect(output.parts[0].text).toContain("No Plans Found")
      expect(readBoulderState(testDir)).toBeNull()
    })

    test("should resume when checked tasks are still missing required evidence", async () => {
      const planPath = join(testDir, ".sisyphus", "plans", "evidence-gated-plan.md")
      mkdirSync(join(testDir, ".sisyphus", "plans"), { recursive: true })
      writeFileSync(planPath, `# Plan

## TODOs
- [x] 24. Final mapping closure
  - QA: \`grep -n 'MISSING' .sisyphus/evidence/selenium-assertion-inventory.md\`. Evidence: .sisyphus/evidence/task-24-zero-missing.txt
`)

      const state: BoulderState = {
        active_plan: planPath,
        started_at: "2026-01-02T10:00:00Z",
        session_ids: ["session-1"],
        plan_name: "evidence-gated-plan",
      }
      writeBoulderState(testDir, state)

      const hook = createStartWorkHook(createMockPluginInput())
      const output = {
        parts: [{ type: "text", text: wrapStartWorkText("<session-context></session-context>") }],
      }

      await hook["chat.message"](
        { sessionID: "session-123" },
        output
      )

      expect(output.parts[0].text).toContain("RESUMING")
      expect(output.parts[0].text).toContain("0/1 tasks completed")
      expect(output.parts[0].text).toContain("Checked boxes without required evidence remain incomplete")
    })

    test("should replace $SESSION_ID placeholder", async () => {
      // given - hook and message with placeholder
      const hook = createStartWorkHook(createMockPluginInput())
      const output = {
        parts: [
          {
            type: "text",
            text: wrapStartWorkText("<session-context>Session: $SESSION_ID</session-context>"),
          },
        ],
      }

      // when
      await hook["chat.message"](
        { sessionID: "ses-abc123" },
        output
      )

      // then - placeholder should be replaced
      expect(output.parts[0].text).toContain("ses-abc123")
      expect(output.parts[0].text).not.toContain("$SESSION_ID")
    })

    test("should replace $TIMESTAMP placeholder", async () => {
      // given - hook and message with placeholder
      const hook = createStartWorkHook(createMockPluginInput())
      const output = {
        parts: [
          {
            type: "text",
            text: wrapStartWorkText("<session-context>Time: $TIMESTAMP</session-context>"),
          },
        ],
      }

      // when
      await hook["chat.message"](
        { sessionID: "session-123" },
        output
      )

      // then - placeholder should be replaced with ISO timestamp
      expect(output.parts[0].text).not.toContain("$TIMESTAMP")
      expect(output.parts[0].text).toMatch(/\d{4}-\d{2}-\d{2}T/)
    })

    test("should auto-select when only one incomplete plan among multiple plans", async () => {
      // given - multiple plans but only one incomplete
      const plansDir = join(testDir, ".sisyphus", "plans")
      mkdirSync(plansDir, { recursive: true })

      // Plan 1: complete (all checked)
      const plan1Path = join(plansDir, "plan-complete.md")
      writeFileSync(plan1Path, "# Plan Complete\n\n## TODOs\n- [x] 1. Task 1\n- [x] 2. Task 2")

      // Plan 2: incomplete (has unchecked)
      const plan2Path = join(plansDir, "plan-incomplete.md")
      writeFileSync(plan2Path, "# Plan Incomplete\n\n## TODOs\n- [ ] 1. Task 1\n- [x] 2. Task 2")

      const hook = createStartWorkHook(createMockPluginInput())
      const output = {
        parts: [{ type: "text", text: wrapStartWorkText("<session-context></session-context>") }],
      }

      // when
      await hook["chat.message"](
        { sessionID: "session-123" },
        output
      )

      // then - should auto-select the incomplete plan, not ask user
      expect(output.parts[0].text).toContain("Auto-Selected Plan")
      expect(output.parts[0].text).toContain("plan-incomplete")
      expect(output.parts[0].text).not.toContain("Multiple Plans Found")
    })

    test("should wrap multiple plans message in system-reminder tag", async () => {
      // given - multiple incomplete plans
      const plansDir = join(testDir, ".sisyphus", "plans")
      mkdirSync(plansDir, { recursive: true })

      const plan1Path = join(plansDir, "plan-a.md")
      writeFileSync(plan1Path, "# Plan A\n\n## TODOs\n- [ ] 1. Task 1")

      const plan2Path = join(plansDir, "plan-b.md")
      writeFileSync(plan2Path, "# Plan B\n\n## TODOs\n- [ ] 1. Task 2")

      const hook = createStartWorkHook(createMockPluginInput())
      const output = {
        parts: [{ type: "text", text: wrapStartWorkText("<session-context></session-context>") }],
      }

      // when
      await hook["chat.message"](
        { sessionID: "session-123" },
        output
      )

      // then - should use system-reminder tag format
      expect(output.parts[0].text).toContain("<system-reminder>")
      expect(output.parts[0].text).toContain("</system-reminder>")
      expect(output.parts[0].text).toContain("Multiple Plans Found")
    })

    test("should use 'ask user' prompt style for multiple plans", async () => {
      // given - multiple incomplete plans
      const plansDir = join(testDir, ".sisyphus", "plans")
      mkdirSync(plansDir, { recursive: true })

      const plan1Path = join(plansDir, "plan-x.md")
      writeFileSync(plan1Path, "# Plan X\n\n## TODOs\n- [ ] 1. Task 1")

      const plan2Path = join(plansDir, "plan-y.md")
      writeFileSync(plan2Path, "# Plan Y\n\n## TODOs\n- [ ] 1. Task 2")

      const hook = createStartWorkHook(createMockPluginInput())
      const output = {
        parts: [{ type: "text", text: wrapStartWorkText("<session-context></session-context>") }],
      }

      // when
      await hook["chat.message"](
        { sessionID: "session-123" },
        output
      )

      // then - should prompt agent to ask user, not ask directly
      expect(output.parts[0].text).toContain("Ask the user")
      expect(output.parts[0].text).not.toContain("Which plan would you like to work on?")
    })

    test("should select explicitly specified plan name from user-request, ignoring existing boulder state", async () => {
      // given - existing boulder state pointing to old plan
      const plansDir = join(testDir, ".sisyphus", "plans")
      mkdirSync(plansDir, { recursive: true })

      // Old plan (in boulder state)
      const oldPlanPath = join(plansDir, "old-plan.md")
      writeFileSync(oldPlanPath, "# Old Plan\n\n## TODOs\n- [ ] 1. Old Task 1")

      // New plan (user wants this one)
      const newPlanPath = join(plansDir, "new-plan.md")
      writeFileSync(newPlanPath, "# New Plan\n\n## TODOs\n- [ ] 1. New Task 1")

      // Set up stale boulder state pointing to old plan
      const staleState: BoulderState = {
        active_plan: oldPlanPath,
        started_at: "2026-01-01T10:00:00Z",
        session_ids: ["old-session"],
        plan_name: "old-plan",
      }
      writeBoulderState(testDir, staleState)

      const hook = createStartWorkHook(createMockPluginInput())
      const output = {
        parts: [
          {
            type: "text",
            text: wrapStartWorkText(`<session-context>
<user-request>new-plan</user-request>
</session-context>`),
          },
        ],
      }

      // when - user explicitly specifies new-plan
      await hook["chat.message"](
        { sessionID: "session-123" },
        output
      )

      // then - should select new-plan, NOT resume old-plan
      expect(output.parts[0].text).toContain("new-plan")
      expect(output.parts[0].text).not.toContain("RESUMING")
      expect(output.parts[0].text).not.toContain("old-plan")
    })

    test("should strip ultrawork/ulw keywords from plan name argument", async () => {
      // given - plan with ultrawork keyword in user-request
      const plansDir = join(testDir, ".sisyphus", "plans")
      mkdirSync(plansDir, { recursive: true })

      const planPath = join(plansDir, "my-feature-plan.md")
      writeFileSync(planPath, "# My Feature Plan\n\n## TODOs\n- [ ] 1. Task 1")

      const hook = createStartWorkHook(createMockPluginInput())
      const output = {
        parts: [
          {
            type: "text",
            text: wrapStartWorkText(`<session-context>
<user-request>my-feature-plan ultrawork</user-request>
</session-context>`),
          },
        ],
      }

      // when - user specifies plan with ultrawork keyword
      await hook["chat.message"](
        { sessionID: "session-123" },
        output
      )

      // then - should find plan without ultrawork suffix
      expect(output.parts[0].text).toContain("my-feature-plan")
      expect(output.parts[0].text).toContain("Auto-Selected Plan")
    })

    test("should strip ulw keyword from plan name argument", async () => {
      // given - plan with ulw keyword in user-request
      const plansDir = join(testDir, ".sisyphus", "plans")
      mkdirSync(plansDir, { recursive: true })

      const planPath = join(plansDir, "api-refactor.md")
      writeFileSync(planPath, "# API Refactor\n\n## TODOs\n- [ ] 1. Task 1")

      const hook = createStartWorkHook(createMockPluginInput())
      const output = {
        parts: [
          {
            type: "text",
            text: wrapStartWorkText(`<session-context>
<user-request>api-refactor ulw</user-request>
</session-context>`),
          },
        ],
      }

      // when
      await hook["chat.message"](
        { sessionID: "session-123" },
        output
      )

      // then - should find plan without ulw suffix
      expect(output.parts[0].text).toContain("api-refactor")
      expect(output.parts[0].text).toContain("Auto-Selected Plan")
    })

    test("should match plan by partial name", async () => {
      // given - user specifies partial plan name
      const plansDir = join(testDir, ".sisyphus", "plans")
      mkdirSync(plansDir, { recursive: true })

      const planPath = join(plansDir, "2026-01-15-feature-implementation.md")
      writeFileSync(planPath, "# Feature Implementation\n\n## TODOs\n- [ ] 1. Task 1")

      const hook = createStartWorkHook(createMockPluginInput())
      const output = {
        parts: [
          {
            type: "text",
            text: wrapStartWorkText(`<session-context>
<user-request>feature-implementation</user-request>
</session-context>`),
          },
        ],
      }

      // when
      await hook["chat.message"](
        { sessionID: "session-123" },
        output
      )

      // then - should find plan by partial match
      expect(output.parts[0].text).toContain("2026-01-15-feature-implementation")
      expect(output.parts[0].text).toContain("Auto-Selected Plan")
    })
  })

  describe("command.execute.before handler", () => {
    test("should inject start-work context for builtin /start-work command execution", async () => {
      const plansDir = join(testDir, ".sisyphus", "plans")
      mkdirSync(plansDir, { recursive: true })
      writeFileSync(
        join(plansDir, "ci-green-final.md"),
        `# Plan

## TODOs
- [ ] 1. Real task
`,
      )

      const hook = createStartWorkHook(createMockPluginInput())
      const output = {
        message: {},
        parts: [
          {
            type: "text",
            text: `# /start-work Command

**Arguments**: ci-green-final

<command-instruction>
You are starting a Sisyphus work session.
</command-instruction>`,
          },
        ],
      }

      await hook["command.execute.before"]?.(
        {
          sessionID: "session-command-start-work",
          command: "start-work",
          arguments: "ci-green-final",
        },
        output,
      )

      expect(output.parts[0].text).toContain("Auto-Selected Plan")
      expect(output.parts[0].text).toContain("ci-green-final")
      expect(output.message?.agent).toBe("Atlas (Plan Executor)")
      expect(readBoulderState(testDir)?.session_ids).toContain("session-command-start-work")
    })
  })

  describe("session agent management", () => {
    test("should update session agent to Atlas when start-work command is triggered", async () => {
      // given
      const updateSpy = spyOn(sessionState, "updateSessionAgent")
      
      const hook = createStartWorkHook(createMockPluginInput())
      const output = {
        parts: [{ type: "text", text: wrapStartWorkText("<session-context></session-context>") }],
      }

      // when
      await hook["chat.message"](
        { sessionID: "ses-prometheus-to-sisyphus" },
        output
      )

      // then
      expect(updateSpy).toHaveBeenCalledWith("ses-prometheus-to-sisyphus", "atlas")
      updateSpy.mockRestore()
    })

    test("should stamp the outgoing message with Atlas so follow-up events keep the handoff", async () => {
      // given
      const hook = createStartWorkHook(createMockPluginInput())
      const output = {
        message: {} as Record<string, unknown>,
        parts: [{ type: "text", text: wrapStartWorkText("<session-context></session-context>") }],
      }

      // when
      await hook["chat.message"](
        { sessionID: "ses-prometheus-to-atlas" },
        output
      )

      // then
      expect(output.message.agent).toBe("Atlas (Plan Executor)")
    })

    test("should keep the current agent when Atlas is unavailable", async () => {
      // given
      sessionState._resetForTesting()
      sessionState.registerAgentName("sisyphus")
      sessionState.updateSessionAgent("ses-prometheus-to-sisyphus", "sisyphus")

      const hook = createStartWorkHook(createMockPluginInput())
      const output = {
        message: {} as Record<string, unknown>,
        parts: [{ type: "text", text: wrapStartWorkText("<session-context></session-context>") }],
      }

      // when
      await hook["chat.message"](
        { sessionID: "ses-prometheus-to-sisyphus" },
        output
      )

      // then
      expect(output.message.agent).toBe("Sisyphus (Ultraworker)")
      expect(sessionState.getSessionAgent("ses-prometheus-to-sisyphus")).toBe("Sisyphus (Ultraworker)")
    })
  })

  describe("worktree support", () => {
    let detectSpy: ReturnType<typeof spyOn>

    beforeEach(() => {
      detectSpy = spyOn(worktreeDetector, "detectWorktreePath").mockReturnValue(null)
    })

    afterEach(() => {
      detectSpy.mockRestore()
    })

    test("should NOT inject worktree instructions when no --worktree flag", async () => {
      // given - single plan, no worktree flag
      const plansDir = join(testDir, ".sisyphus", "plans")
      mkdirSync(plansDir, { recursive: true })
      writeFileSync(join(plansDir, "my-plan.md"), "# Plan\n\n## TODOs\n- [ ] 1. Task 1")

      const hook = createStartWorkHook(createMockPluginInput())
      const output = {
        parts: [{ type: "text", text: wrapStartWorkText("<session-context></session-context>") }],
      }

      // when
      await hook["chat.message"]({ sessionID: "session-123" }, output)

      // then - no worktree instructions should appear
      expect(output.parts[0].text).not.toContain("Worktree Setup Required")
      expect(output.parts[0].text).not.toContain("Worktree Active")
      expect(output.parts[0].text).not.toContain("git worktree list --porcelain")
    })

    test("should inject worktree path when --worktree flag is valid", async () => {
      // given - single plan + valid worktree path
      const plansDir = join(testDir, ".sisyphus", "plans")
      mkdirSync(plansDir, { recursive: true })
      writeFileSync(join(plansDir, "my-plan.md"), "# Plan\n\n## TODOs\n- [ ] 1. Task 1")
      detectSpy.mockReturnValue("/validated/worktree")

      const hook = createStartWorkHook(createMockPluginInput())
      const output = {
        parts: [{ type: "text", text: wrapStartWorkText("<session-context>\n<user-request>--worktree /validated/worktree</user-request>\n</session-context>") }],
      }

      // when
      await hook["chat.message"]({ sessionID: "session-123" }, output)

      // then - strong worktree active instructions shown
      expect(output.parts[0].text).toContain("Worktree Active")
      expect(output.parts[0].text).toContain("/validated/worktree")
      expect(output.parts[0].text).toContain("subagent")
      expect(output.parts[0].text).not.toContain("Worktree Setup Required")
    })

    test("should store worktree_path in boulder when --worktree is valid", async () => {
      // given - plan + valid worktree
      const plansDir = join(testDir, ".sisyphus", "plans")
      mkdirSync(plansDir, { recursive: true })
      writeFileSync(join(plansDir, "my-plan.md"), "# Plan\n\n## TODOs\n- [ ] 1. Task 1")
      detectSpy.mockReturnValue("/valid/wt")

      const hook = createStartWorkHook(createMockPluginInput())
      const output = {
        parts: [{ type: "text", text: wrapStartWorkText("<session-context>\n<user-request>--worktree /valid/wt</user-request>\n</session-context>") }],
      }

      // when
      await hook["chat.message"]({ sessionID: "session-123" }, output)

      // then - boulder.json has worktree_path
      const state = readBoulderState(testDir)
      expect(state?.worktree_path).toBe("/valid/wt")
    })

    test("should NOT store worktree_path when --worktree path is invalid", async () => {
      // given - plan + invalid worktree path (detectWorktreePath returns null)
      const plansDir = join(testDir, ".sisyphus", "plans")
      mkdirSync(plansDir, { recursive: true })
      writeFileSync(join(plansDir, "my-plan.md"), "# Plan\n\n## TODOs\n- [ ] 1. Task 1")
      // detectSpy already returns null by default

      const hook = createStartWorkHook(createMockPluginInput())
      const output = {
        parts: [{ type: "text", text: wrapStartWorkText("<session-context>\n<user-request>--worktree /nonexistent/wt</user-request>\n</session-context>") }],
      }

      // when
      await hook["chat.message"]({ sessionID: "session-123" }, output)

      // then - worktree_path absent, setup instructions present
      const state = readBoulderState(testDir)
      expect(state?.worktree_path).toBeUndefined()
      expect(output.parts[0].text).toContain("needs setup")
      expect(output.parts[0].text).toContain("git worktree add /nonexistent/wt")
    })

    test("should update boulder worktree_path on resume when new --worktree given", async () => {
      // given - existing boulder with old worktree, user provides new worktree
      const planPath = join(testDir, "plan.md")
      writeFileSync(planPath, "# Plan\n\n## TODOs\n- [ ] 1. Task 1")
      const existingState: BoulderState = {
        active_plan: planPath,
        started_at: "2026-01-01T00:00:00Z",
        session_ids: ["old-session"],
        plan_name: "plan",
        worktree_path: "/old/wt",
      }
      writeBoulderState(testDir, existingState)
      detectSpy.mockReturnValue("/new/wt")

      const hook = createStartWorkHook(createMockPluginInput())
      const output = {
        parts: [{ type: "text", text: wrapStartWorkText("<session-context>\n<user-request>--worktree /new/wt</user-request>\n</session-context>") }],
      }

      // when
      await hook["chat.message"]({ sessionID: "session-456" }, output)

      // then - boulder reflects updated worktree and new session appended
      const state = readBoulderState(testDir)
      expect(state?.worktree_path).toBe("/new/wt")
      expect(state?.session_ids).toContain("session-456")
    })

    test("should show existing worktree on resume when no --worktree flag", async () => {
      // given - existing boulder already has worktree_path, no flag given
      const planPath = join(testDir, "plan.md")
      writeFileSync(planPath, "# Plan\n\n## TODOs\n- [ ] 1. Task 1")
      const existingState: BoulderState = {
        active_plan: planPath,
        started_at: "2026-01-01T00:00:00Z",
        session_ids: ["old-session"],
        plan_name: "plan",
        worktree_path: "/existing/wt",
      }
      writeBoulderState(testDir, existingState)

      const hook = createStartWorkHook(createMockPluginInput())
      const output = {
        parts: [{ type: "text", text: wrapStartWorkText("<session-context></session-context>") }],
      }

      // when
      await hook["chat.message"]({ sessionID: "session-789" }, output)

      // then - shows strong worktree active instructions
      expect(output.parts[0].text).toContain("Worktree Active")
      expect(output.parts[0].text).toContain("/existing/wt")
      expect(output.parts[0].text).toContain("subagent")
      expect(output.parts[0].text).not.toContain("Worktree Setup Required")
    })
  })
})
