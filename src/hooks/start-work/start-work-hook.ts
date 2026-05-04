import { statSync, readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"
import { stripSingleEnclosingQuotes } from "../../shared/strip-enclosing-quotes"
import {
  readBoulderState,
  writeBoulderState,
  findPrometheusPlans,
  getPlanProgress,
  createBoulderState,
  getPlanName,
  clearBoulderState,
} from "../../features/boulder-state"
import { log } from "../../shared/logger"
import { getAgentDisplayName } from "../../shared/agent-display-names"
import { setSessionFlag } from "../../shared/session-tools-store"
import { getSessionAgent, isAgentRegistered, updateSessionAgent } from "../../features/claude-code-session-state"
import { detectWorktreePath } from "./worktree-detector"
import { parseUserRequest } from "./parse-user-request"

export const HOOK_NAME = "start-work" as const

interface StartWorkHookInput {
  sessionID: string
  messageID?: string
}

interface StartWorkCommandExecuteBeforeInput {
  sessionID: string
  command: string
  arguments: string
}

interface StartWorkHookOutput {
  message?: Record<string, unknown>
  parts: Array<{ type: string; text?: string }>
}

function isStartWorkPrompt(promptText: string): boolean {
  const trimmed = stripSingleEnclosingQuotes(promptText)
  return /(^|\n)\s*\/start-work\b/.test(trimmed)
    || promptText.includes("# /start-work Command")
    || promptText.includes("You are starting a Sisyphus work session.")
}

function findPlanByName(plans: string[], requestedName: string): string | null {
  const lowerName = requestedName.toLowerCase()
  const exactMatch = plans.find((p) => getPlanName(p).toLowerCase() === lowerName)
  if (exactMatch) return exactMatch
  const partialMatch = plans.find((p) => getPlanName(p).toLowerCase().includes(lowerName))
  return partialMatch || null
}

function createWorktreeActiveBlock(worktreePath: string): string {
  return `
## Worktree Active

**Worktree**: \`${worktreePath}\`

**CRITICAL — DO NOT FORGET**: You are working inside a git worktree. ALL operations MUST be performed exclusively within this worktree directory.
- Every file read, write, edit, and git operation MUST target paths under: \`${worktreePath}\`
- When delegating tasks to subagents, you MUST include the worktree path in your delegation prompt so they also operate exclusively within the worktree
- NEVER operate on the main repository directory — always use the worktree path above`
}

function resolveWorktreeContext(
  explicitWorktreePath: string | null,
): { worktreePath: string | undefined; block: string } {
  if (explicitWorktreePath === null) {
    return { worktreePath: undefined, block: "" }
  }

  const validatedPath = detectWorktreePath(explicitWorktreePath)
  if (validatedPath) {
    return { worktreePath: validatedPath, block: createWorktreeActiveBlock(validatedPath) }
  }

  return {
    worktreePath: undefined,
    block: `\n**Worktree** (needs setup): \`git worktree add ${explicitWorktreePath} <branch>\`, then add \`"worktree_path"\` to boulder.json`,
  }
}

function createDelegationKickoffBlock(): string {
  return `
## Delegation Kickoff

After refreshing plan and boulder state, delegate tasks immediately.

- When unblocked tasks are independent AND touch different files, delegate IN PARALLEL
- **CI green plans (FAST PATH)**: The plan's skills include \`ci-green-loop\` / \`bamboo-ci\` / \`dotnet-playwright\` and it has a Diagnosis task + Fix-all task (ignore F-prefixed verification tasks). Use the CI Green Loop Fast Path from your system prompt: skip TodoWrite, skip notepad, skip per-delegation verification, DO NOT read test files or run git show/diff. If Task 1 evidence already exists in \`.sisyphus/evidence/\`, delegate Task 2 directly. Task 2 is ONE comprehensive session that fixes EVERYTHING — do NOT split, do NOT investigate from Atlas, do NOT pad the prompt. The executor handles verification via ci-green-loop STEP 3.5.
- Keep your own work minimal: refresh state → delegate → done
- Do not investigate implementation details yourself before delegating — that's the subagent's job
- If a task touches many files, delegate it as ONE task to ONE agent — do NOT split by file or group`
}

const CI_SKILL_PATTERN = /\bci-green-loop\b|\bbamboo-ci\b|\bdotnet-playwright\b/
const CI_TASK_CATEGORY_PATTERN = /\|\s*(?:Iteration|T2)\s*\|[^|]*\|\s*`(\w[\w-]*)`\s*\(load_skills=`([^`]+)`/

interface CIFastPathResult {
  active: boolean
  block: string
}

function parseFirstInt(value: string | undefined): number | null {
  if (!value) return null
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

function extractPlanBuildNumber(planPath: string, content: string): number | null {
  const fromPath = planPath.match(/build[-_]?(\d+)/i)?.[1]
  if (fromPath) return parseFirstInt(fromPath)
  const fromContent = content.match(/build\s*#?(\d+)/i)?.[1]
  return parseFirstInt(fromContent)
}

function extractPlanFailureTarget(content: string): number | null {
  const exactFix = content.match(/exact code changes for\s+(\d+)\s+remaining failures/i)?.[1]
  if (exactFix) return parseFirstInt(exactFix)
  const generic = content.match(/(\d+)\s+(?:remaining\s+)?failures\b/i)?.[1]
  return parseFirstInt(generic)
}

function hasSpeculativeTaskTwoContent(content: string): boolean {
  const taskTwoSection = content.match(/- \[[ xX]\]\s*2\..*?(?=\n- \[[ xX]\]\s*\d+\.|\Z)/is)?.[0] ?? content
  return /\bInvestigate\b|NOT a code fix|Quick fix:|might be server-side|If .* still failing:/i.test(taskTwoSection)
}

function extractCheckpointFailureCount(checkpoint: string): number | null {
  const failMatch = checkpoint.match(/(?:failed|fails)[:\s]*(\d+)/i)?.[1]
  return parseFirstInt(failMatch)
}

function extractLatestEvidenceBuildNumber(evidenceFiles: string[]): number | null {
  const buildNumbers = evidenceFiles
    .map((file) => file.match(/^build-(\d+)[^-]*.*\.md$/i)?.[1] ?? file.match(/build[-_]?(\d+)/i)?.[1] ?? null)
    .map((value) => parseFirstInt(value ?? undefined))
    .filter((value): value is number => value !== null)

  if (buildNumbers.length === 0) return null
  return Math.max(...buildNumbers)
}

function selectCurrentEvidenceFiles(evidenceFiles: string[], latestBuildNumber: number | null): string[] {
  const preferred = new Set<string>(["ci-loop-checkpoint.md", "repair-log.md"])
  if (latestBuildNumber !== null) {
    for (const file of evidenceFiles) {
      if (file.includes(`build-${latestBuildNumber}`)) {
        preferred.add(file)
      }
    }
  }

  const selected = evidenceFiles.filter((file) => preferred.has(file))
  return selected.length > 0 ? selected : evidenceFiles
}

function detectCIFastPath(planPath: string, projectDir: string): CIFastPathResult {
  const inactive: CIFastPathResult = { active: false, block: "" }
  try {
    log("[start-work] CI fast path check START", { planPath, projectDir })
    if (!existsSync(planPath)) {
      log("[start-work] CI fast path: plan not found", { planPath })
      return inactive
    }
    const content = readFileSync(planPath, "utf-8")

    if (!CI_SKILL_PATTERN.test(content)) {
      log("[start-work] CI fast path: no CI skill match", { planPath })
      return inactive
    }

    const lines = content.split(/\r?\n/)
    let task1Checked = false
    let task2Unchecked = false
    let task2StartLine = -1

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const m = line.match(/^- \[([ xX])\]\s*(\d+)\.\s*\*\*(.+?)\*\*/)
      if (m) {
        const num = parseInt(m[2], 10)
        const checked = m[1].toLowerCase() === "x"
        if (num === 1 && checked) task1Checked = true
        if (num === 2 && !checked) {
          task2Unchecked = true
          task2StartLine = i
        }
      }
    }

    // If Task 2 is [x] but CI checkpoint shows failures > 0, override to unchecked
    let task2FalsePositive = false
    if (task1Checked && !task2Unchecked) {
      const checkpointPath = join(projectDir, ".sisyphus", "evidence", "ci-loop-checkpoint.md")
      if (existsSync(checkpointPath)) {
        const checkpoint = readFileSync(checkpointPath, "utf-8")
        const failMatch = checkpoint.match(/(?:failed|fails)[:\s]*(\d+)/i)
        if (failMatch && parseInt(failMatch[1], 10) > 0) {
          task2Unchecked = true
          task2FalsePositive = true
          // Find task2StartLine if we didn't already
          if (task2StartLine < 0) {
            for (let i = 0; i < lines.length; i++) {
              const m = lines[i].match(/^- \[([ xX])\]\s*(\d+)\.\s*\*\*(.+?)\*\*/)
              if (m && parseInt(m[2], 10) === 2) { task2StartLine = i; break }
            }
          }
          log("[start-work] CI fast path: Task 2 [x] overridden — checkpoint shows failures", {
            failures: failMatch[1],
          })
        }
      }
    }

    log("[start-work] CI fast path task state", { task1Checked, task2Unchecked, task2StartLine, task2FalsePositive })
    if (!task1Checked || !task2Unchecked || task2StartLine < 0) return inactive

    const evidenceDir = join(projectDir, ".sisyphus", "evidence")
    if (!existsSync(evidenceDir)) {
      log("[start-work] CI fast path: evidence dir missing", { evidenceDir })
      return inactive
    }
    const evidenceFiles = readdirSync(evidenceDir).filter((f) => f.endsWith(".md"))
    if (evidenceFiles.length === 0) {
      log("[start-work] CI fast path: no evidence .md files", { evidenceDir })
      return inactive
    }

    for (const line of lines) {
      const catMatch = line.match(CI_TASK_CATEGORY_PATTERN)
      if (catMatch) {
        break
      }
    }

    const latestEvidenceBuildNumber = extractLatestEvidenceBuildNumber(evidenceFiles)
    const selectedEvidenceFiles = selectCurrentEvidenceFiles(evidenceFiles, latestEvidenceBuildNumber)
    const evidencePaths = selectedEvidenceFiles.map((f) => ".sisyphus/evidence/" + f).join(", ")
    const planRelPath = planPath.startsWith(projectDir)
      ? planPath.slice(projectDir.length + 1)
      : planPath
    const planBuildNumber = extractPlanBuildNumber(planPath, content)
    const planFailureTarget = extractPlanFailureTarget(content)
    const speculativeTaskTwo = hasSpeculativeTaskTwoContent(content)

    // Check for per-test tracker files
    const testsDir = join(projectDir, ".sisyphus", "evidence", "tests")
    let testTrackerInfo = ""
    if (existsSync(testsDir)) {
      const trackerFiles = readdirSync(testsDir).filter((f) => f.endsWith(".md"))
      if (trackerFiles.length > 0) {
        testTrackerInfo = "\\nRead per-test tracker files in `.sisyphus/evidence/tests/` (" + trackerFiles.length + " files) — each contains fix history for a specific test. Do NOT repeat approaches that already failed. Canonical reconciliation counts only the tracker files that map one-to-one to the CURRENT live failing tests; legacy alias/build-summary notes are supplemental context and must not block the first evidence write batch or inflate the failing tracker count. Before pushing, canonical tracker counts/statuses must reconcile with the current failing-test count."
      }
    }

    const checkpointPath = join(projectDir, ".sisyphus", "evidence", "ci-loop-checkpoint.md")
    const checkpointText = existsSync(checkpointPath) ? readFileSync(checkpointPath, "utf-8") : ""
    const checkpointFailureCount = extractCheckpointFailureCount(checkpointText)

    let stalePlanInfo = ""
    if (planBuildNumber !== null && latestEvidenceBuildNumber !== null && latestEvidenceBuildNumber > planBuildNumber) {
      stalePlanInfo = "STALE PLAN REBASE REQUIRED: the active plan targets build #" + planBuildNumber + " but the latest evidence is build #" + latestEvidenceBuildNumber + ". Before any source-code reads outside .sisyphus/evidence/, rewrite the active plan itself so Task 1/Task 2 target the newer build evidence, include any newly-failing tests in scope, and update repair-log/checkpoint to reflect the rebased build."
    }

    let failureDriftInfo = ""
    if (planFailureTarget !== null && checkpointFailureCount !== null && checkpointFailureCount !== planFailureTarget) {
      failureDriftInfo = "FAILURE-COUNT DRIFT: the plan targets " + planFailureTarget + " failures but the current checkpoint reports " + checkpointFailureCount + ". Treat the latest checkpoint/build evidence as authoritative, reconcile the delta before code edits, and do not execute an outdated fix batch blindly."
    }

    let planRewriteInfo = ""
    if (speculativeTaskTwo) {
      planRewriteInfo = "TASK-2 REWRITE REQUIRED: the active fix task still contains speculative investigation language (`Investigate`, `NOT a code fix`, quick-fix placeholders, or server-side guesses). Before code edits, rewrite Task 2 against current evidence into an execution-ready fix batch with concrete root-cause actions and no stale placeholder guidance."
    }

    const block = [
      "CI FAST PATH — ACTIVE",
      "",
      "Fix ALL failing tests in Bamboo build and drive failedTestCount to 0.",
      "",
      "## CONTEXT",
      "The `/start-work` plan slug may still mention an older build number. Treat that slug as a historical plan name only. Live CI truth must come from the current/latest Bamboo build for this branch, not from `build314` embedded in the slash command or plan filename.",
      "Use the current session id already provided by `/start-work`; do NOT call `session_list`, do NOT use `session_search`, do NOT query `printenv SESSION_ID`, and do NOT spend a turn rediscovering runtime metadata that is already in this prompt.",
      "Read the plan file at `" + planRelPath + "` — it contains the complete root-cause analysis, fix instructions for all failure groups, and evidence paths.",
      "Do NOT rename the active plan file path just because it still contains an older build number in its filename. Rebase the plan by editing its contents in place and updating `boulder.json` references only if they are actually stale.",
      "Read evidence files: " + evidencePaths,
      "The checkpoint and repair-log live ONLY at `.sisyphus/evidence/ci-loop-checkpoint.md` and `.sisyphus/evidence/repair-log.md`. Never probe `.sisyphus/ci-loop-checkpoint.md` or `.sisyphus/repair-log.md`.",
      "During the evidence gate, do NOT read any `.sisyphus/*.md` path outside the active plan file and `.sisyphus/evidence/*`. If you need current-build truth, fetch it and write it back into the evidence files instead of probing alternative legacy paths.",
      "Read only the core CI evidence first: `AGENTS.md`, `.sisyphus/boulder.json`, active plan, `ci-loop-checkpoint.md`, `repair-log.md`, CURRENT-build analysis/failure analysis, and `.sisyphus/evidence/tests/`. Older `build-*.md` files are archived context only — do not read them unless the current-build files or trackers are missing required detail. Check the tracker directory only with `test -d` or `ls` — NEVER use a file-read tool on the directory path. If the tests directory is absent, that is a blocker: create/rebuild the tracker set for the current failing list before code edits or push logic. Do NOT glob historical notepads or `.sisyphus/run-continuation/` unless the core evidence is insufficient.",
      "For tracker reconciliation, count only canonical per-test trackers that map one-to-one to the CURRENT live failing tests. Legacy alias/build-summary tracker notes may stay on disk for history, but they are supplemental context only and must not block the first evidence write batch or inflate the failing tracker count.",
      "During CI fast-path Bamboo fetches, do NOT use `webfetch`. Define an inline shell `fetch_json()` helper in the same bash block, following the Bamboo skill pattern, so certificate fallback, JSON parsing, and compact extraction stay deterministic.",
      "Never print or save raw Bamboo JSON. Every Bamboo fetch must emit only compact extracted facts: build number, revision, failed-test count, and the current failing test names plus short errors. If a shell fetch prints a JSON document, that fetch was wrong — fix the command before continuing.",
      "For Bamboo JSON parsing, use multi-line shell with an inline `fetch_json()` helper plus `python3 <<'PY'` heredocs. Do NOT use `python3 -c`, do NOT pipe raw `curl` directly into Python, and do NOT dump plan-level `testResults` blobs into context.",
      "Use the plan-level Bamboo endpoint only for summary fields like `buildNumber`, `failedTestCount`, and `vcsRevisionKey`. To enumerate failing tests, fetch the JOB1 result endpoint with `expand=testResults.failedTests.testResult` and extract names plus short errors there. The extracted failing-test list MUST contain exactly `failedTestCount` items; if it does not, your endpoint or parser is wrong and you must fix that before continuing.",
      "Use an exact working shell shape for Bamboo parsing. First define `fetch_json()` inline in the same bash block, then run `JSON=\"$(fetch_json \\\"https://.../latest.json\\\")\"` followed by `JSON=\"$JSON\" python3 <<'PY'` and `data = json.loads(os.environ['JSON'])`. If you need a temp file, invoke the parser as `python3 - \"$tmp\" <<'PY'` and read `sys.argv[1]`. Do NOT run the JSON file itself as Python code, and do not rely on heredoc + here-string combinations that can drop stdin in zsh.",
      "For Bamboo failed tests, parse `testResults.failedTests.testResult[]` entries using `className` + `methodName` (or `testName` if present) for the test id, and `errors.error[].message` for the short error text. Do NOT treat the nested `errors` object itself as the message, and do not accept `<unknown>` names when `className`/`methodName` are present.",
      "FIRST RESPONSE CONTRACT: once the live CI failing list for the current build has been fetched, the first working response must end with updated tracker files plus updated `repair-log.md` and `ci-loop-checkpoint.md` on disk for that same build. Planning to update them later is invalid.",
      stalePlanInfo,
      failureDriftInfo,
      planRewriteInfo,
      "If present, read `.sisyphus/evidence/ci-loop-checkpoint.md` and `.sisyphus/evidence/repair-log.md` before changing code.",
      testTrackerInfo ? "Read `.sisyphus/evidence/tests/` for per-test tracker files with fix history." + testTrackerInfo : "",
      "",
      "## MANDATORY WORKFLOW",
      "1. Read the plan file and ALL evidence files listed above",
      "1.5 If stale-plan rebase, failure-count drift, or Task-2 rewrite was detected above, rewrite the active plan on disk against the latest build evidence before any source-code reads outside `.sisyphus/evidence/`.",
      "2. Validate `.sisyphus/evidence/repair-log.md`: the latest entry must be an `## Iteration ...` block with failures in scope, coverage map, code changed, local verify, push/CI status, conclusion, and next action. If the file is missing or free-form, normalize it before editing code.",
      "3. If the plan, checkpoint, and repair-log disagree on root cause, reconcile the conflicting hypotheses in evidence before editing code.",
      "3.1 If the live CI fetch shows a new build, a changed failing-test set, or any missing/stale tracker, the very next write-capable action must be updating tracker files, `repair-log.md`, and `ci-loop-checkpoint.md` on disk for the current build. Do not spend another loop re-reading trackers or refetching Bamboo unless one current failing test still lacks even a short error or one stack/details slice.",
      "3.1.1 Hard gate: the first post-fetch working turn is incomplete unless those evidence files now reflect the current build on disk. Do not end that turn with only notes, todo updates, or extra source reads.",
      "3.1.2 Evidence writes are in-place document updates, not file-path churn. Prefer one deterministic write batch that rewrites tracker/checkpoint/repair-log contents from the live failing set. Do NOT waste a turn on fragile `apply_patch` hunks against stale evidence text; if needed, rewrite the whole evidence document from the freshly-read current file.",
      "3.2 Once the live CI list, tracker set, current-build analysis, checkpoint, and repair-log all agree, do one compact evidence update and move directly into the constrained source pass. Do NOT burn time on repeated `wc`, repeated clean-tree checks, or another evidence-only loop before the first edit batch.",
      "3.5 After evidence is reconciled, limit source discovery to the dirty candidate files, the directly failing tests/helpers, and only the minimal app/runtime files needed to name a concrete code action for each failure cluster. Then start the edit batch immediately.",
      "4. For each failing test: check if a previous fix was attempted — if so, choose a DIFFERENT strategy",
      "5. Apply ALL fixes in one pass (every failing test must be addressed, not just some)",
      "6. Update `.sisyphus/evidence/repair-log.md` with the current iteration block: build/revision, failures covered, files changed, local verify result, push result, conclusion, next action. Distinguish trigger-only builds from code-changing revisions.",
      "7. PRE-PUSH AUDIT: verify git diff covers ALL failing tests, canonical tracker counts/statuses reconcile with the current failing-test count, every current failing test has a current-iteration tracker update plus concrete fix path or blocker conclusion, and the pre-push gate is satisfied: `dotnet build`, local targeted test filter, staged-tree/symbol completeness.",
      "8. Update `.sisyphus/evidence/ci-loop-checkpoint.md` so it matches the latest repair-log conclusion, latest build/revision, trigger-only/code-changing status, and tracker counts",
      "8.5 POST-PUSH MONITOR: after push, monitor the numbered build created for that revision plus the branch recent-results feed. Do NOT rely on `latest.json` alone during trigger lag or overlapping builds, and do not trust queue/concurrency responses as proof that no newer build exists.",
      "9. Ownership is explicit: Atlas owns dispatch only; the executor owns evidence updates, verification, commit/push, and final DoD accounting.",
      "10. git add <specific files only> — NEVER git add -A",
      "11. git commit and git push to trigger CI",
    ].filter(Boolean).join("\n")

    log("[start-work] CI fast path detected", { planPath, evidenceFiles })
    return { active: true, block }
  } catch (e) {
    log("[start-work] CI fast path detection failed", { error: String(e) })
    return inactive
  }
}

function createEvidenceGateBlock(): string {
  return `
## Evidence-Gated Progress

- Plan completion is NOT determined by checkbox state alone
- A checked task with required evidence paths is still INCOMPLETE until those files/directories actually exist
- If a QA/Evidence line references \`.sisyphus/evidence/...\` and that artifact is missing or empty, keep treating the task as remaining work
- Checked boxes without required evidence remain incomplete
- **Conversely**: unchecked boxes whose evidence artifacts ALREADY EXIST (non-empty files at the referenced paths) should be treated as COMPLETE — skip to the next task. A previous session may have produced the evidence without checking the boxes.
- Do not announce "all complete" from raw \`- [x]\` counts alone`
}

export function createStartWorkHook(ctx: PluginInput) {
  const injectStartWorkContext = async (
    sessionId: string,
    promptText: string,
    output: StartWorkHookOutput,
  ): Promise<void> => {
    if (!isStartWorkPrompt(promptText)) return

    log(`[${HOOK_NAME}] Processing start-work command`, { sessionID: sessionId })
    const activeAgent = isAgentRegistered("atlas")
      ? "atlas"
      : getSessionAgent(sessionId) ?? "sisyphus"
    const activeAgentDisplayName = getAgentDisplayName(activeAgent)
    updateSessionAgent(sessionId, activeAgent)
    if (output.message) {
      output.message["agent"] = activeAgentDisplayName
    }

    const existingState = readBoulderState(ctx.directory)
    const timestamp = new Date().toISOString()

    let explicitPlanName: string | null = null
    let explicitWorktreePath: string | null = null
    try {
      const parsed = parseUserRequest(promptText)
      explicitPlanName = parsed.planName
      explicitWorktreePath = parsed.explicitWorktreePath
    } catch (e) {
      log(`[${HOOK_NAME}] parseUserRequest failed`, { sessionID: sessionId, error: String(e) })
    }
    const { worktreePath, block: worktreeBlock } = resolveWorktreeContext(explicitWorktreePath)

    log(`[${HOOK_NAME}] Path decision`, {
      sessionID: sessionId,
      hasExistingState: !!existingState,
      explicitPlanName: explicitPlanName ?? "(null)",
      activePlan: existingState?.active_plan ?? "(none)",
    })

    const resolvePlanBlocks = (planPath: string) => {
      log(`[${HOOK_NAME}] resolvePlanBlocks called`, { planPath, directory: ctx.directory })
      const ciFastPath = detectCIFastPath(planPath, ctx.directory)
      log(`[${HOOK_NAME}] CI fast path result`, { active: ciFastPath.active, blockLen: ciFastPath.block.length })
      if (ciFastPath.active) {
        return {
          isFastPath: true,
          delegationKickoffBlock: ciFastPath.block,
          evidenceGateBlock: "",
        }
      }
      return {
        isFastPath: false,
        delegationKickoffBlock: createDelegationKickoffBlock(),
        evidenceGateBlock: createEvidenceGateBlock(),
      }
    }

    let delegationKickoffBlock = createDelegationKickoffBlock()
    let evidenceGateBlock = createEvidenceGateBlock()

    let contextInfo = ""

    if (explicitPlanName) {
      log(`[${HOOK_NAME}] Explicit plan name requested: ${explicitPlanName}`, { sessionID: sessionId })

      const allPlans = findPrometheusPlans(ctx.directory)
      const matchedPlan = findPlanByName(allPlans, explicitPlanName)
        ?? (
          existingState
          && getPlanName(existingState.active_plan).toLowerCase() === explicitPlanName.toLowerCase()
          && !getPlanProgress(existingState.active_plan).isComplete
            ? existingState.active_plan
            : null
        )

      if (matchedPlan) {
        const progress = getPlanProgress(matchedPlan)

        if (progress.isComplete) {
          contextInfo = `
## Plan Already Complete

The requested plan "${getPlanName(matchedPlan)}" has been completed.
All ${progress.total} tasks are done. Create a new plan with: /plan "your task"`
        } else {
          if (existingState) clearBoulderState(ctx.directory)
          const newState = createBoulderState(matchedPlan, sessionId, activeAgent, worktreePath)
          writeBoulderState(ctx.directory, newState)

          const planBlocks = resolvePlanBlocks(matchedPlan)
          delegationKickoffBlock = planBlocks.delegationKickoffBlock
          evidenceGateBlock = planBlocks.evidenceGateBlock

          contextInfo = `
## Auto-Selected Plan

**Plan**: ${getPlanName(matchedPlan)}
**Path**: ${matchedPlan}
**Progress**: ${progress.completed}/${progress.total} tasks
**Session ID**: ${sessionId}
**Started**: ${timestamp}
${worktreeBlock}
${evidenceGateBlock}
${planBlocks.isFastPath ? "" : "\nboulder.json has been created. Read the plan and begin execution."}
${delegationKickoffBlock}`
        }
      } else {
        const incompletePlans = allPlans.filter((p) => !getPlanProgress(p).isComplete)
        if (incompletePlans.length > 0) {
          const planList = incompletePlans
            .map((p, i) => {
              const prog = getPlanProgress(p)
              return `${i + 1}. [${getPlanName(p)}] - Progress: ${prog.completed}/${prog.total}`
            })
            .join("\n")

          contextInfo = `
## Plan Not Found

Could not find a plan matching "${explicitPlanName}".

Available incomplete plans:
${planList}

Ask the user which plan to work on.`
        } else {
          contextInfo = `
## Plan Not Found

Could not find a plan matching "${explicitPlanName}".
No incomplete plans available. Create a new plan with: /plan "your task"`
        }
      }
    } else if (existingState) {
      const progress = getPlanProgress(existingState.active_plan)
      log(`[${HOOK_NAME}] Existing state branch`, { planComplete: progress.isComplete, completed: progress.completed, total: progress.total, planPath: existingState.active_plan })

      if (!progress.isComplete) {
        const planBlocks = resolvePlanBlocks(existingState.active_plan)
        delegationKickoffBlock = planBlocks.delegationKickoffBlock
        evidenceGateBlock = planBlocks.evidenceGateBlock

        const effectiveWorktree = worktreePath ?? existingState.worktree_path

        // Prune stale sessions from previous aborted runs — keep only current session
        const staleSessions = existingState.session_ids.filter((s) => s !== sessionId)
        if (staleSessions.length > 0) {
          log(`[${HOOK_NAME}] Pruning ${staleSessions.length} stale session(s) from boulder.json`)
        }
        const cleanedState: typeof existingState = {
          ...existingState,
          session_ids: [sessionId],
          session_origins: { [sessionId]: "direct" as const },
          task_sessions: {},
          ...(worktreePath !== undefined ? { worktree_path: worktreePath } : {}),
        }
        writeBoulderState(ctx.directory, cleanedState)

        const worktreeDisplay = effectiveWorktree ? createWorktreeActiveBlock(effectiveWorktree) : worktreeBlock

        contextInfo = `
## Active Work Session Found

**Status**: RESUMING existing work
**Plan**: ${existingState.plan_name}
**Path**: ${existingState.active_plan}
**Progress**: ${progress.completed}/${progress.total} tasks completed
**Sessions**: ${existingState.session_ids.length + 1} (current session appended)
**Started**: ${existingState.started_at}
${worktreeDisplay}
${evidenceGateBlock}

The current session (${sessionId}) has been added to session_ids.
${planBlocks.isFastPath ? "" : "Read the plan file and continue from the first unchecked task."}
${delegationKickoffBlock}`
      } else {
        contextInfo = `
## Previous Work Complete

The previous plan (${existingState.plan_name}) has been completed.
Looking for new plans...`
        clearBoulderState(ctx.directory)
      }
    }

    if (
      (!existingState && !explicitPlanName) ||
      (existingState && !explicitPlanName && getPlanProgress(existingState.active_plan).isComplete)
    ) {
      const plans = findPrometheusPlans(ctx.directory)
      const incompletePlans = plans.filter((p) => !getPlanProgress(p).isComplete)

      if (plans.length === 0) {
        contextInfo += `
## No Plans Found

No Prometheus plan files found at .sisyphus/plans/
Use Prometheus to create a work plan first: /plan "your task"`
      } else if (incompletePlans.length === 0) {
        contextInfo += `

## All Plans Complete

All ${plans.length} plan(s) are complete. Create a new plan with: /plan "your task"`
      } else if (incompletePlans.length === 1) {
        const planPath = incompletePlans[0]
        const progress = getPlanProgress(planPath)
        const newState = createBoulderState(planPath, sessionId, activeAgent, worktreePath)
        writeBoulderState(ctx.directory, newState)

        const planBlocks = resolvePlanBlocks(planPath)
        delegationKickoffBlock = planBlocks.delegationKickoffBlock
        evidenceGateBlock = planBlocks.evidenceGateBlock

        contextInfo += `

## Auto-Selected Plan

**Plan**: ${getPlanName(planPath)}
**Path**: ${planPath}
**Progress**: ${progress.completed}/${progress.total} tasks
**Session ID**: ${sessionId}
**Started**: ${timestamp}
${worktreeBlock}
${evidenceGateBlock}
${planBlocks.isFastPath ? "" : "\nboulder.json has been created. Read the plan and begin execution."}
${delegationKickoffBlock}`
      } else {
        const planList = incompletePlans
          .map((p, i) => {
            const progress = getPlanProgress(p)
            const modified = new Date(statSync(p).mtimeMs).toISOString()
            return `${i + 1}. [${getPlanName(p)}] - Modified: ${modified} - Progress: ${progress.completed}/${progress.total}`
          })
          .join("\n")

        contextInfo += `

<system-reminder>
## Multiple Plans Found

Current Time: ${timestamp}
Session ID: ${sessionId}

${planList}

Ask the user which plan to work on. Present the options above and wait for their response.
${worktreeBlock}
</system-reminder>`
      }
    }

    const idx = output.parts.findIndex((p) => p.type === "text" && p.text)
    if (idx >= 0 && output.parts[idx].text) {
      output.parts[idx].text = output.parts[idx].text
        .replace(/\$SESSION_ID/g, sessionId)
        .replace(/\$TIMESTAMP/g, timestamp)

      // CI fast path: REPLACE prompt AND switch agent to sisyphus (executor)
      // Atlas's 500-line system prompt overrides any user-message override,
      // so we bypass Atlas entirely and use the executor directly
      if (contextInfo.includes("CI FAST PATH")) {
        output.parts[idx].text = contextInfo
        const ciAgent = "sisyphus"
        const ciAgentDisplay = getAgentDisplayName(ciAgent)
        updateSessionAgent(sessionId, ciAgent)
        if (output.message) {
          output.message["agent"] = ciAgentDisplay
          output.message["tools"] = {
            ...((output.message["tools"] as Record<string, unknown> | undefined) ?? {}),
            task: false,
            "task_*": false,
            skill: false,
            teammate: false,
            call_omo_agent: false,
            session_search: false,
            todowrite: false,
            todoread: false,
            webfetch: false,
          }
        }
        setSessionFlag(sessionId, "ci-fast-path")
        log(`[${HOOK_NAME}] CI fast path: prompt REPLACED, agent switched to ${ciAgent} (${ciAgentDisplay})`)
      } else {
        output.parts[idx].text += `\n\n---\n${contextInfo}`
      }
    }

    log(`[${HOOK_NAME}] Context injected`, {
      sessionID: sessionId,
      hasExistingState: !!existingState,
      worktreePath,
      contextPath: contextInfo.includes("CI FAST PATH") ? "ci-fast-path"
        : contextInfo.includes("Active Work Session") ? "active-session"
        : contextInfo.includes("Previous Work Complete") ? "prev-complete"
        : contextInfo.includes("Auto-Selected Plan") ? "auto-select"
        : contextInfo.includes("No Plans Found") ? "no-plans"
        : contextInfo.includes("All Plans Complete") ? "all-complete"
        : contextInfo.includes("Multiple Plans") ? "multiple-plans"
        : contextInfo.includes("Plan Not Found") ? "plan-not-found"
        : contextInfo.includes("Plan Already Complete") ? "plan-already-complete"
        : `unknown(len=${contextInfo.length})`,
    })
  }

  return {
    "chat.message": async (input: StartWorkHookInput, output: StartWorkHookOutput): Promise<void> => {
      const parts = output.parts
      const promptText =
        parts
          ?.filter((p) => p.type === "text" && p.text)
          .map((p) => p.text)
          .join("\n")
          .trim() || ""
      await injectStartWorkContext(input.sessionID, promptText, output)
    },
    "command.execute.before": async (
      input: StartWorkCommandExecuteBeforeInput,
      output: StartWorkHookOutput,
    ): Promise<void> => {
      const promptText = `/start-work${input.arguments ? ` ${input.arguments}` : ""}`
      await injectStartWorkContext(input.sessionID, promptText, output)
    },
  }
}
