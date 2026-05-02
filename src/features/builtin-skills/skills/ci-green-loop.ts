import type { BuiltinSkill } from "../types"

export const ciGreenLoopSkill: BuiltinSkill = {
  name: "ci-green-loop",
  description:
    "Iterative CI green loop: push → build → analyze → fix → repeat until green. Use when driving a branch to green CI, iterating on build failures, or running push-monitor-fix cycles. Trigger: 'CI green', 'make build green', 'iterate until green', 'fix CI', 'green loop', 'build red'.",
  template: `# CI Green Loop

## Planning Mode (Prometheus)

Plans MUST cover 100% of known failures. A plan addressing a subset is REJECTED.

**Required plan structure — EXACTLY 2 TASKS:**
1. **Task 1: Diagnosis** — fetch build SUMMARY (names + short errors only, NOT full test results), verify deployment succeeded, classify every failing test by name+error. Create per-test tracker files in \`.sisyphus/evidence/tests/\`. Skills: \`["bamboo-ci", "ci-green-loop"]\`. Category: \`quick\`.
2. **Task 2: Fix ALL failures** — ONE comprehensive fix task covering ALL root cause groups, ALL files, ALL tests. The executor reads Task 1 evidence AND per-test tracker files, then fixes everything in a single session. For tests with prior failed attempts in tracker files, the plan MUST instruct the executor to try a DIFFERENT approach and cite what was already tried. Include \`"dotnet-playwright"\` skill. Category: \`deep\`. Ends with: pre-push audit → dotnet build → local test run → git commit → git push → verify CI picks up revision.

**Managed .sisyphus repo fast-path (STRICT):** If \`.sisyphus/evidence/ci-loop-checkpoint.md\`, \`repair-log.md\`, the latest build analysis, AND per-test tracker files already exist and agree on the latest build scope, treat them as the diagnosis source of truth. Fast-path is allowed ONLY after you re-fetch the current failing test list from CI and reconcile it one-by-one against tracker files. If \`.sisyphus/evidence/tests/\` is absent, if any current failing test lacks a tracker file, or if tracker count/status/error text disagrees with the live CI list, STOP and rebuild the per-test tracker set before editing code.

**Iteration ledger is mandatory**: every loop iteration MUST append ONE compact block to \`.sisyphus/evidence/repair-log.md\` capturing build number/revision, every failing test in scope, code files changed for each test or shared helper, verification result, push result, and next action. If the iteration touches code but no ledger block was appended, the iteration is incomplete.

**Why exactly 2 tasks:** Each task = ~2 min dispatch overhead + risk of parallel sessions editing the same file (duplicate ClassInitialize bug). One executor sees ALL changes holistically, avoids conflicts, pushes once.

**Coverage map** — table showing root cause group → failure count → confidence. Total must equal 100% of failures.

**NEVER split fixes into separate tasks by group.** If prior evidence/diagnosis exists from a previous iteration, embed it directly in Task 2's instructions — don't create a new Task 1.

Pre-digested fix instructions = ONE hypothesis for ONE group. Plan MUST still include full diagnosis to find ALL groups.

### Anti-Plan-Churn Guard
BEFORE generating a new CI fix plan, check \`.sisyphus/plans/\` for existing plans:
- If a plan exists that was created <24h ago AND covers >=80% of current build's failures with no NEW failure types: **DO NOT regenerate** — instruct the executor to continue the existing plan.
- If coverage <80% OR new failure types appeared (test name absent from plan, or error category changed): regenerate, but PRESERVE the existing plan's diagnosis for tests it already covers.
- **3+ plan regenerations without a push between them** = planner is looping. Stop planning, execute the latest plan as-is.
- ALWAYS read test tracker files in \`.sisyphus/evidence/tests/\` when regenerating a plan. If a test has 3+ failed attempts, the plan MUST explicitly prescribe a new strategy (not the one that already failed 3 times).

Why: constant re-planning costs ~2 min + tokens per cycle and produces no value when the failure set hasn't changed. Execute first, re-plan only when evidence changes.

---

## Per-Test Tracker System (MANDATORY)

Every failing test gets its own tracker file at \`.sisyphus/evidence/tests/{TestClass}.{TestMethod}.md\`. This is the single source of truth for each test's history.

### Tracker File Format
\`\`\`markdown
# {TestClass}.{TestMethod}
## Status: failing
## Root Cause Group: {group-name}
## Error: {short error ≤150 chars}
## Code Files: {comma-separated list of source files this test exercises}

## Fix History
| Build | Approach | Files Changed | Result |
|-------|----------|---------------|--------|
| #312 | seed UPSERT for [Scenarios] | SqlTestHelper.cs:132 | still fails (Expected 3 got 2) |
| #313 | added child rows to task group | SqlTestHelper.cs:165,200 | PASS |
\`\`\`

### Tracker Rules
1. **CREATE** a tracker file for every failing test during diagnosis (STEP 2). If the tracker already exists, UPDATE it — do not overwrite history.
2. **Status values**: \`failing\` (current build fails), \`fixed-pending\` (fix committed, awaiting CI), \`green\` (passed in CI).
3. **NEVER delete** a tracker file until the test passes in CI. Even if you think the fix worked, keep status as \`fixed-pending\` until confirmed.
4. **After CI results**: Update status to \`green\` for tests that passed. Delete tracker files for tests that have been \`green\` for 2 consecutive builds.
5. **Max file size**: 2KB per tracker. Keep Fix History to last 5 attempts. If over, prune oldest entries.
6. The "Code Files" field lists which source files the test depends on — used by pre-push audit to verify code was changed.

Missing tracker directory is a blocker for code edits. Create it and reconcile every current failing test into a tracker before editing code.

## Iteration Ledger (MANDATORY)

Append ONE block to \`.sisyphus/evidence/repair-log.md\` per loop iteration. Keep it compact and append-only.

Required block format:
\`\`\`markdown
## Iteration {N} — Build #{build} — rev {sha8}
- Failures in scope: {count} — {list or "see build-XXX-analysis.md"}
- Per-test ledger: {TestA -> tracker refreshed / TestB -> tracker refreshed / ...}
- Coverage map: {group -> tests}
- Code changed: {test/group -> files}
- Local verify: PASS | FAIL | SKIPPED ({reason})
- Push/CI status: pushed {sha8} | network blocked | waiting for build #{N}
- Conclusion: {what actually improved / regressed / stayed blocked}
- Next action: {single next step}
\`\`\`

Hard rules:
1. Every failing test from STEP 2 must appear either in the coverage map or in an explicit blocker line.
2. Every failing test from STEP 2 must also appear in the "Per-test ledger" line.
3. A single-file or shared-helper fix is allowed ONLY if every affected test is explicitly mapped to that file/helper in its tracker and in the iteration block.
4. Every code file changed in STEP 3 must appear in the "Code changed" line.
5. If \`git diff --name-only\` is non-empty and no new iteration block was appended, STOP and write it.
6. Keep \`repair-log.md\` under 8KB by retaining only the last 12 iteration blocks plus one top summary.
7. free-form narrative is forbidden in \`repair-log.md\`; every update must be a normalized iteration block plus, at most, one compact top summary.
8. After fetching the live failing test list for the current build, you MUST write/update tracker files, \`repair-log.md\`, and \`ci-loop-checkpoint.md\` BEFORE any source-code reads outside \`.sisyphus/evidence/\`.

### Reading Trackers Before Fixing
BEFORE writing any code fix, you MUST:
1. \`ls .sisyphus/evidence/tests/\` — list all tracker files
2. For EVERY current failing test, \`cat .sisyphus/evidence/tests/{file}\` — read its history
3. If a test has 2+ failed attempts with the same approach → choose a DIFFERENT strategy
4. If a test has 3+ failed attempts total → escalate: the root cause analysis is wrong, re-investigate from scratch

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

### Commit Message — Jira Prefix Required
Before your first commit, extract the Jira ticket from the branch name (\`git branch --show-current\`, e.g. \`bugfix/CMS-1765-playwright\` → \`CMS-1765\`). EVERY commit message MUST start with that ticket ID. Format: \`{TICKET} {type}({scope}): {description}\`. Example: \`CMS-1765 fix(playwright): stabilize grid filter\`. Bitbucket pre-receive hooks REJECT pushes containing commits without the Jira prefix — one bad commit blocks the entire push and wastes a CI iteration.

### Batch Strategy
**Diagnose ALL → Fix ALL → AUDIT → LOCAL TEST → Push ONCE.** One session, one commit, one push.

### Comprehensive Fix Mandate (HARD GATE)
Every fix session MUST attempt to resolve ALL known failures, not just the assigned subset. If you see a failing test whose fix is obvious from the evidence, fix it — even if it wasn't "your" task. The goal is zero failures per build, not zero failures per group.

### Stale Plan Detection (MANDATORY — run before STEP 3)
The plan may have been written for an OLDER build. Before applying fixes:
1. Fetch the ACTUAL latest build's failure count from CI API
2. Compare with the plan's stated failure count
3. If actual_failures > plan_failures: the plan is stale. The extra failures are REGRESSIONS from prior fix attempts. You MUST diagnose these new failures TOO — don't ignore them just because the plan doesn't mention them
4. If actual_failures < plan_failures: some tests were already fixed by prior commits. Verify which ones and skip those groups
5. Update tracker file statuses accordingly

### Deployment Phase First
BEFORE analyzing test failures, verify deployment/setup succeeded. Search build log for \`error :\` before test phase. If deployment failed, ALL test failures are symptoms — fix deployment first.

### Test Visibility
Always ensure: total = passed + failed + skipped. TRX artifacts mandatory. Build with 0 tests is NOT green.

---

## The Loop

\`\`\`
PRE-LOOP: Verify branch pushed, CI building correct revision.

LOOP:
  STEP 0: EVIDENCE EVICTION (MANDATORY — run BEFORE any other step, EVERY iteration)
    Run this EXACT command:
    ┌──────────────────────────────────────────────────────────────────────┐
    │ find .sisyphus/evidence -type f \\( -name "*.json" -o -name "*.log" │
    │   -o -name "*.trx" -o -name "*.xml" \\) -delete 2>/dev/null; │
    │ find .sisyphus/evidence -type f -size +10k \\                         │
    │   ! -name "repair-log.md" ! -name "ci-loop-checkpoint.md" -delete 2>/dev/null; │
    │ find .sisyphus/evidence -mindepth 1 -type d -empty -delete 2>/dev/null; │
    │ du -sh .sisyphus/evidence/                                         │
    └──────────────────────────────────────────────────────────────────────┘
    After running: \`du -sh\` MUST show < 500KB. If not, delete oldest .md files
    until < 400KB (keep test tracker files, repair-log.md, ci-loop-checkpoint.md, latest 2 build-*-analysis.md).
    NOTE: Do NOT delete .sisyphus/evidence/tests/ directory — those are per-test trackers.
    NOTE: \`repair-log.md\` and \`ci-loop-checkpoint.md\` are mandatory source-of-truth files. Never delete them just because they exceed 10KB; compact or rewrite them instead.

  STEP 1: PUSH + MONITOR
    Push fixes, verify CI picks up revision. Don't idle-wait — research next failure group while building.
    If Bamboo/Bitbucket monitoring GETs fail with certificate verification errors but git connectivity works, retry those READ-ONLY fetches with \`curl --insecure\` and continue. That is a CI observation TLS issue, not a push failure.
    NETWORK FAIL: If push fails (DNS NXDOMAIN, network unreachable, SSH timeout):
      1. git commit all changes locally (work is NOT lost)
      2. Save checkpoint: "NETWORK BLOCKED — N local commits ready to push"
      3. EXIT immediately. Do NOT retry DNS — 2 consecutive failures = confirmed blocked.

  STEP 2: ANALYZE (build done — ALWAYS fetch LIVE CI data)

    a) Fetch build SUMMARY from CI API. Record buildNumber + failedTestCount.
    b) \`mkdir -p .sisyphus/evidence/tests\` — ensure tracker directory exists.
    c) Read ALL existing tracker files: \`ls .sisyphus/evidence/tests/\` then read each one.
       For each tracker with status \`fixed-pending\`: check if the test passed in this build.
       - If passed → update status to \`green\`
       - If still failing → update status back to \`failing\`, add new row to Fix History
    d) Fetch EVERY failing test name + short error (≤150 chars each) via jq/python filter.
       **Count MUST equal failedTestCount from (a). If not, your filter is broken — fix it before proceeding.**
    e) For EACH failing test, create or update its tracker file:
       - If tracker exists: update Error field, keep Fix History
       - If new: create tracker with status \`failing\`, empty Fix History
    f) Classify each test: build-error|test-crash|test-timeout|test-assertion|setup-error|infra-error
    f1) **MATERIALIZE EVIDENCE NOW (hard gate)**: immediately write/update all per-test tracker files, \`build-{N}-analysis.md\`, \`repair-log.md\`, and \`ci-loop-checkpoint.md\` for the CURRENT build before any grep/read on source files outside \`.sisyphus/evidence/\`.
    f2) **ACTIVE PLAN REBASE (hard gate)**: if the active plan references an older build, older revision, wrong failing-test count, or a superseded Task 2 scope, rewrite the active plan immediately after evidence materialization so Task 1/Task 2 match the CURRENT build truth. Do not carry an old \`#315 / 15 fails\` Task 2 beside \`#317 / 14 fails\` evidence.

    Managed .sisyphus repo fast-path:
    - You may reuse existing diagnosis text ONLY after verifying that steps (b)-(f2) are already satisfied for the CURRENT build.
    - "Already satisfied" means: tracker directory exists, tracker count with current failing tests matches N, every current failing test has a tracker, each tracker's current Error / Root Cause Group / Status has been refreshed for this build, and the active plan itself now names the current build/revision/failure scope.
    - If any of those checks fail, DO NOT skip steps (b)-(f).
    - Only after that reconciliation and evidence materialization may you read existing dirty candidate files first, sample the minimal unresolved failure slices, and move to the first edit batch.
    g) Only for UNCLEAR failures: fetch ONE test's full error (≤500 chars). READ source code.
    h) Save compact build analysis to \`.sisyphus/evidence/build-{N}-analysis.md\` (MAX 3KB).
    i) **COVERAGE ACCOUNTING (hard gate)**: List all N failing tests by FullyQualifiedName.
       Verify: number of tracker files with status \`failing\` == N.
       If any test lacks a tracker → DO NOT proceed to STEP 3.
    j) Append/refresh the current iteration block in \`repair-log.md\` with: build number, revision, per-test ledger, failure list/coverage map, and investigation conclusion before editing code.
    k) If live CI list, tracker count/status, current-build analysis, checkpoint, and repair-log already agree, do ONE compact evidence append/update and then move DIRECTLY to STEP 3. Do NOT run extra bookkeeping loops like repeated \`wc -c\`, repeated clean-tree checks, or another evidence-only pass before the first code batch.

  STEP 3: FIX — ALL FAILURES IN ONE PASS

    a) Read EVERY tracker file in \`.sisyphus/evidence/tests/\` with status \`failing\`.
       For each: check Fix History. If previous approach failed → choose DIFFERENT strategy.
    b) For each test, identify which source files need changes (from tracker's Code Files field + test source code).
       If you intend to fix multiple tests via one shared file/helper, write that mapping explicitly into each affected tracker FIRST.
    c) Fix highest-leverage root cause first. Group tests sharing the same root cause.
    d) After ALL fixes applied, run: \`git diff --name-only\` — list ALL modified files.
    e) Run dotnet build to confirm compilation.
    f) Update each tracker: add Fix History row with build number, approach, files changed.
       Set status to \`fixed-pending\`.

  STEP 3.5: PRE-PUSH AUDIT + LOCAL TEST (MANDATORY HARD GATE — blocks push)

    ┌─────────────────────────────────────────────────────────────────────┐
    │ THIS STEP IS NOT OPTIONAL. SKIPPING IT = WASTING A CI CYCLE.      │
    │ If you push without completing ALL checks below, you are broken.  │
    └─────────────────────────────────────────────────────────────────────┘

    **A. Test Coverage Audit** (blocks everything — do FIRST):

    i)   Count failing tests from STEP 2: N = {failedTestCount}
    ii)  Count tracker files with status \`fixed-pending\`: M = {count}
    iii) **HARD CHECK: M must equal N.**
         If M < N: you forgot to fix some tests. List the missing ones. STOP and fix them.
         If M > N: some trackers are stale. Investigate and correct.
    iv)  Run: \`git diff --name-only\`
    v)   For EACH tracker file with status \`fixed-pending\`:
         - Read the tracker's "Code Files" list
         - Verify at least ONE of those files appears in \`git diff --name-only\`
         - If NONE of the test's code files were changed → you did NOT fix this test
    vi)  If any test has zero file changes → STOP. Go back to STEP 3.
    vii) Print audit summary:
         \`\`\`
         PRE-PUSH AUDIT:
         Failing tests:    N
         Tests with fixes: M
         Files changed:    K
         Coverage: {list each test → which file was changed for it}
         RESULT: PASS / FAIL (reason)
         \`\`\`
    viii) Copy the same PASS/FAIL summary into the current iteration block in \`repair-log.md\`.

    **B. Local Build Verification** (after audit passes):

    i)  \`dotnet build {Solution}.sln --nologo\`
    ii) If build fails → STOP. Fix build errors. Return to STEP 3.

    **C. Local Test Execution** (after build passes):

    i)   Build the filter expression covering ALL failing tests:
         \`FullyQualifiedName~Test1|FullyQualifiedName~Test2|...\`
         **CRITICAL**: The filter MUST include ALL N tests, not just 1. Print the filter before running.
    ii)  Run: \`dotnet test --filter "{FilterExpr}" --nologo --logger "trx;LogFileName=local-verify.trx" -- RunConfiguration.ResultsDirectory=./TestResults\`
    iii) **TRX VALIDATION (MANDATORY)**:
         After test run completes, parse the TRX file:
         \`\`\`bash
         python3 -c "
         import xml.etree.ElementTree as ET
         tree = ET.parse('TestResults/local-verify.trx')
         ns = {'t': 'http://microsoft.com/schemas/VisualStudio/TeamTest/2010'}
         results = tree.findall('.//t:UnitTestResult', ns)
         total = len(results)
         passed = sum(1 for r in results if r.get('outcome') == 'Passed')
         failed = sum(1 for r in results if r.get('outcome') == 'Failed')
         print(f'TRX: {total} total, {passed} passed, {failed} failed')
         if total == 0: print('ERROR: TRX has 0 results — filter expression is broken!')
         if total < EXPECTED: print(f'WARNING: Expected {EXPECTED} tests but TRX has {total} — some tests were not found by the filter')
         for r in results:
             name = r.get('testName', '?')
             outcome = r.get('outcome', '?')
             if outcome != 'Passed':
                 msg = (r.find('.//t:Message', ns) or ET.Element('x')).text or ''
                 print(f'  FAIL: {name}: {msg[:150]}')
         "
         \`\`\`
         Replace \`EXPECTED\` with the actual failing test count N.
    iv)  **HARD CHECK: TRX total must be >= N.**
         If TRX total == 0 → your filter expression is WRONG. Fix it and re-run.
         If TRX total == 1 but N > 1 → your filter is matching only ONE test. Fix the filter syntax (\`|\` not \`||\`, correct escaping).
         If TRX total < N → some tests were not found. Check test names match.
    v)   If all N tests pass locally → proceed to STEP 4.
    vi)  If any test fails locally → diagnose and fix BEFORE pushing. Return to STEP 3.
    vii) **IF local test infra unavailable** (no dotnet, no browser, CI-only tests):
         - Document: "LOCAL VERIFY SKIPPED: {reason}"
         - This is acceptable ONLY if: (a) tests require Windows/CI-specific infrastructure that cannot run locally, AND (b) you attempted to run them and got an infra error (not a test logic error)
         - Still MUST complete the coverage audit (step A) — that is never skippable
    viii) Clean up: \`rm -rf TestResults/\` — do not commit test artifacts.

  STEP 4: COMMIT + PUSH + RECORD

    a) Stage ONLY changed source files: \`git add <file1> <file2> ...\`
       **NEVER \`git add -A\` or \`git add .\`**
       Verify: \`git diff --staged --stat\` — only source files, no .sisyphus/, no TestResults/
    b) Commit with Jira prefix.
    c) For EACH test with status \`fixed-pending\`, the tracker already has the attempt recorded from STEP 3.
    d) Update the current \`repair-log.md\` iteration block with commit SHA, push result, and exact next action.
    e) Push. → GOTO STEP 1

EXIT: GREEN (0 failures) | NETWORK BLOCKED (2 push fails → commit + checkpoint + stop) | BLOCKED (infra down, 3 retries) | TOKEN LIMIT (checkpoint first)
\`\`\`

## Evidence Rules

Only these files/directories MAY exist in \`.sisyphus/evidence/\`:
- \`ci-loop-checkpoint.md\` — single file, overwritten each iteration, max 50 lines
- \`repair-log.md\` — append-only iteration ledger, max 8KB, keep last 12 iteration blocks + summary
- \`build-{N}-analysis.md\` — structured table + next-steps, max 3KB each, keep latest 2
- \`tests/\` — directory of per-test tracker files (NEVER delete this directory)
- \`tests/{TestClass}.{TestMethod}.md\` — per-test tracker, max 2KB each

Everything else is GARBAGE and gets deleted by STEP 0 every iteration.

## Fix Priority
P0 build error > P0.5 setup/DB error > P1 test crash > P2 assertion > P3 timeout > P4 infra/flaky.
If >50% failures share one root cause, that IS the fix.

## Forbidden
- Fixing code before ALL tracker files are created for ALL failing tests
- Fixing only one file without explicitly proving in tracker files that every failing test maps to that shared file/helper
- Fixing tests one-by-one without analyzing ALL failures first
- Pushing without completing the pre-push audit (STEP 3.5A)
- Pushing without running local tests (STEP 3.5C) — unless infra is unavailable
- Pushing when TRX shows 0 or 1 test result but N > 1 (broken filter expression)
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
- Committing without Jira ticket prefix (extract from branch name)
- Using \`git add -A\` or \`git add .\`
- Using \`IF NOT EXISTS INSERT\` without a follow-up UPDATE for SQL seed data
- Adding \`[TestInitialize]\` to derived classes without reading the base class first
- Removing base class \`[TestInitialize]\` calls to "move" them to derived
- Saving raw Bamboo API JSON, full build logs, or TRX files to \`.sisyphus/evidence/\`
- Retrying the SAME fix approach that already failed (check tracker Fix History FIRST)
- Deleting tracker files for tests that haven't been confirmed green in CI

## Post-Green
1. Verify green build ran YOUR branch HEAD
2. Verify all shards completed, test count matches expected (no silent drops)
3. Verify TRX artifacts exist
4. Update all tracker files: status → \`green\`
5. Clean up: delete tracker files for tests green in 2+ consecutive builds

## Checkpoint
Write to \`.sisyphus/evidence/ci-loop-checkpoint.md\`: branch state, latest build (number/state/duration/pass/fail), iteration history table, current failures, next steps.
**OVERWRITE, don't append.** Checkpoint is a snapshot, not a log. Max 50 lines.

**Checkpoint MUST reference test trackers:** Include: "Test trackers: N files in .sisyphus/evidence/tests/ — {M failing, K fixed-pending, J green}".
**Checkpoint MUST reference repair-log:** Include the latest iteration number and one-line conclusion copied from \`repair-log.md\`.
`,
}
