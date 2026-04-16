import { log } from "../../shared/logger"
import { SYSTEM_DIRECTIVE_PREFIX } from "../../shared/system-directive"
import { isCallerOrchestrator } from "../../shared/session-utils"
import type { PluginInput } from "@opencode-ai/plugin"
import { getTaskSessionState, readBoulderState, readCurrentTopLevelTask } from "../../features/boulder-state"
import { HOOK_NAME } from "./hook-name"
import {
  ORCHESTRATOR_DELEGATION_REQUIRED,
  ORCHESTRATOR_RESEARCH_LOOP_WARNING,
  SINGLE_TASK_DIRECTIVE,
} from "./system-reminder-templates"
import { isSisyphusPath } from "./sisyphus-path"
import type { PendingTaskRef, SessionState, TrackedTopLevelTaskRef } from "./types"
import { isWriteOrEditToolName } from "./write-edit-tool-policy"

const DIRECT_RESEARCH_TOOLS = new Set([
  "read",
  "bash",
  "grep",
  "glob",
  "ast_grep_search",
  "lsp_definition",
  "lsp_references",
  "lsp_symbols",
  "lsp_hover",
  "lsp_diagnostics",
])
const DIRECT_RESEARCH_REMINDER_THRESHOLD = 3

export function createToolExecuteBeforeHandler(input: {
  ctx: PluginInput
  pendingFilePaths: Map<string, string>
  pendingTaskRefs: Map<string, PendingTaskRef>
  getState: (sessionID: string) => SessionState
}): (
  toolInput: { tool: string; sessionID?: string; callID?: string },
  toolOutput: { args: Record<string, unknown>; message?: string }
) => Promise<void> {
  const { ctx, pendingFilePaths, pendingTaskRefs, getState } = input

  function trackTask(callID: string, task: TrackedTopLevelTaskRef): void {
    pendingTaskRefs.set(callID, { kind: "track", task })
  }

  return async (toolInput, toolOutput): Promise<void> => {
    const normalizedToolName = toolInput.tool.toLowerCase()

    if (!(await isCallerOrchestrator(toolInput.sessionID, ctx.client))) {
      return
    }

    const sessionState = toolInput.sessionID ? getState(toolInput.sessionID) : undefined

    // Check Write/Edit tools for orchestrator - inject strong warning
    // Warn-only policy: Atlas guides orchestrators toward delegation but doesn't block, allowing flexibility for urgent fixes
    if (isWriteOrEditToolName(toolInput.tool)) {
      const filePath = (toolOutput.args.filePath ?? toolOutput.args.path ?? toolOutput.args.file) as string | undefined
      if (filePath && !isSisyphusPath(filePath)) {
        // Store filePath for use in tool.execute.after
        if (toolInput.callID) {
          pendingFilePaths.set(toolInput.callID, filePath)
        }
        const warning = ORCHESTRATOR_DELEGATION_REQUIRED.replace("$FILE_PATH", filePath)
        toolOutput.message = (toolOutput.message || "") + warning
        log(`[${HOOK_NAME}] Injected delegation warning for direct file modification`, {
          sessionID: toolInput.sessionID,
          tool: toolInput.tool,
          filePath,
        })
      }
      return
    }

    // Check task - inject single-task directive
    if (normalizedToolName === "task") {
      if (sessionState) {
        sessionState.directResearchToolCount = 0
        sessionState.lastDelegationReminderTaskKey = undefined
      }

      if (toolInput.callID) {
        const requestedSessionId = toolOutput.args.session_id as string | undefined
        if (requestedSessionId) {
          pendingTaskRefs.set(toolInput.callID, {
            kind: "skip",
            reason: "explicit_resume",
          })
        } else {
          const boulderState = readBoulderState(ctx.directory)
          const currentTask = boulderState
            ? readCurrentTopLevelTask(boulderState.active_plan)
            : null
          if (currentTask) {
            const task = {
              key: currentTask.key,
              label: currentTask.label,
              title: currentTask.title,
            }
            const hasExistingClaim = [...pendingTaskRefs.values()].some((pendingTaskRef) => (
              pendingTaskRef.kind === "track" && pendingTaskRef.task.key === task.key
            ))

            if (hasExistingClaim) {
              pendingTaskRefs.set(toolInput.callID, {
                kind: "skip",
                reason: "ambiguous_task_key",
                task,
              })
              log(`[${HOOK_NAME}] Skipping task session persistence for ambiguous task key`, {
                sessionID: toolInput.sessionID,
                callID: toolInput.callID,
                taskKey: task.key,
              })
            } else {
              trackTask(toolInput.callID, task)
            }
          }
        }
      }

      const prompt = toolOutput.args.prompt as string | undefined
      if (prompt && !prompt.includes(SYSTEM_DIRECTIVE_PREFIX)) {
        toolOutput.args.prompt = `<system-reminder>${SINGLE_TASK_DIRECTIVE}</system-reminder>\n` + prompt
        log(`[${HOOK_NAME}] Injected single-task directive to task`, {
          sessionID: toolInput.sessionID,
        })
      }
      return
    }

    if (
      sessionState
      && toolInput.sessionID
      && DIRECT_RESEARCH_TOOLS.has(normalizedToolName)
    ) {
      const boulderState = readBoulderState(ctx.directory)
      const currentTask = boulderState
        ? readCurrentTopLevelTask(boulderState.active_plan)
        : null

      if (!currentTask) {
        return
      }

      const existingTaskSession = getTaskSessionState(ctx.directory, currentTask.key)
      if (existingTaskSession?.session_id) {
        sessionState.directResearchToolCount = 0
        sessionState.lastDelegationReminderTaskKey = undefined
        return
      }

      sessionState.directResearchToolCount = (sessionState.directResearchToolCount ?? 0) + 1

      if (
        sessionState.directResearchToolCount < DIRECT_RESEARCH_REMINDER_THRESHOLD
        || sessionState.lastDelegationReminderTaskKey === currentTask.key
      ) {
        return
      }

      const warning = ORCHESTRATOR_RESEARCH_LOOP_WARNING.replace("$TASK_TITLE", currentTask.title)
      toolOutput.message = (toolOutput.message || "") + warning
      sessionState.lastDelegationReminderTaskKey = currentTask.key
      log(`[${HOOK_NAME}] Injected delegation reminder after repeated direct research`, {
        sessionID: toolInput.sessionID,
        tool: normalizedToolName,
        taskKey: currentTask.key,
        directResearchToolCount: sessionState.directResearchToolCount,
      })
    }
  }
}
