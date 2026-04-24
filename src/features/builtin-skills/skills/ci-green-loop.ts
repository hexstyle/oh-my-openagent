import type { BuiltinSkill } from "../types"

export const ciGreenLoopSkill: BuiltinSkill = {
  name: "ci-green-loop",
  description:
    "Iterative CI green loop: push → build → analyze → fix → repeat until green. Use when driving a branch to green CI, iterating on build failures, or running push-monitor-fix cycles. Trigger: 'CI green', 'make build green', 'iterate until green', 'fix CI', 'green loop', 'build red'.",
  template: `# CI Green Loop Skill

Systematic protocol for driving a branch to green CI through iterative fix cycles.

## Core Philosophy

- **Root cause over band-aid** — find WHY it fails, don't just retry
- **One fix per cause** — group related failures, fix the root once
- **Local proof before push** — verify fix locally before burning a CI cycle
- **Checkpoint early** — save progress before running out of context
- **Never weaken to pass** — no assertion removal, no test skipping, no fake waits

## The Loop

\`\`\`
PRE-LOOP:
  - Verify branch is pushed and CI is building correct revision
  - If CI is building stale revision, push empty commit to trigger

LOOP (repeat until green):
  STEP 1: MONITOR
    - Poll CI for build completion
    - Verify build revision matches branch HEAD
    - If revision mismatch → push and wait for new build

  STEP 2: ANALYZE (if red)
    - Fetch full build results (JSON + logs)
    - List every failing test with error message
    - Classify each failure:
      * build-error: compilation/MSBuild failure
      * test-crash: process died during test (TargetClosedException)
      * test-timeout: element/response wait exceeded
      * test-assertion: assert failed (test logic vs app behavior)
      * infra-error: CI agent issue, checkout failure
    - Group by root cause (multiple tests → one cause)
    - Prioritize: build-error > crash > assertion > timeout > infra

  STEP 3: FIX
    - Fix highest-priority root cause first
    - Apply fix and verify locally:
      * dotnet build (if build error)
      * dotnet test --filter "affected tests" (if test failure)
    - Commit with descriptive message
    - Repeat for each root cause group

  STEP 4: PUSH
    - Push all fixes
    - Verify CI picks up new revision
    - GOTO STEP 1

EXIT CONDITIONS:
  - GREEN: All tests pass, 0 failures → DONE
  - BLOCKED: CI infrastructure down after 5 retries → checkpoint and escalate
  - TOKEN LIMIT: Approaching context limit → checkpoint and handoff

FORBIDDEN:
  - Stopping because "it's taking too long"
  - Weakening assertions to make tests pass
  - Skipping or muting tests
  - Adding WaitForTimeoutAsync as primary fix
  - Claiming green based on local run while CI is red
  - Marking done with known regressions
\`\`\`

## Fix Priority Matrix

| Priority | Failure Type | Action |
|----------|-------------|--------|
| P0 | Build error (compilation) | Fix immediately — nothing else can run |
| P1 | Test crash (process exit) | Fix browser/process lifecycle — blocks entire class |
| P2 | Assertion failure | Fix test logic or investigate app change |
| P3 | Timeout | Fix selector/wait condition (NOT timeout value) |
| P4 | Infra/flaky | Investigate; only mark external if truly uncontrollable |

## Checkpoint Format

Write to \`.sisyphus/evidence/ci-loop-checkpoint.md\`:
\`\`\`markdown
# CI Loop Checkpoint — {date}

## Branch State
- Local HEAD: {SHA}
- Remote HEAD: {SHA}
- Branch: {branch name}

## Latest Build
- Build #: {N}
- State: {state}
- Duration: {N}s
- Tests: {pass} pass / {fail} fail
- Revision: {SHA} (matches HEAD: yes/no)

## Iteration History
| # | Build | Fails | Fixes Applied | Result |
|---|-------|-------|---------------|--------|
| 1 | #250 | 8 | crash cluster fix | 4 remaining |
| 2 | #251 | 4 | selector updates | 1 remaining |

## Current Failures
| Test | Type | Root Cause | Status |
|------|------|-----------|--------|
| TestX | timeout | stale selector | fixing |

## Next Steps
1. Fix remaining selector in TestX
2. Push and verify build #252
\`\`\`

## Multi-Iteration Commit Strategy

- Each iteration gets its own commit(s)
- Message format: \`fix(ci): iteration N — {what was fixed} [{TASK_KEY}]\`
- Don't squash iterations — keep history for debugging
- If multiple root causes fixed in one iteration, one commit per cause

## Post-Green Verification

After achieving green:
1. Verify the green build ran YOUR branch head (check revision)
2. Verify all shards completed (no skipped shards)
3. Verify test count matches expected (no silent test drops)
4. Record the green build evidence:
   - Build number, duration, test counts
   - Branch HEAD SHA
   - Full test pass list if available
5. Save to \`.sisyphus/evidence/task-N-bamboo-green.md\`

## Token Budget Awareness

- Each CI iteration costs tokens: fetch → analyze → fix → commit → push → wait
- Estimate ~2000-5000 tokens per iteration
- If > 5 iterations without progress, stop and reassess strategy
- If approaching token limit, ALWAYS checkpoint before running out
- Prefer committing partial progress over losing it to compaction
`,
}
