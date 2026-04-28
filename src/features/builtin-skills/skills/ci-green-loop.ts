import type { BuiltinSkill } from "../types"

export const ciGreenLoopSkill: BuiltinSkill = {
  name: "ci-green-loop",
  description:
    "Iterative CI green loop: push → build → analyze → fix → repeat until green. Use when driving a branch to green CI, iterating on build failures, or running push-monitor-fix cycles. Trigger: 'CI green', 'make build green', 'iterate until green', 'fix CI', 'green loop', 'build red'.",
  template: `# CI Green Loop

## Planning Mode (Prometheus)

Plans MUST cover 100% of known failures. A plan addressing a subset is REJECTED.

**Required plan structure — EXACTLY 2 TASKS:**
1. **Task 1: Diagnosis** — fetch build SUMMARY (names + short errors only, NOT full test results), verify deployment succeeded, classify every failing test by name+error. Save COMPACT evidence to \`.sisyphus/evidence/\` (MAX 3KB). Skills: \`["bamboo-ci", "ci-green-loop"]\`. Category: \`quick\`.
2. **Task 2: Fix ALL failures** — ONE comprehensive fix task covering ALL root cause groups, ALL files, ALL tests. The executor reads Task 1 evidence and fixes everything in a single session. Include \`"dotnet-playwright"\` skill. Category: \`deep\`. Ends with: dotnet build verification → \`git add <specific-files>\` (NEVER \`git add -A\`) → git commit → git push → verify CI picks up revision.

**Why exactly 2 tasks:** Each task = ~2 min dispatch overhead + risk of parallel sessions editing the same file (duplicate ClassInitialize bug). One executor sees ALL changes holistically, avoids conflicts, pushes once.

**Coverage map** — table showing root cause group → failure count → confidence. Total must equal 100% of failures.

**NEVER split fixes into separate tasks by group.** If prior evidence/diagnosis exists from a previous iteration, embed it directly in Task 2's instructions — don't create a new Task 1.

Pre-digested fix instructions = ONE hypothesis for ONE group. Plan MUST still include full diagnosis to find ALL groups.

---

## Rules

### Baseline Comparison — MANDATORY FIRST STEP
Before diagnosing, fetch the SUMMARY (build number, state, pass/fail counts) of 3 previous builds via Bamboo list endpoint. Then fetch FAILING TEST NAMES ONLY from the latest previous build. Do NOT expand full test results for baseline — names are enough to identify pre-existing failures. Your diagnosis MUST split failures into:
- **REGRESSIONS** (pass→fail): caused by YOUR changes. Fix these FIRST — they block merge.
- **PRE-EXISTING** (fail→fail): broken before your branch. Fix if possible, but don't create new regressions chasing them.

Report format: "14 failures: 1 regression + 13 pre-existing (baseline build #NNN)."

**Why this matters**: Without baseline comparison, you waste iterations (v12→v13→v14) fixing things that were never yours to break, while accidentally regressing tests that WERE passing.

### Diagnosis Before Fix
Produce a complete diagnosis table BEFORE any code change. Non-negotiable even when the fix seems obvious. A systemic root cause may mask independent bugs.

The table MUST include for EVERY failing test:
- **Baseline status**: was this passing in the last 3 builds before your changes?
- Use-case (from READING test source code, not guessing from name)
- Bug classification: test bug / logic bug / infra bug
- Root cause group assignment
- Predicted outcome after fix

**Diagnosis brevity**: Evidence = ONE table (test name | short error ≤100 chars | root cause group) + ONE "next steps" line. Target: ~200 bytes per failing test, MAX 3KB total evidence file. Do NOT dump full error stacks, stack traces, or multi-paragraph narratives. Fetch test names+short errors only from Bamboo API — expand individual tests ONLY when the short error is insufficient for diagnosis.

### Side-Effect Verification
Before pushing a fix, verify it doesn't CREATE new regressions:
1. List ALL tests that interact with modified code (grep for function/table/column names)
2. For SQL seed changes: check ALL queries that reference the same table — will your change affect ranking, filtering, or visibility in other contexts?
3. For naming changes: grep the ENTIRE test project for the old name
4. For flag changes (Protected, Blocked, etc.): check ALL SQL queries that filter on that flag — not just the one you're targeting

### Error Message Depth
From the short error (≤150 chars), extract identifiers (DB names, paths, IDs). If insufficient, fetch THAT ONE test's full error (≤500 chars) — never bulk-expand all tests. A mismatched identifier IS the diagnosis.

### Causation Tracing
For deployment/infra failures, trace the FULL chain: error → code path → data source → population step → root cause. Save chain to evidence BEFORE writing any fix.

### Zero Failures — No Escalation
\`failed == 0\` is the only acceptable result. NEVER classify failures as "data-dependent", "infrastructure", "unfixable at test layer", or "outside scope".

| "Unfixable" Claim | Fix |
|---|---|
| Needs seed data | Create in \`[TestInitialize]\`/\`[ClassInitialize]\` via SQL/API |
| Shard timeout | Rebalance shards, split class, reduce overhead |
| Needs idle scenarios | Create in \`[TestInitialize]\` |
| build.ps1 change needed | CI pipeline IS in scope — adjust it |

### SQL Seed Data in CI — UPSERT Required
CI databases persist across builds. \`IF NOT EXISTS INSERT\` is WRONG — it skips rows that exist with bad values. Every SQL seed MUST use INSERT + unconditional UPDATE:
\`\`\`sql
IF NOT EXISTS (SELECT 1 FROM [T] WHERE [Name] = @n) INSERT INTO [T] (...) VALUES (...);
UPDATE [T] SET [Col] = @val WHERE [Name] = @n AND [Col] <> @val;
\`\`\`
Also check child rows (e.g. task group lines) — parent may exist but with missing/wrong children.

### TestInitialize Inheritance — Check Base Class FIRST
Before adding \`[TestInitialize]\` to fix "missing data": READ the base class. MSTest V2 runs BOTH base AND derived TestInitialize. If the base already does setup (scenario assignment, browser recovery), adding it in derived is redundant. The real bug is usually: (a) the base setup swallows errors silently, or (b) SQL seed data has wrong values (see UPSERT rule above).

### Execution Time
Target: ≤15 min. Hard limit: 20 min. Eliminate idle waits, parallelize shards, tight timeouts (10s UI, 30s API, 60s page). No single shard >5 min.

### Batch Strategy
**Diagnose ALL → Fix ALL → Verify local → Push ONCE.** One session, one commit, one push. Single-fix pushes only when: root cause unknown and CI validation needed, or deployment change can't be tested locally.

### Comprehensive Fix Mandate
Every fix session MUST attempt to resolve ALL known failures, not just the assigned subset. If you see a failing test whose fix is obvious from the evidence, fix it — even if it wasn't "your" task. The goal is zero failures per build, not zero failures per group.

### Deployment Phase First
BEFORE analyzing test failures, verify deployment/setup succeeded. Search build log for \`error :\` before test phase. If deployment failed, ALL test failures are symptoms — fix deployment first.

### Test Visibility
Always ensure: total = passed + failed + skipped. TRX artifacts mandatory. Build with 0 tests is NOT green.

---

## The Loop

\`\`\`
PRE-LOOP: Verify branch pushed, CI building correct revision.

LOOP:
  STEP 1: PUSH + MONITOR
    Push fixes, verify CI picks up revision. Don't idle-wait — research next failure group while building.
    NETWORK FAIL: If push fails (DNS NXDOMAIN, network unreachable, SSH timeout):
      1. git commit all changes locally (work is NOT lost)
      2. Save checkpoint: "NETWORK BLOCKED — N local commits ready to push"
      3. EXIT immediately. Do NOT retry DNS — 2 consecutive failures = confirmed blocked.

  STEP 2: ANALYZE (build done)
    a) Fetch build SUMMARY. Check deployment phase FIRST (grep "error :" from log, NOT full log).
    b) Fetch FAILING TEST NAMES + short errors (≤150 chars each) via jq/python filter. Classify: build-error|test-crash|test-timeout|test-assertion|setup-error|infra-error. Group by root cause.
    c) Only for UNCLEAR failures: fetch ONE test's full error (≤500 chars). READ source code for diagnosis. Save COMPACT evidence to .sisyphus/evidence/ (MAX 3KB total).
    d) Compare against predictions from previous iteration.

  STEP 3: FIX
    a) Fix highest-leverage root cause first. NEVER fix tests individually when they share a root cause.
    b) Verify locally: dotnet build, run affected tests if possible.
    c) Write predictions: hypothesis, expected test impact, residual failures. Save to evidence.

  STEP 4: PUSH → GOTO STEP 1

EXIT: GREEN (0 failures) | NETWORK BLOCKED (2 push fails → commit + checkpoint + stop) | BLOCKED (infra down, 3 retries) | TOKEN LIMIT (checkpoint first)
\`\`\`

## Fix Priority
P0 build error > P0.5 setup/DB error > P1 test crash > P2 assertion > P3 timeout > P4 infra/flaky.
If >50% failures share one root cause, that IS the fix.

## Forbidden
- Fixing code before diagnosis table is complete
- Fixing tests one-by-one without analyzing ALL failures first
- Weakening assertions, skipping/muting/removing tests
- Idle-waiting for builds (research while CI runs)
- Dumping raw Bamboo JSON into context (ALWAYS filter through jq/python)
- Fetching full build logs (grep for errors only)
- Shotgun fixes (2+ commits same root cause without verification)
- Escalating as "unfixable" or "data-dependent"
- Accepting any non-zero failure count as done
- \`Assert.Inconclusive\` as permanent state
- Pushing during build-time research (research only, no file edits)
- Looping on DNS/network checks — 2 failures = BLOCKED, commit locally and EXIT
- Leaving uncommitted changes when exiting (always git commit before stopping)
- Using \`git add -A\` or \`git add .\` — ALWAYS stage specific files: \`git add <file1> <file2>\`. Blanket staging pulls in .sisyphus/, test artifacts, and other untracked files that should NOT be committed. Run \`git diff --staged --stat\` before committing to verify only intended files are staged.
- Using \`IF NOT EXISTS INSERT\` without a follow-up UPDATE for SQL seed data (stale rows with wrong values persist across CI builds)
- Adding \`[TestInitialize]\` to derived classes without reading the base class first (MSTest V2 runs both — you may be duplicating existing setup)
- Removing base class \`[TestInitialize]\` calls to "move" them to derived (breaks ALL other classes sharing that base)

## Post-Green
1. Verify green build ran YOUR branch HEAD
2. Verify all shards completed, test count matches expected (no silent drops)
3. Verify TRX artifacts exist
4. Save evidence to \`.sisyphus/evidence/\`

## Checkpoint
Write to \`.sisyphus/evidence/ci-loop-checkpoint.md\`: branch state, latest build (number/state/duration/pass/fail), iteration history table, current failures, next steps.
**OVERWRITE, don't append.** Checkpoint is a snapshot, not a log. Max 50 lines. Stale checkpoint entries waste context for the next session.
`,
}
