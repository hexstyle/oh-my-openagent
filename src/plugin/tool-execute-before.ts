import type { PluginContext } from "./types"
import { randomUUID } from "node:crypto"
import { existsSync, statSync } from "node:fs"

import { getMainSessionID } from "../features/claude-code-session-state"
import { clearBoulderState } from "../features/boulder-state"
import { log } from "../shared"
import {
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
      return typeof command === "string" && (
        command.includes(".sisyphus/evidence/tests/")
        || command.includes(".sisyphus/evidence/repair-log.md")
        || command.includes(".sisyphus/evidence/ci-loop-checkpoint.md")
      )
    }

    return false
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

  return async (input, output): Promise<void> => {
    if (isSessionToolDisabled(input.sessionID, input.tool)) {
      throw new Error(
        `[tool-execute-before] Tool "${input.tool}" is disabled for session ${input.sessionID}.`
      )
    }

    const normalizedToolName = input.tool.toLowerCase()

    if (
      hasSessionFlag(input.sessionID, CI_EVIDENCE_MATERIALIZED_FLAG)
      && isTrackerReadAttempt(normalizedToolName, output.args)
    ) {
      throw new Error(
        `[tool-execute-before] Tracker evidence rereads are blocked for CI fast-path session ${input.sessionID} after evidence materialization. Move to code edits, verification, or a fresh CI fetch.`,
      )
    }

    if (isDirectoryReadAttempt(normalizedToolName, output.args)) {
      throw new Error(
        `[tool-execute-before] Refusing read on a directory for session ${input.sessionID}. Use glob, ls, or a file path instead.`,
      )
    }

    if (
      hasSessionFlag(input.sessionID, CI_FAST_PATH_FLAG)
      && isLegacyEvidenceAliasReadAttempt(normalizedToolName, output.args)
    ) {
      throw new Error(
        `[tool-execute-before] Refusing legacy .sisyphus evidence alias read for session ${input.sessionID}. Read canonical .sisyphus/evidence/ci-loop-checkpoint.md or .sisyphus/evidence/repair-log.md instead.`,
      )
    }

    if (
      hasSessionFlag(input.sessionID, CI_FAST_PATH_FLAG)
      && isEvidenceWriteAttempt(normalizedToolName, output.args)
    ) {
      setSessionFlag(input.sessionID, CI_EVIDENCE_MATERIALIZED_FLAG)
    }

    if (
      hasSessionFlag(input.sessionID, CI_FAST_PATH_FLAG)
      && shouldMarkClaudeReviewPassed(normalizedToolName, output.args)
    ) {
      setSessionFlag(input.sessionID, CI_CLAUDE_REVIEW_PASSED_FLAG)
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
