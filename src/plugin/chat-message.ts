import type { OhMyOpenCodeConfig } from "../config"
import type { PluginContext } from "./types"

import { hasConnectedProvidersCache, log } from "../shared"
import { normalizePromptTools } from "../shared/prompt-tools"
import { getSessionModel, setSessionModel } from "../shared/session-model-state"
import { setSessionFlag, setSessionTools } from "../shared/session-tools-store"
import { getMainSessionID, setSessionAgent, subagentSessions } from "../features/claude-code-session-state"
import { applyUltraworkModelOverrideOnMessage } from "./ultrawork-model-override"
import { NATIVE_LOOP_TRIGGERED_FLAG } from "./command-execute-before"
import { parseRalphLoopArguments } from "../hooks/ralph-loop/command-arguments"

import type { CreatedHooks } from "../create-hooks"

type FirstMessageVariantGate = {
  shouldOverride: (sessionID: string) => boolean
  markApplied: (sessionID: string) => void
}

type ChatMessagePart = { type: string; text?: string; [key: string]: unknown }
export type ChatMessageHandlerOutput = { message: Record<string, unknown>; parts: ChatMessagePart[] }
export type ChatMessageInput = {
  sessionID: string
  agent?: string
  model?: { providerID: string; modelID: string }
}
type StartWorkHookOutput = { parts: Array<{ type: string; text?: string }> }

type SessionModelOverride = { providerID: string; modelID: string }

function isStartWorkHookOutput(value: unknown): value is StartWorkHookOutput {
  if (typeof value !== "object" || value === null) return false
  const record = value as Record<string, unknown>
  const partsValue = record["parts"]
  if (!Array.isArray(partsValue)) return false
  return partsValue.every((part) => {
    if (typeof part !== "object" || part === null) return false
    const partRecord = part as Record<string, unknown>
    return typeof partRecord["type"] === "string"
  })
}

function isDirectCiEvidenceModePrompt(parts: ChatMessagePart[]): boolean {
  const text = parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n")
    .toLowerCase()

  if (!text.includes(".sisyphus/evidence/")) {
    return false
  }

  const ciSignals = [
    "evidence-gated ci",
    "ci fix loop",
    "current failing set",
    "claude review",
    "ci-loop-checkpoint",
    "repair-log",
    "playwright",
    "bamboo",
  ]

  return ciSignals.some((signal) => text.includes(signal))
}

function applyDirectCiEvidenceModeRestrictions(
  sessionID: string,
  output: ChatMessageHandlerOutput,
): void {
  const tools = (output.message["tools"] as Record<string, unknown> | undefined) ?? {}
  output.message["tools"] = {
    ...tools,
    skill: false,
    skill_mcp: false,
    teammate: false,
    call_omo_agent: false,
    session_search: false,
    todowrite: false,
    todoread: false,
    webfetch: false,
  }
  setSessionFlag(sessionID, "ci-fast-path")
}

function hasExplicitAgentModelOverride(
  agent: string | undefined,
  pluginConfig: OhMyOpenCodeConfig
): boolean {
  const configuredAgents = pluginConfig.agents
  if (!agent || !configuredAgents || !(agent in configuredAgents)) {
    return false
  }

  const configuredAgent = configuredAgents[agent as keyof typeof configuredAgents]
  const configuredModel = configuredAgent?.model
  return typeof configuredModel === "string" && configuredModel.trim().length > 0
}

function getStoredMainSessionModel(
  input: ChatMessageInput,
  pluginConfig: OhMyOpenCodeConfig,
  isFirstMessage: boolean,
  output: ChatMessageHandlerOutput
): SessionModelOverride | undefined {
  if (isFirstMessage) {
    return undefined
  }

  if (subagentSessions.has(input.sessionID)) {
    return undefined
  }

  if (getMainSessionID() !== input.sessionID) {
    return undefined
  }

  if (input.model) {
    return undefined
  }

  if (output.message["model"] !== undefined) {
    return undefined
  }

  if (hasExplicitAgentModelOverride(input.agent, pluginConfig)) {
    return undefined
  }

  return getSessionModel(input.sessionID)
}

