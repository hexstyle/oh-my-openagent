import type { DelegateTaskArgs, OpencodeClient, DelegatedModelConfig } from "./types"
import type { SisyphusAgentConfig } from "../../config/schema"
import { isPlanFamily } from "./constants"
import { buildTaskPrompt } from "./prompt-builder"
import {
  promptSyncWithModelSuggestionRetry,
  promptWithModelSuggestionRetry,
} from "../../shared/model-suggestion-retry"
import { formatDetailedError } from "./error-formatting"
import { getAgentToolRestrictions } from "../../shared/agent-tool-restrictions"
import { getAgentConfigKey, normalizeAgentForSessionPrompt } from "../../shared/agent-display-names"
import { applySessionPromptParams } from "../../shared/session-prompt-params-helpers"
import { setSessionTools } from "../../shared/session-tools-store"
import { createInternalAgentTextPart } from "../../shared/internal-initiator-marker"

type SendSyncPromptDeps = {
  promptWithModelSuggestionRetry: typeof promptWithModelSuggestionRetry
  promptSyncWithModelSuggestionRetry: typeof promptSyncWithModelSuggestionRetry
}

const sendSyncPromptDeps: SendSyncPromptDeps = {
  promptWithModelSuggestionRetry,
  promptSyncWithModelSuggestionRetry,
}

function isOracleAgent(agentToUse: string): boolean {
  return getAgentConfigKey(agentToUse) === "oracle"
}

function isUnexpectedEofError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const lowered = message.toLowerCase()
  return lowered.includes("unexpected eof") || lowered.includes("json parse error")
}

function isAssistantPrefillError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const lowered = message.toLowerCase()
  return (
    lowered.includes("assistant message prefill")
    || lowered.includes("conversation must end with a user message")
  )
}

export async function sendSyncPrompt(
  client: OpencodeClient,
  input: {
    sessionID: string
    agentToUse: string
    args: DelegateTaskArgs
    systemContent: string | undefined
    categoryModel: DelegatedModelConfig | undefined
    toastManager: { removeTask: (id: string) => void } | null | undefined
    taskId: string | undefined
    sisyphusAgentConfig?: SisyphusAgentConfig
  },
  deps: SendSyncPromptDeps = sendSyncPromptDeps
): Promise<string | null> {
  const executionAgent = getAgentConfigKey(input.agentToUse)
  const allowTask = isPlanFamily(executionAgent)
  const tddEnabled = input.sisyphusAgentConfig?.tdd
  const effectivePrompt = buildTaskPrompt(input.args.prompt, input.agentToUse, tddEnabled)
  const promptAgent = normalizeAgentForSessionPrompt(input.agentToUse) ?? input.agentToUse
  const tools = {
    task: allowTask,
    call_omo_agent: true,
    question: false,
    ...getAgentToolRestrictions(executionAgent),
  }
  setSessionTools(input.sessionID, tools)

  applySessionPromptParams(input.sessionID, input.categoryModel)

  const promptArgs = {
    path: { id: input.sessionID },
    body: {
      agent: promptAgent,
      system: input.systemContent,
      tools,
      parts: [createInternalAgentTextPart(effectivePrompt)],
      ...(input.categoryModel
        ? {
            model: {
              providerID: input.categoryModel.providerID,
              modelID: input.categoryModel.modelID,
            },
          }
        : {}),
      ...(input.categoryModel?.variant ? { variant: input.categoryModel.variant } : {}),
    },
  }

  try {
    await deps.promptWithModelSuggestionRetry(client, promptArgs)
  } catch (promptError) {
    if (isAssistantPrefillError(promptError)) {
      try {
        await deps.promptWithModelSuggestionRetry(client, {
          ...promptArgs,
          body: {
            ...promptArgs.body,
            parts: [{ type: "text", text: effectivePrompt }],
          },
        })
        return null
      } catch (plainUserRetryError) {
        promptError = plainUserRetryError
      }
    }

    if (isOracleAgent(input.agentToUse) && isUnexpectedEofError(promptError)) {
      try {
        await deps.promptSyncWithModelSuggestionRetry(client, promptArgs)
        return null
      } catch (oracleRetryError) {
        promptError = oracleRetryError
      }
    }

    if (input.toastManager && input.taskId !== undefined) {
      input.toastManager.removeTask(input.taskId)
    }
    const errorMessage = promptError instanceof Error ? promptError.message : String(promptError)
    if (errorMessage.includes("agent.name") || errorMessage.includes("undefined")) {
      return formatDetailedError(new Error(`Agent "${input.agentToUse}" not found. Make sure the agent is registered in your opencode.json or provided by a plugin.`), {
        operation: "Send prompt to agent",
        args: input.args,
        sessionID: input.sessionID,
        agent: input.agentToUse,
        category: input.args.category,
      })
    }
    return formatDetailedError(promptError, {
      operation: "Send prompt",
      args: input.args,
      sessionID: input.sessionID,
      agent: input.agentToUse,
      category: input.args.category,
    })
  }

  return null
}
