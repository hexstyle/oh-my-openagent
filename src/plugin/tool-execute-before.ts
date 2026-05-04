import type { PluginContext } from "./types"
import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { dirname, extname } from "node:path"

import { getMainSessionID } from "../features/claude-code-session-state"
import { clearBoulderState } from "../features/boulder-state"
import { log } from "../shared"
import {
  clearSessionFlag,
  hasSessionFlag,
  isSessionToolDisabled,
  setSessionFlag,
} from "../shared/session-tools-store"
import { resolveSessionAgent } from "./session-agent-resolver"
import { parseRalphLoopArguments } from "../hooks/ralph-loop/command-arguments"
import { ULTRAWORK_VERIFICATION_PROMISE } from "../hooks/ralph-loop/constants"
import { readState, writeState } from "../hooks/ralph-loop/storage"

import type { CreatedHooks } from "../create-hooks"

export function createToolExecuteBeforeHandler(args: {
  ctx: PluginContext
  hooks: CreatedHooks
}): (
  input: { tool: string; sessionID: string; callID: string },
  output: { args: Record<string, unknown> },
) => Promise<void> {
  const { ctx, hooks } = args
  const CI_FAST_PATH_FLAG = "ci-fast-path"
  const CI_EVIDENCE_MATERIALIZED_FLAG = "ci-evidence-materialized"
  const CI_CLAUDE_REVIEW_PASSED_FLAG = "ci-claude-review-passed"
  const CI_EVIDENCE_CORE_READ_FLAG = "ci-evidence-core-read"
  const CI_DIRTY_BATCH_INSPECTED_FLAG = "ci-dirty-batch-inspected"
  const CI_FORWARD_PROGRESS_FLAG = "ci-forward-progress"
  const CI_PLAYWRIGHT_PREFLIGHT_READY_FLAG = "ci-playwright-preflight-ready"
  const POST_DIRTY_BATCH_EXPLORATION_BUDGET = 6
  const PLANNER_BOOTSTRAP_EVIDENCE_READ_BUDGET = 5
  const dirtyBatchCodeReadCounts = new Map<string, Map<string, number>>()
  const postDirtyBatchExplorationCounts = new Map<string, number>()
  const plannerBootstrapEvidenceReadCounts = new Map<string, number>()

  function getStringArg(argsObject: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = argsObject[key]
      if (typeof value === "string" && value.trim().length > 0) {
        return value
      }
    }

    return undefined
  }

  function isTrackerReadAttempt(toolName: string, argsObject: Record<string, unknown>): boolean {
    if (toolName !== "read") return false
    const filePath = getStringArg(argsObject, ["filePath", "path", "targetPath"])
    return typeof filePath === "string" && filePath.includes(".sisyphus/evidence/tests/")
  }

  function getCodeReadPath(toolName: string, argsObject: Record<string, unknown>): string | undefined {
    if (toolName !== "read") return undefined
    const filePath = getStringArg(argsObject, ["filePath", "path", "targetPath"])
    if (typeof filePath !== "string") {
      return undefined
    }

    if (filePath.includes(".sisyphus/")) {
      return undefined
    }

    return filePath
  }

  function isCoreEvidenceReadAttempt(toolName: string, argsObject: Record<string, unknown>): boolean {
    if (toolName !== "read") return false
    const filePath = getStringArg(argsObject, ["filePath", "path", "targetPath"])
    if (typeof filePath !== "string") {
      return false
    }

    return (
      filePath.includes(".sisyphus/evidence/repair-log.md")
      || filePath.includes(".sisyphus/evidence/ci-loop-checkpoint.md")
      || /\.sisyphus\/evidence\/build-\d+.*\.md$/i.test(filePath)
      || /\.sisyphus\/plans\/ci-green-build\d+.*\.md$/i.test(filePath)
    )
  }

  function isPlannerBootstrapEvidenceReadAttempt(toolName: string, argsObject: Record<string, unknown>): boolean {
    if (isCoreEvidenceReadAttempt(toolName, argsObject)) {
      return true
    }

    if (toolName !== "read") return false
    const filePath = getStringArg(argsObject, ["filePath", "path", "targetPath"])
    return typeof filePath === "string" && filePath.includes(".sisyphus/boulder.json")
  }

  function isDirectoryReadAttempt(toolName: string, argsObject: Record<string, unknown>): boolean {
    if (toolName !== "read") return false
    const filePath = getStringArg(argsObject, ["filePath", "path", "targetPath"])
    if (typeof filePath !== "string" || !existsSync(filePath)) {
      return false
    }

    try {
      return statSync(filePath).isDirectory()
    } catch {
      return false
    }
  }

  function isLegacyEvidenceAliasReadAttempt(toolName: string, argsObject: Record<string, unknown>): boolean {
    if (toolName !== "read") return false
    const filePath = getStringArg(argsObject, ["filePath", "path", "targetPath"])
    if (typeof filePath !== "string") {
      return false
    }

    return (
      filePath.endsWith(".sisyphus/ci-loop-checkpoint.md")
      || filePath.endsWith(".sisyphus/repair-log.md")
    )
  }

  function getHistoricalVerifyArtifactRead(
    toolName: string,
    argsObject: Record<string, unknown>,
  ): { filePath: string; staleIteration: number; latestIteration: number } | undefined {
    if (toolName !== "read") return undefined
    const filePath = getStringArg(argsObject, ["filePath", "path", "targetPath"])
    if (typeof filePath !== "string") {
      return undefined
    }

    const match = filePath.match(/Optimizer\.PlaywrightTests\/TestResults\/iteration(\d+)\//i)
    if (!match) {
      return undefined
    }

    const staleIteration = Number.parseInt(match[1] ?? "", 10)
    if (!Number.isFinite(staleIteration)) {
      return undefined
    }

    const resultsDir = dirname(dirname(filePath))
    try {
      const latestIteration = readdirSync(resultsDir)
        .map((entry) => entry.match(/^iteration(\d+)$/i))
        .filter((entry): entry is RegExpMatchArray => entry !== null)
        .map((entry) => Number.parseInt(entry[1] ?? "", 10))
        .filter((value) => Number.isFinite(value))
        .reduce((max, value) => Math.max(max, value), staleIteration)

      if (latestIteration > staleIteration) {
        return { filePath, staleIteration, latestIteration }
      }
    } catch {
      return undefined
    }

    return undefined
  }

  function isDirtyBatchInspectionAttempt(toolName: string, argsObject: Record<string, unknown>): boolean {
    if (toolName !== "bash") return false
    const command = getStringArg(argsObject, ["command"])
    if (typeof command !== "string") {
      return false
    }

    return /\bgit status\b|\bgit diff\b/i.test(command)
  }

  function isBroadDirtyBatchDiffAttempt(toolName: string, argsObject: Record<string, unknown>): boolean {
    if (toolName !== "bash") return false
    const command = getStringArg(argsObject, ["command"])
    if (typeof command !== "string") {
      return false
    }

    const normalized = command.replace(/\s+/g, " ").trim()
    if (!/\bgit diff\b/i.test(normalized) || !normalized.includes(" -- ")) {
      return false
    }

    if (
      normalized.includes(" --stat")
      || normalized.includes(" --name-only")
      || normalized.includes(" --name-status")
      || normalized.includes(" --numstat")
    ) {
      return false
    }

    const afterSeparator = normalized.split(" -- ")[1] ?? ""
    const pathTokens = afterSeparator
      .split(" ")
      .map((token) => token.trim())
      .filter((token) => token.length > 0 && !token.startsWith("-"))

    return pathTokens.length >= 3
  }

  function isEvidenceReflectionAttempt(toolName: string, argsObject: Record<string, unknown>): boolean {
    if (toolName === "read") {
      const filePath = getStringArg(argsObject, ["filePath", "path", "targetPath"])
      return typeof filePath === "string" && /\/tool-output\/tool_[^/]+$/i.test(filePath)
    }

    if (toolName !== "bash") {
      return false
    }

    const command = getStringArg(argsObject, ["command"])
    if (typeof command !== "string") {
      return false
    }

    const lower = command.toLowerCase()
    const isEvidenceDiff =
      /\bgit diff\b/i.test(command)
      && (
        lower.includes(".sisyphus/evidence/")
        || lower.includes(".sisyphus/plans/ci-green-build")
      )
    const isToolOutputReflection =
      lower.includes("/tool-output/tool_")
      || lower.includes("../.local/share/opencode/tool-output")

    return isEvidenceDiff || isToolOutputReflection
  }

  function isHistoricalSisyphusReadAttempt(toolName: string, argsObject: Record<string, unknown>): boolean {
    if (toolName !== "read") return false
    const filePath = getStringArg(argsObject, ["filePath", "path", "targetPath"])
    if (typeof filePath !== "string") {
      return false
    }

    return (
      filePath.includes(".sisyphus/notepads/")
      || filePath.includes(".sisyphus/run-continuation/")
    )
  }

  function isForwardProgressAttempt(toolName: string, argsObject: Record<string, unknown>): boolean {
    if (toolName === "write" || toolName === "edit") {
      return true
    }

    if (toolName === "bash") {
      const command = getStringArg(argsObject, ["command"])
      if (typeof command !== "string") {
        return false
      }

      return /\bdotnet build\b|\bdotnet test\b|\bgit commit\b|\bgit push\b|\breview-work\b/i.test(command)
    }

    return toolName === "review-work" || toolName === "review_work"
  }

  function isEvidenceWriteAttempt(toolName: string, argsObject: Record<string, unknown>): boolean {
    if (toolName === "write" || toolName === "edit") {
      const filePath = getStringArg(argsObject, ["filePath", "path", "targetPath"])
      return typeof filePath === "string" && (
        filePath.includes(".sisyphus/evidence/tests/")
        || filePath.endsWith(".sisyphus/evidence/repair-log.md")
        || filePath.endsWith(".sisyphus/evidence/ci-loop-checkpoint.md")
      )
    }

    if (toolName === "bash") {
      const command = getStringArg(argsObject, ["command"])
      if (typeof command !== "string") {
        return false
      }

      const targetsEvidencePath =
        command.includes(".sisyphus/evidence/tests/")
        || command.includes(".sisyphus/evidence/repair-log.md")
        || command.includes(".sisyphus/evidence/ci-loop-checkpoint.md")
      if (!targetsEvidencePath) {
        return false
      }

      const normalized = command.toLowerCase()
      const redirectsIntoEvidencePath = />{1,2}\s*["']?[^"'\n]*\.sisyphus\/evidence\//i.test(command)
      const hasWriteSignal =
        normalized.includes("tee ")
        || normalized.includes("tee\t")
        || normalized.includes("python3 <<'py'")
        || normalized.includes("python3 <<\"py\"")
        || normalized.includes("python <<'py'")
        || normalized.includes("python <<\"py\"")
        || normalized.includes("perl -0pi")
        || normalized.includes("sed -i")
        || normalized.includes("mv ")
        || normalized.includes("cp ")
        || (/(^|[;&(]\s*)printf\b/i.test(command) && redirectsIntoEvidencePath)
        || (/(^|[;&(]\s*)echo\b/i.test(command) && redirectsIntoEvidencePath)
        || /(^|[;&(]\s*)cat\b[\s\S]*?>{1,2}/i.test(command)
        || redirectsIntoEvidencePath

      return hasWriteSignal
    }

    return false
  }

  function isStandalonePlaywrightPreflightAttempt(toolName: string, argsObject: Record<string, unknown>): boolean {
    if (toolName !== "bash") return false
    const command = getStringArg(argsObject, ["command"])
    if (typeof command !== "string") {
      return false
    }

    const lower = command.toLowerCase()
    const hasPreflightMarker = lower.includes("rerun_precheck")
    const hasAudit =
      lower.includes("ps -ax")
      || lower.includes("ps -axo")
      || lower.includes("pgrep")
    const hasRunnerKinds =
      lower.includes("dotnet test")
      || lower.includes("testhost")
      || lower.includes("headless_shell")
      || lower.includes("run-driver")
    const hasCleanup =
      lower.includes("pkill")
      || /\bkill\s+-?\d+/i.test(command)
      || lower.includes("xargs kill")

    const launchesDotnetTest =
      /(?:^|&&|;|\()\s*(?:\/opt\/homebrew\/opt\/dotnet@8\/libexec\/dotnet|dotnet)\s+test\b/i.test(command)

    return hasPreflightMarker && hasAudit && hasRunnerKinds && hasCleanup && !launchesDotnetTest
  }

  function hasLiveScopedPlaywrightRunners(): boolean {
    const snapshot = process.env.OMO_TEST_PS_OUTPUT
      ?? execFileSync("ps", ["-ax", "-o", "pid=,command="], { encoding: "utf8" })
    const scopeTerms = ["eurochemeopt", "optimizer.playwrighttests", "playwright"]
    const processTerms = ["dotnet test", "testhost.dll", "run-driver", "headless_shell", "chromium"]

    return snapshot
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .some((line) => line.length > 0
        && scopeTerms.some((term) => line.includes(term))
        && processTerms.some((term) => line.includes(term)))
  }

  function extractContentArg(argsObject: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = argsObject[key]
      if (typeof value === "string" && value.length > 0) {
        return value
      }
    }

    return undefined
  }

  function hasClaudeReviewPassMarker(text: string): boolean {
    const normalized = text.toLowerCase()
    return (
      normalized.includes("claude review: pass")
      || normalized.includes("oracle review: pass")
      || normalized.includes("review-work: pass")
    )
  }

  function shouldMarkClaudeReviewPassed(toolName: string, argsObject: Record<string, unknown>): boolean {
    if (toolName === "write" || toolName === "edit") {
      const filePath = getStringArg(argsObject, ["filePath", "path", "targetPath"])
      if (
        typeof filePath !== "string"
        || (
          !filePath.endsWith(".sisyphus/evidence/repair-log.md")
          && !filePath.endsWith(".sisyphus/evidence/ci-loop-checkpoint.md")
        )
      ) {
        return false
      }

      const content = extractContentArg(argsObject, [
        "content",
        "text",
        "newString",
        "newText",
        "replacement",
      ])
      return typeof content === "string" && hasClaudeReviewPassMarker(content)
    }

    if (toolName === "bash") {
      const command = getStringArg(argsObject, ["command"])
      return (
        typeof command === "string"
        && (
          command.includes(".sisyphus/evidence/repair-log.md")
          || command.includes(".sisyphus/evidence/ci-loop-checkpoint.md")
        )
        && hasClaudeReviewPassMarker(command)
      )
    }

    return false
  }

  function validateBambooBashCommand(command: string, sessionID: string): void {
    const lower = command.toLowerCase()
    const hitsBambooResultRest = lower.includes("bamboo.suek.ru/rest/api/latest/result")
    const hitsBambooBrowsePage = lower.includes("bamboo.suek.ru/browse/")

    if (hitsBambooBrowsePage) {
      throw new Error(
        `[tool-execute-before] Refusing Bamboo HTML scrape for session ${sessionID}. Use Bamboo REST JSON endpoints plus filtered parsing instead of /browse/ pages.`,
      )
    }

    if (!hitsBambooResultRest) {
      return
    }

    if (lower.includes("expand=testresults.alltests")) {
      throw new Error(
        `[tool-execute-before] Refusing Bamboo all-tests expansion for session ${sessionID}. Fetch summary fields from the plan endpoint and failing tests from the JOB1 failed-tests endpoint only.`,
      )
    }

    if (!lower.includes("fetch_json")) {
      throw new Error(
        `[tool-execute-before] Refusing direct Bamboo result endpoint fetches for session ${sessionID}. Define an inline fetch_json helper in the same bash block and use compact parsing instead of dumping raw Bamboo payloads.`,
      )
    }

    const hasCompactParser =
      lower.includes("python3 <<'py'")
      || lower.includes("python3 <<\"py\"")
      || lower.includes("jq ")
      || lower.includes("\njq")

    if (!hasCompactParser) {
      throw new Error(
        `[tool-execute-before] Refusing raw Bamboo JSON stdout for session ${sessionID}. After fetch_json, extract only compact fields with jq or a python3 heredoc before printing anything.`,
      )
    }
  }

  function validateLocalContourBashCommand(command: string, sessionID: string): void {
    const lower = command.toLowerCase()
    const isPlaywrightProjectTest =
      /\bdotnet test\b/i.test(command)
      && lower.includes("optimizer.playwrighttests/optimizer.playwrighttests.csproj")

    if (!isPlaywrightProjectTest) {
      return
    }

    const hasProvisionedEnvInline =
      lower.includes("optiex_playwright_base_url")
      && lower.includes("optiex_playwright_conf_connection_string")

    const hasGeneratedInstancePath = lower.includes("generated/testappinstances.json")

    if (!hasProvisionedEnvInline && !hasGeneratedInstancePath) {
      throw new Error(
        `[tool-execute-before] Refusing Playwright test run for session ${sessionID} without local contour source. Re-export provisioned OPTIEX_PLAYWRIGHT_* env vars in the same bash command or generate/source Optimizer.WebSiteTests/generated/TestAppInstances.json first.`,
      )
    }

    const hasResultsDirectory = lower.includes("--results-directory")
    const hasTrxLogger = lower.includes("trx;logfilename=")
    const hasVisibleStartMarker = lower.includes("rerun_start")
    const hasVisibleEndMarker = lower.includes("rerun_end")
    const hasExpectedCoverageCount =
      /\bexpected(?:_test_count|_count)?=/.test(lower)
      || lower.includes("expected_test_count")
      || lower.includes("rerun_expected_tests=")
      || lower.includes("rerun_expected_tests")
    const hasTrxCoverageParse =
      lower.includes("xml.etree.elementtree")
      && lower.includes("unittestresult")
    const hasHardTimeoutWrapper =
      (lower.includes("perl -e") && lower.includes("alarm"))
      || /\b(gtimeout|timeout)\b/.test(lower)
      || (lower.includes("python3") && lower.includes("timeout="))
    const hasObservableHeartbeat =
      lower.includes("rerun_heartbeat")
      && lower.includes("kill -0")
      && lower.includes("sleep")
    const hasStaleRunnerAudit =
      lower.includes("rerun_precheck")
      && (lower.includes("ps -axo") || lower.includes("pgrep"))
      && (
        lower.includes("dotnet test")
        || lower.includes("testhost")
        || lower.includes("headless_shell")
        || lower.includes("run-driver")
      )
    const hasStaleRunnerCleanup =
      lower.includes("pkill")
      || /\bkill\s+-?\d+/i.test(command)
      || lower.includes("xargs kill")

    if (!hasResultsDirectory || !hasTrxLogger || !hasVisibleStartMarker || !hasVisibleEndMarker) {
      throw new Error(
        `[tool-execute-before] Refusing Playwright test run for session ${sessionID} without the bounded rerun markers. Include --results-directory, trx logger path, RERUN_START, and RERUN_END in the same bash command.`,
      )
    }

    if (!hasHardTimeoutWrapper) {
      throw new Error(
        `[tool-execute-before] Refusing Playwright test run for session ${sessionID} without a hard timeout wrapper. Use perl alarm, timeout/gtimeout, or a python subprocess timeout in the same bash command. Preferred shell form: perl -e 'alarm shift; exec @ARGV' 5400 dotnet test ... & followed by wait "$PID".`,
      )
    }

    if (!hasExpectedCoverageCount || !hasTrxCoverageParse) {
      throw new Error(
        `[tool-execute-before] Refusing Playwright test run for session ${sessionID} without explicit rerun coverage accounting. Declare the expected failing-set count in the same bash command and parse UnitTestResult entries from the TRX before treating the rerun as complete.`,
      )
    }

    if (!hasObservableHeartbeat) {
      throw new Error(
        `[tool-execute-before] Refusing Playwright test run for session ${sessionID} without observable heartbeat logging. Emit recurring RERUN_HEARTBEAT lines from the same bounded rerun command so idle waits without TRX/artifact progress are visible before the hard timeout.`,
      )
    }

    const hasFreshStandalonePreflight = hasSessionFlag(sessionID, CI_PLAYWRIGHT_PREFLIGHT_READY_FLAG)
    if (hasFreshStandalonePreflight && (!hasStaleRunnerAudit || !hasStaleRunnerCleanup) && hasLiveScopedPlaywrightRunners()) {
      throw new Error(
        `[tool-execute-before] Refusing Playwright test run for session ${sessionID} because the immediately preceding dedicated stale-runner preflight did not clear the live eurochemeopt/playwright runner set. Record that stale state in evidence, kill the leftover runners first, and only then launch the bounded rerun.`,
      )
    }

    if ((!hasStaleRunnerAudit || !hasStaleRunnerCleanup) && !hasFreshStandalonePreflight) {
      throw new Error(
        `[tool-execute-before] Refusing Playwright test run for session ${sessionID} without stale-runner preflight. Emit RERUN_PRECHECK and audit lingering dotnet test/testhost/headless_shell/run-driver processes, with cleanup logic for leftovers from prior iterations, either in the same bounded rerun command or in the immediately preceding dedicated preflight step, before launching the bounded rerun.`,
      )
    }

    if (hasFreshStandalonePreflight) {
      clearSessionFlag(sessionID, CI_PLAYWRIGHT_PREFLIGHT_READY_FLAG)
    }
  }

  function validateShellToolMimicCommand(command: string, sessionID: string): void {
    const normalized = command.replace(/\s+/g, " ").trim()
    if (!normalized) {
      return
    }

    const lower = normalized.toLowerCase()
    const shellToolMimics = [
      "task",
      "teammate",
      "call_omo_agent",
      "review-work",
    ]

    for (const name of shellToolMimics) {
      if (lower === name || lower.startsWith(`${name} `) || lower.startsWith(`${name}(`)) {
        throw new Error(
          `[tool-execute-before] Refusing shell command "${name}" for session ${sessionID}. ${name} must be invoked as an OpenCode tool call, not as a bash command.`,
        )
      }
    }
  }

  function buildUltraworkOracleVerificationPrompt(prompt: string, originalTask: string, verificationAttemptId: string): string {
    const verificationPrompt = [
      "You are verifying the active ULTRAWORK loop result for this session.",
      "",
      "Original task:",
      originalTask,
      "",
      "Review the work skeptically and critically.",
      "Assume it may be incomplete, misleading, or subtly broken until the evidence proves otherwise.",
      "Look for missing scope, weak verification, process violations, hidden regressions, and any reason the task should NOT be considered complete.",
      "",
      `If the work is fully complete, end your response with <promise>${ULTRAWORK_VERIFICATION_PROMISE}</promise>.`,
      "If the work is not complete, explain the blocking issues clearly and DO NOT emit that promise.",
      "",
      `<ulw_verification_attempt_id>${verificationAttemptId}</ulw_verification_attempt_id>`,
    ].join("\n")

    return `${prompt ? `${prompt}\n\n` : ""}${verificationPrompt}`
  }

  function getBlockedCiFastPathToolMessage(sessionID: string, toolName: string): string | undefined {
    if (!hasSessionFlag(sessionID, CI_FAST_PATH_FLAG)) {
      return undefined
    }

    const alwaysBlockedTools = new Set([
      "call_omo_agent",
      "session_search",
      "skill",
      "skill_mcp",
      "todoread",
      "todowrite",
      "webfetch",
    ])
    if (alwaysBlockedTools.has(toolName)) {
      return `[tool-execute-before] Tool "${toolName}" is blocked for CI fast-path session ${sessionID}. Stay on canonical evidence, source slices, bounded verify, mandatory Claude review, and push; do not detour through ${toolName}.`
    }

    const preProgressBlockedTools = new Set(["task", "teammate"])
    if (preProgressBlockedTools.has(toolName) && !hasSessionFlag(sessionID, CI_FORWARD_PROGRESS_FLAG)) {
      return `[tool-execute-before] Tool "${toolName}" is blocked for CI fast-path session ${sessionID} before forward progress. First make real progress with evidence writes, code edits, build/test verification, or a bounded rerun; only then may you consider review/delegation steps.`
    }

    return undefined
  }

  function clearDirtyBatchReadCounts(sessionID: string): void {
    dirtyBatchCodeReadCounts.delete(sessionID)
  }

  function trackPostDirtyBatchExploration(sessionID: string): number {
    const nextCount = (postDirtyBatchExplorationCounts.get(sessionID) ?? 0) + 1
    postDirtyBatchExplorationCounts.set(sessionID, nextCount)
    return nextCount
  }

  function clearPostDirtyBatchExploration(sessionID: string): void {
    postDirtyBatchExplorationCounts.delete(sessionID)
  }

  function clearPlannerBootstrapEvidenceReads(sessionID: string): void {
    plannerBootstrapEvidenceReadCounts.delete(sessionID)
  }

  function trackPlannerBootstrapEvidenceRead(sessionID: string): number {
    const nextCount = (plannerBootstrapEvidenceReadCounts.get(sessionID) ?? 0) + 1
    plannerBootstrapEvidenceReadCounts.set(sessionID, nextCount)
    return nextCount
  }

  function isPostDirtyBatchExplorationAttempt(
    toolName: string,
    argsObject: Record<string, unknown>,
  ): boolean {
    if (toolName === "read") {
      return getCodeReadPath(toolName, argsObject) !== undefined
    }

    return (
      toolName === "grep"
      || toolName === "glob"
      || toolName === "lsp_diagnostics"
    )
  }

  function isSlowCsharpLspDiagnosticsAttempt(
    toolName: string,
    argsObject: Record<string, unknown>,
  ): boolean {
    if (toolName !== "lsp_diagnostics") {
      return false
    }

    const filePath = getStringArg(argsObject, ["filePath", "path", "targetPath", "directory"])
    if (typeof filePath === "string" && extname(filePath).toLowerCase() === ".cs") {
      return true
    }

    const extension = getStringArg(argsObject, ["extension"])
    return typeof extension === "string" && extension.trim().toLowerCase() === ".cs"
  }

  function trackDirtyBatchCodeRead(sessionID: string, filePath: string): number {
    const sessionCounts = dirtyBatchCodeReadCounts.get(sessionID) ?? new Map<string, number>()
    const nextCount = (sessionCounts.get(filePath) ?? 0) + 1
    sessionCounts.set(filePath, nextCount)
    dirtyBatchCodeReadCounts.set(sessionID, sessionCounts)
    return nextCount
  }

  return async (input, output): Promise<void> => {
    if (isSessionToolDisabled(input.sessionID, input.tool)) {
      throw new Error(
        `[tool-execute-before] Tool "${input.tool}" is disabled for session ${input.sessionID}.`
      )
    }

    const normalizedToolName = input.tool.toLowerCase()
    const blockedCiFastPathToolMessage = getBlockedCiFastPathToolMessage(input.sessionID, normalizedToolName)
    if (blockedCiFastPathToolMessage) {
      throw new Error(blockedCiFastPathToolMessage)
    }

    if (normalizedToolName === "task") {
      clearPlannerBootstrapEvidenceReads(input.sessionID)
    }

    if (isStandalonePlaywrightPreflightAttempt(normalizedToolName, output.args)) {
      setSessionFlag(input.sessionID, CI_PLAYWRIGHT_PREFLIGHT_READY_FLAG)
    }

    if (
      hasSessionFlag(input.sessionID, CI_EVIDENCE_CORE_READ_FLAG)
      && !hasSessionFlag(input.sessionID, CI_DIRTY_BATCH_INSPECTED_FLAG)
      && !hasSessionFlag(input.sessionID, CI_FORWARD_PROGRESS_FLAG)
      && isPlannerBootstrapEvidenceReadAttempt(normalizedToolName, output.args)
    ) {
      const plannerBootstrapReadCount = trackPlannerBootstrapEvidenceRead(input.sessionID)
      if (plannerBootstrapReadCount > PLANNER_BOOTSTRAP_EVIDENCE_READ_BUDGET) {
        throw new Error(
          `[tool-execute-before] Core CI evidence rereads are blocked for session ${input.sessionID} after the canonical planner bootstrap pass. Emit the task delegation or continue the active executor handoff instead of rereading boulder/plan/checkpoint/repair-log/build-analysis again.`,
        )
      }
    }

    if (
      hasSessionFlag(input.sessionID, CI_EVIDENCE_MATERIALIZED_FLAG)
      && isTrackerReadAttempt(normalizedToolName, output.args)
    ) {
      throw new Error(
        `[tool-execute-before] Tracker evidence rereads are blocked for CI fast-path session ${input.sessionID} after evidence materialization. Move to code edits, verification, or a fresh CI fetch.`,
      )
    }

    if (
      hasSessionFlag(input.sessionID, CI_EVIDENCE_CORE_READ_FLAG)
      && hasSessionFlag(input.sessionID, CI_DIRTY_BATCH_INSPECTED_FLAG)
      && !hasSessionFlag(input.sessionID, CI_FORWARD_PROGRESS_FLAG)
      && isCoreEvidenceReadAttempt(normalizedToolName, output.args)
    ) {
      throw new Error(
        `[tool-execute-before] Core CI evidence rereads are blocked for session ${input.sessionID} after dirty-batch inspection. Move to runtime bootstrap, verification, review, or edits before reopening checkpoint/repair-log/build-analysis/plan files.`,
      )
    }

    if (
      hasSessionFlag(input.sessionID, CI_EVIDENCE_CORE_READ_FLAG)
      && hasSessionFlag(input.sessionID, CI_DIRTY_BATCH_INSPECTED_FLAG)
      && !hasSessionFlag(input.sessionID, CI_FORWARD_PROGRESS_FLAG)
      && isEvidenceReflectionAttempt(normalizedToolName, output.args)
    ) {
      throw new Error(
        `[tool-execute-before] Evidence reflection loops are blocked for session ${input.sessionID} after dirty-batch inspection. Stop rereading evidence diffs/tool-output and move to a real write, edit, build, test, review, commit, or push step.`,
      )
    }

    if (
      (hasSessionFlag(input.sessionID, CI_FAST_PATH_FLAG)
        || hasSessionFlag(input.sessionID, CI_EVIDENCE_CORE_READ_FLAG))
      && isBroadDirtyBatchDiffAttempt(normalizedToolName, output.args)
    ) {
      throw new Error(
        `[tool-execute-before] Broad dirty-batch git diff output is blocked for CI fast-path session ${input.sessionID}. Inspect the batch with git diff --stat first, then use per-file or otherwise narrow diff slices before verification.`,
      )
    }

    if (
      hasSessionFlag(input.sessionID, CI_EVIDENCE_CORE_READ_FLAG)
      && hasSessionFlag(input.sessionID, CI_DIRTY_BATCH_INSPECTED_FLAG)
      && !hasSessionFlag(input.sessionID, CI_FORWARD_PROGRESS_FLAG)
      && isHistoricalSisyphusReadAttempt(normalizedToolName, output.args)
    ) {
      throw new Error(
        `[tool-execute-before] Historical .sisyphus note reads are blocked for session ${input.sessionID} after the current evidence pass. Stay on canonical current-build evidence and the active dirty batch instead of reopening notepads/run-continuation history.`,
      )
    }

    if (
      hasSessionFlag(input.sessionID, CI_EVIDENCE_CORE_READ_FLAG)
      && hasSessionFlag(input.sessionID, CI_DIRTY_BATCH_INSPECTED_FLAG)
      && !hasSessionFlag(input.sessionID, CI_FORWARD_PROGRESS_FLAG)
    ) {
      const historicalVerifyArtifactRead = getHistoricalVerifyArtifactRead(normalizedToolName, output.args)
      if (historicalVerifyArtifactRead) {
        throw new Error(
          `[tool-execute-before] Historical local verify artifact read is blocked for session ${input.sessionID}. ${historicalVerifyArtifactRead.filePath} is iteration${historicalVerifyArtifactRead.staleIteration}, but iteration${historicalVerifyArtifactRead.latestIteration} already exists. Continue from the newest verify iteration instead of reopening stale TRX/artifact state.`,
        )
      }
    }

    if (isDirectoryReadAttempt(normalizedToolName, output.args)) {
      throw new Error(
        `[tool-execute-before] Refusing read on a directory for session ${input.sessionID}. Use glob, ls, or a file path instead.`,
      )
    }

    if (isLegacyEvidenceAliasReadAttempt(normalizedToolName, output.args)) {
      throw new Error(
        `[tool-execute-before] Refusing legacy .sisyphus evidence alias read for session ${input.sessionID}. Read canonical .sisyphus/evidence/ci-loop-checkpoint.md or .sisyphus/evidence/repair-log.md instead.`,
      )
    }

    if (isCoreEvidenceReadAttempt(normalizedToolName, output.args)) {
      setSessionFlag(input.sessionID, CI_EVIDENCE_CORE_READ_FLAG)
    }

    if (
      hasSessionFlag(input.sessionID, CI_FAST_PATH_FLAG)
      && isEvidenceWriteAttempt(normalizedToolName, output.args)
    ) {
      setSessionFlag(input.sessionID, CI_EVIDENCE_MATERIALIZED_FLAG)
    }

    if (
      shouldMarkClaudeReviewPassed(normalizedToolName, output.args)
    ) {
      setSessionFlag(input.sessionID, CI_CLAUDE_REVIEW_PASSED_FLAG)
    }

    if (isDirtyBatchInspectionAttempt(normalizedToolName, output.args)) {
      setSessionFlag(input.sessionID, CI_DIRTY_BATCH_INSPECTED_FLAG)
      clearPlannerBootstrapEvidenceReads(input.sessionID)
    }

    if (isForwardProgressAttempt(normalizedToolName, output.args)) {
      setSessionFlag(input.sessionID, CI_FORWARD_PROGRESS_FLAG)
      clearDirtyBatchReadCounts(input.sessionID)
      clearPostDirtyBatchExploration(input.sessionID)
      clearPlannerBootstrapEvidenceReads(input.sessionID)
    }

    const codeReadPath = getCodeReadPath(normalizedToolName, output.args)
    if (
      codeReadPath
      && hasSessionFlag(input.sessionID, CI_FAST_PATH_FLAG)
      && hasSessionFlag(input.sessionID, CI_EVIDENCE_CORE_READ_FLAG)
      && !hasSessionFlag(input.sessionID, CI_DIRTY_BATCH_INSPECTED_FLAG)
    ) {
      setSessionFlag(input.sessionID, CI_DIRTY_BATCH_INSPECTED_FLAG)
      clearPlannerBootstrapEvidenceReads(input.sessionID)
    }

    if (
      codeReadPath
      && hasSessionFlag(input.sessionID, CI_FAST_PATH_FLAG)
      && hasSessionFlag(input.sessionID, CI_DIRTY_BATCH_INSPECTED_FLAG)
      && !hasSessionFlag(input.sessionID, CI_FORWARD_PROGRESS_FLAG)
    ) {
      const readCount = trackDirtyBatchCodeRead(input.sessionID, codeReadPath)
      if (readCount > 4) {
        throw new Error(
          `[tool-execute-before] Repeated dirty-batch code rereads are blocked for CI fast-path session ${input.sessionID}. ${codeReadPath} has already been read ${readCount - 1} times since the current dirty-batch inspection. Move to an edit, bounded rerun, build/test step, or evidence update instead of rereading the same file again.`,
        )
      }
    }

    if (
      hasSessionFlag(input.sessionID, CI_FAST_PATH_FLAG)
      && hasSessionFlag(input.sessionID, CI_DIRTY_BATCH_INSPECTED_FLAG)
      && !hasSessionFlag(input.sessionID, CI_FORWARD_PROGRESS_FLAG)
      && isSlowCsharpLspDiagnosticsAttempt(normalizedToolName, output.args)
    ) {
      throw new Error(
        `[tool-execute-before] C# lsp_diagnostics is blocked for CI fast-path session ${input.sessionID} before forward progress. The csharp LSP startup path is too slow for the first dirty-batch wave; move to narrow reads/grep, an edit, or the bounded rerun instead of waiting on csharp server initialization.`,
      )
    }

    if (
      hasSessionFlag(input.sessionID, CI_FAST_PATH_FLAG)
      && hasSessionFlag(input.sessionID, CI_DIRTY_BATCH_INSPECTED_FLAG)
      && !hasSessionFlag(input.sessionID, CI_FORWARD_PROGRESS_FLAG)
      && isPostDirtyBatchExplorationAttempt(normalizedToolName, output.args)
    ) {
      const explorationCount = trackPostDirtyBatchExploration(input.sessionID)
      if (explorationCount > POST_DIRTY_BATCH_EXPLORATION_BUDGET) {
        throw new Error(
          `[tool-execute-before] Post-dirty-batch exploration budget is exhausted for CI fast-path session ${input.sessionID}. ${normalizedToolName} would be exploration step ${explorationCount} since the current dirty-batch inspection. Move to an edit, bounded rerun, build/test step, Claude review, or evidence write instead of continuing source-pass exploration.`,
        )
      }
    }

    if (normalizedToolName === "bash") {
      const rawCommand = typeof output.args.command === "string" ? output.args.command : ""
      const normalizedCommand = rawCommand.replace(/\x00/g, "").trim()

      if (!normalizedCommand) {
        throw new Error(
          `[tool-execute-before] Refusing empty bash command for session ${input.sessionID}.`,
        )
      }

      if (rawCommand.includes("\x00")) {
        output.args.command = rawCommand.replace(/\x00/g, "")
        log("[tool-execute-before] Stripped null bytes from bash command", {
          sessionID: input.sessionID,
          callID: input.callID,
        })
      }

      if (
        hasSessionFlag(input.sessionID, CI_FAST_PATH_FLAG)
        && normalizedCommand.includes("git push")
        && !hasSessionFlag(input.sessionID, CI_CLAUDE_REVIEW_PASSED_FLAG)
      ) {
        throw new Error(
          `[tool-execute-before] Refusing git push for CI fast-path session ${input.sessionID} before a passing Claude review is recorded in repair-log/checkpoint evidence.`,
        )
      }

      validateBambooBashCommand(normalizedCommand, input.sessionID)
      validateLocalContourBashCommand(normalizedCommand, input.sessionID)
      validateShellToolMimicCommand(normalizedCommand, input.sessionID)
    }

    await hooks.writeExistingFileGuard?.["tool.execute.before"]?.(input, output)
    await hooks.questionLabelTruncator?.["tool.execute.before"]?.(input, output)
    await hooks.claudeCodeHooks?.["tool.execute.before"]?.(input, output)
    await hooks.nonInteractiveEnv?.["tool.execute.before"]?.(input, output)
    await hooks.bashFileReadGuard?.["tool.execute.before"]?.(input, output)
    await hooks.commentChecker?.["tool.execute.before"]?.(input, output)
    await hooks.directoryAgentsInjector?.["tool.execute.before"]?.(input, output)
    await hooks.directoryReadmeInjector?.["tool.execute.before"]?.(input, output)
    await hooks.rulesInjector?.["tool.execute.before"]?.(input, output)
    await hooks.tasksTodowriteDisabler?.["tool.execute.before"]?.(input, output)
    await hooks.webfetchRedirectGuard?.["tool.execute.before"]?.(input, output)
    await hooks.prometheusMdOnly?.["tool.execute.before"]?.(input, output)
    await hooks.sisyphusJuniorNotepad?.["tool.execute.before"]?.(input, output)
    await hooks.atlasHook?.["tool.execute.before"]?.(input, output)

    if (
      normalizedToolName === "question"
      || normalizedToolName === "ask_user_question"
      || normalizedToolName === "askuserquestion"
    ) {
      const sessionID = input.sessionID || getMainSessionID()
      await hooks.sessionNotification?.({
        event: {
          type: "tool.execute.before",
          properties: {
            sessionID,
            tool: input.tool,
            args: output.args,
          },
        },
      })
    }

    if (input.tool === "task") {
      const argsObject = output.args
      const category = typeof argsObject.category === "string" ? argsObject.category : undefined
      const subagentType = typeof argsObject.subagent_type === "string" ? argsObject.subagent_type : undefined
      const sessionId = typeof argsObject.session_id === "string" ? argsObject.session_id : undefined

      if (category) {
        argsObject.subagent_type = "sisyphus-junior"
      } else if (!subagentType && sessionId) {
        const resolvedAgent = await resolveSessionAgent(ctx.client, sessionId)
        argsObject.subagent_type = resolvedAgent ?? "continue"
      }

      const normalizedSubagentType =
        typeof argsObject.subagent_type === "string" ? argsObject.subagent_type : undefined
      const prompt = typeof argsObject.prompt === "string" ? argsObject.prompt : ""
      const loopState = typeof ctx.directory === "string" ? readState(ctx.directory) : null
      const shouldInjectOracleVerification =
        normalizedSubagentType === "oracle"
        && loopState?.active === true
        && loopState.ultrawork === true
        && loopState.verification_pending === true
        && loopState.session_id === input.sessionID

      if (shouldInjectOracleVerification) {
        const verificationAttemptId = randomUUID()
        log("[tool-execute-before] Injecting ULW oracle verification attempt", {
          sessionID: input.sessionID,
          callID: input.callID,
          verificationAttemptId,
          loopSessionID: loopState.session_id,
        })
        writeState(ctx.directory, {
          ...loopState,
          verification_attempt_id: verificationAttemptId,
          verification_session_id: undefined,
        })
        argsObject.run_in_background = false
        argsObject.prompt = buildUltraworkOracleVerificationPrompt(
          prompt,
          loopState.prompt,
          verificationAttemptId,
        )
      }
    }

    if (hooks.ralphLoop && input.tool === "skill") {
      const rawName = typeof output.args.name === "string" ? output.args.name : undefined
      const command = rawName?.replace(/^\//, "").toLowerCase()
      const sessionID = input.sessionID || getMainSessionID()

      if (command === "ralph-loop" && sessionID) {
        const rawArgs = rawName?.replace(/^\/?(ralph-loop)\s*/i, "") || ""
        const parsedArguments = parseRalphLoopArguments(rawArgs)

        hooks.ralphLoop.startLoop(sessionID, parsedArguments.prompt, {
          maxIterations: parsedArguments.maxIterations,
          completionPromise: parsedArguments.completionPromise,
          strategy: parsedArguments.strategy,
        })
      } else if (command === "cancel-ralph" && sessionID) {
        hooks.ralphLoop.cancelLoop(sessionID)
      } else if (command === "ulw-loop" && sessionID) {
        const rawArgs = rawName?.replace(/^\/?(ulw-loop)\s*/i, "") || ""
        const parsedArguments = parseRalphLoopArguments(rawArgs)

        hooks.ralphLoop.startLoop(sessionID, parsedArguments.prompt, {
          ultrawork: true,
          maxIterations: parsedArguments.maxIterations,
          completionPromise: parsedArguments.completionPromise,
          strategy: parsedArguments.strategy,
        })
      }
    }

    if (input.tool === "skill") {
      const rawName = typeof output.args.name === "string" ? output.args.name : undefined
      const command = rawName?.replace(/^\//, "").toLowerCase()
      const sessionID = input.sessionID || getMainSessionID()

      if (command === "stop-continuation" && sessionID) {
        hooks.stopContinuationGuard?.stop(sessionID)
        hooks.todoContinuationEnforcer?.cancelAllCountdowns()
        hooks.ralphLoop?.cancelLoop(sessionID)
        clearBoulderState(ctx.directory)
        log("[stop-continuation] All continuation mechanisms stopped", {
          sessionID,
        })
      }
    }
  }
}