export function createChatMessageHandler(args: {
  ctx: PluginContext
  pluginConfig: OhMyOpenCodeConfig
  firstMessageVariantGate: FirstMessageVariantGate
  hooks: CreatedHooks
}): (
  input: ChatMessageInput,
  output: ChatMessageHandlerOutput
) => Promise<void> {
  const { ctx, pluginConfig, firstMessageVariantGate, hooks } = args
  const pluginContext = ctx as {
    client: {
      tui: {
        showToast: (input: {
          body: {
            title: string
            message: string
            variant: "warning"
            duration: number
          }
        }) => Promise<unknown>
      }
    }
  }
  const isRuntimeFallbackEnabled =
    hooks.runtimeFallback !== null &&
    hooks.runtimeFallback !== undefined &&
    (typeof pluginConfig.runtime_fallback === "boolean"
      ? pluginConfig.runtime_fallback
      : (pluginConfig.runtime_fallback?.enabled ?? false))

  return async (
    input: ChatMessageInput,
    output: ChatMessageHandlerOutput
  ): Promise<void> => {
    const promptPreview = output.parts
      ?.filter((p) => p.type === "text")
      .map((p) => (p.text ?? "").slice(0, 60))
      .join("|") || "(empty)"
    log("[chat.message] ENTRY", {
      sessionID: input.sessionID,
      agent: input.agent,
      promptPreview,
    })

    if (input.agent) {
      setSessionAgent(input.sessionID, input.agent)
    }

    const isFirstMessage = firstMessageVariantGate.shouldOverride(input.sessionID)
    if (isFirstMessage) {
      firstMessageVariantGate.markApplied(input.sessionID)
    }

    const storedMainSessionModel = getStoredMainSessionModel(
      input,
      pluginConfig,
      isFirstMessage,
      output,
    )
    if (storedMainSessionModel) {
      output.message["model"] = storedMainSessionModel
    }

    if (!isRuntimeFallbackEnabled) {
      await hooks.modelFallback?.["chat.message"]?.(input, output)
    }
    const modelOverride = output.message["model"]
    if (
      modelOverride &&
      typeof modelOverride === "object" &&
      "providerID" in modelOverride &&
      "modelID" in modelOverride
    ) {
      const providerID = (modelOverride as { providerID?: string }).providerID
      const modelID = (modelOverride as { modelID?: string }).modelID
      if (typeof providerID === "string" && typeof modelID === "string") {
        setSessionModel(input.sessionID, { providerID, modelID })
      }
    } else if (input.model) {
      setSessionModel(input.sessionID, input.model)
    }
    await hooks.stopContinuationGuard?.["chat.message"]?.(input)
    await hooks.backgroundNotificationHook?.["chat.message"]?.(input, output)
    await hooks.runtimeFallback?.["chat.message"]?.(input, output)
    await hooks.autoSlashCommand?.["chat.message"]?.(input, output)
    await hooks.keywordDetector?.["chat.message"]?.(input, output)
    await hooks.thinkMode?.["chat.message"]?.(input, output)
    await hooks.claudeCodeHooks?.["chat.message"]?.(input, output)
    await hooks.noSisyphusGpt?.["chat.message"]?.(input, output)
    await hooks.noHephaestusNonGpt?.["chat.message"]?.(input, output)
    if (hooks.startWork && isStartWorkHookOutput(output)) {
      await hooks.startWork["chat.message"]?.(input, output)
    }
    if (isDirectCiEvidenceModePrompt(output.parts)) {
      applyDirectCiEvidenceModeRestrictions(input.sessionID, output)
    }
    const normalizedTools = normalizePromptTools(
      output.message["tools"] as Record<string, boolean | "allow" | "deny" | "ask"> | undefined,
    )
    if (normalizedTools) {
      setSessionTools(input.sessionID, normalizedTools)
    }

    if (!hasConnectedProvidersCache()) {
      pluginContext.client.tui
        .showToast({
          body: {
            title: "⚠️ Provider Cache Missing",
            message:
              "Model filtering disabled. RESTART OpenCode to enable full functionality.",
            variant: "warning" as const,
            duration: 6000,
          },
        })
        .catch(() => {})
    }

    const nativeLoopTriggered = output.message?.[NATIVE_LOOP_TRIGGERED_FLAG] === true

    if (hooks.ralphLoop && !nativeLoopTriggered) {
      const parts = output.parts
      const promptText =
        parts
          ?.filter((p) => p.type === "text" && p.text)
          .map((p) => p.text)
          .join("\n")
          .trim() || ""

      const isRalphLoopTemplate =
        promptText.includes("You are starting a Ralph Loop") &&
        promptText.includes("<user-task>")
      const isUlwLoopTemplate =
        promptText.includes("You are starting an ULTRAWORK Loop") &&
        promptText.includes("<user-task>")
      const isCancelRalphTemplate = promptText.includes(
        "Cancel the currently active Ralph Loop",
      )

      if (isRalphLoopTemplate || isUlwLoopTemplate) {
        const taskMatch = promptText.match(/<user-task>\s*([\s\S]*?)\s*<\/user-task>/i)
        const rawTask = taskMatch?.[1]?.trim() || ""
        const parsedArguments = parseRalphLoopArguments(rawTask)

        hooks.ralphLoop.startLoop(input.sessionID, parsedArguments.prompt, {
          ultrawork: isUlwLoopTemplate,
          maxIterations: parsedArguments.maxIterations,
          completionPromise: parsedArguments.completionPromise,
          strategy: parsedArguments.strategy,
        })
      } else if (isCancelRalphTemplate) {
        hooks.ralphLoop.cancelLoop(input.sessionID)
      }
    }

    await applyUltraworkModelOverrideOnMessage(
      pluginConfig,
      input.agent,
      output,
      pluginContext.client.tui,
      input.sessionID,
      pluginContext.client,
    )
  }
}
