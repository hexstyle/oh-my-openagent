export const START_WORK_TEMPLATE = `You are starting a Sisyphus work session.

## ARGUMENTS

- \`/start-work [plan-name] [--worktree <path>]\`
  - \`plan-name\` (optional): name or partial match of the plan to start
  - \`--worktree <path>\` (optional): absolute path to an existing git worktree to work in
    - If specified and valid: hook pre-sets worktree_path in boulder.json
    - If specified but invalid: you must run \`git worktree add <path> <branch>\` first
    - If omitted: work directly in the current project directory (no worktree)

## WHAT TO DO

1. **Find available plans**: Search for Prometheus-generated plan files at \`.sisyphus/plans/\`

2. **Check for active boulder state**: Read \`.sisyphus/boulder.json\` if it exists

3. **Decision logic**:
   - If \`.sisyphus/boulder.json\` exists AND plan is NOT complete:
     - **APPEND** current session to session_ids
     - **Validate evidence freshness AND size**: Check timestamps AND sizes of \`.sisyphus/evidence/\` files. If checkpoint/evidence files are >24h old, treat their claims (blockers, network status, build state) as STALE — verify current state before trusting them. Overwrite stale checkpoints rather than appending. If any evidence file >10KB, delete it before proceeding — it is raw data that will bloat agent context.
     - Continue work on existing plan
   - If no active plan OR plan is complete:
     - List available plan files
     - If ONE plan: auto-select it
     - If MULTIPLE plans: show list with timestamps, ask user to select

**IMPORTANT**: plan completion is evidence-gated, not checkbox-gated.
- Do NOT treat a task as complete from \`- [x]\` alone
- If a task references required \`.sisyphus/evidence/...\` artifacts and those files/directories are missing or empty, that task is still incomplete
- Use evidence-gated progress when deciding whether to resume, auto-select, or declare all plans complete

4. **Worktree Setup** (ONLY when \`--worktree\` was explicitly specified and \`worktree_path\` not already set in boulder.json):
   1. \`git worktree list --porcelain\` — see available worktrees
   2. Create: \`git worktree add <absolute-path> <branch-or-HEAD>\`
   3. Update boulder.json to add \`"worktree_path": "<absolute-path>"\`
   4. All work happens inside that worktree directory

5. **Create/Update boulder.json**:
   \`\`\`json
   {
     "active_plan": "/absolute/path/to/plan.md",
     "started_at": "ISO_TIMESTAMP",
     "session_ids": ["session_id_1", "session_id_2"],
     "plan_name": "plan-name",
     "worktree_path": "/absolute/path/to/git/worktree"
   }
   \`\`\`

6. **Read the plan file** and start executing tasks according to atlas workflow

## OUTPUT FORMAT

When listing plans for selection:
\`\`\`
Available Work Plans

Current Time: {ISO timestamp}
Session ID: {current session id}

1. [plan-name-1.md] - Modified: {date} - Progress: 3/10 tasks
2. [plan-name-2.md] - Modified: {date} - Progress: 0/5 tasks

Which plan would you like to work on? (Enter number or plan name)
\`\`\`

When resuming existing work:
\`\`\`
Resuming Work Session

Active Plan: {plan-name}
Progress: {completed}/{total} tasks
Sessions: {count} (appending current session)
Worktree: {worktree_path}

Reading plan and continuing from last incomplete task...
\`\`\`

When auto-selecting single plan:
\`\`\`
Starting Work Session

Plan: {plan-name}
Session ID: {session_id}
Started: {timestamp}
Worktree: {worktree_path}

Reading plan and beginning execution...
\`\`\`

## CRITICAL

- The session_id is injected by the hook - use it directly
- Always update boulder.json BEFORE starting work
- If worktree_path is set in boulder.json, all work happens inside that worktree directory
- Read the FULL plan file before delegating any tasks
- Follow atlas delegation protocols (7-section format)

## EVIDENCE HYGIENE CHECK (MANDATORY — run before reading the plan)

Run this command FIRST, unconditionally:
\`\`\`bash
find .sisyphus/evidence -type f \\( -name "*.json" -o -name "*.log" -o -name "*.trx" -o -name "*.xml" -o -size +10k \\) -not -path "*/tests/*" -delete 2>/dev/null; find .sisyphus/evidence -mindepth 1 -type d -empty -not -name "tests" -delete 2>/dev/null; du -sh .sisyphus/evidence/ 2>/dev/null
\`\`\`

Then check the result:
- **If still > 500KB**: Delete oldest .md files until < 400KB. Keep: \`tests/\` directory (per-test trackers), \`ci-loop-checkpoint.md\`, latest 2 \`build-*-analysis.md\`.
- Also keep \`repair-log.md\` — it is the append-only iteration ledger for CI loops.
- **NEVER delete** \`.sisyphus/evidence/tests/\` — those are per-test tracker files with fix history.
- **Report**: "Evidence cleanup: {before}MB → {after}KB, deleted {N} files. Test trackers: {M} files preserved."

This removes raw API dumps, full build logs, and oversized files that previous sessions left behind. The ci-green-loop skill runs the same eviction at STEP 0 of every iteration.

## GIT STAGING HYGIENE

**NEVER use \`git add -A\` or \`git add .\`** — these stage everything including .sisyphus/, test artifacts, cache directories, and other files that must NOT be committed.

Always:
1. Stage specific files: \`git add <file1> <file2> ...\`
2. Verify before committing: \`git diff --staged --stat\` — check that ONLY intended source files are staged
3. If a plan's commit instructions say \`git add -A\`, override with explicit file staging

This applies to ALL executors and sub-tasks. A commit that includes .sisyphus/ or test cache files is a broken commit.

## TASK BREAKDOWN

After reading the plan file, decompose plan tasks into implementation-level sub-steps as task/todo items BEFORE starting work.

**CI GREEN LOOP PLANS — FAST PATH (skip decomposition entirely)**: If the plan's skills include \`ci-green-loop\` or \`bamboo-ci\` or \`dotnet-playwright\`, AND it has a Diagnosis task and a Fix-all task (ignore F-prefixed verification tasks like F1, F2, F3): do NOT decompose, do NOT create TodoWrite items, do NOT initialize notepads, do NOT read test files or run git show/diff. Check if Task 1 evidence exists in \`.sisyphus/evidence/\`. If yes, delegate Task 2 directly as ONE task() with the plan's instructions. If no, delegate Task 1 first, then Task 2. The delegation MUST tell the executor to update both \`repair-log.md\` (append current iteration block) and \`ci-loop-checkpoint.md\` (overwrite snapshot) during the iteration. This is the ONLY workflow for CI plans — no ceremony, no investigation.

**How to break down**:
- Each plan checkbox item (e.g., \`- [ ] Add user authentication\`) must be split into concrete, actionable sub-tasks
- Sub-tasks should be specific enough that each one touches a clear set of files/functions
- Include: file to modify, what to change, expected behavior, and how to verify
- Do NOT leave any task vague — "implement feature X" is NOT acceptable; "add validateToken() to src/auth/middleware.ts that checks JWT expiry and returns 401" IS acceptable

**Example breakdown**:
Plan task: \`- [ ] Add rate limiting to API\`
→ Todo items:
  1. Create \`src/middleware/rate-limiter.ts\` with sliding window algorithm (max 100 req/min per IP)
  2. Add RateLimiter middleware to \`src/app.ts\` router chain, before auth middleware
  3. Add rate limit headers (X-RateLimit-Limit, X-RateLimit-Remaining) to response in \`rate-limiter.ts\`
  4. Add test: verify 429 response after exceeding limit in \`src/middleware/rate-limiter.test.ts\`
  5. Add test: verify headers are present on normal responses

Register these as task/todo items so progress is tracked and visible throughout the session.

## WORKTREE COMPLETION

When working in a worktree (\`worktree_path\` is set in boulder.json) and ALL plan tasks are complete:
1. Commit all remaining changes in the worktree
2. **Sync .sisyphus state back**: Copy \`.sisyphus/\` from the worktree to the main repo before removal.
   This is CRITICAL when \`.sisyphus/\` is gitignored — state written during worktree execution would otherwise be lost.
   \`\`\`bash
   cp -r <worktree-path>/.sisyphus/* <main-repo>/.sisyphus/ 2>/dev/null || true
   \`\`\`
3. Switch to the main working directory (the original repo, NOT the worktree)
4. Merge the worktree branch into the current branch: \`git merge <worktree-branch>\`
5. If merge succeeds, clean up: \`git worktree remove <worktree-path>\`
6. Remove the boulder.json state

This is the DEFAULT behavior when \`--worktree\` was used. Skip merge only if the user explicitly instructs otherwise (e.g., asks to create a PR instead).`
