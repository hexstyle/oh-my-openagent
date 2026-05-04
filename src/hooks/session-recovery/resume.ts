import type { createOpencodeClient } from "@opencode-ai/sdk"
import type { MessageData, ResumeConfig } from "./types"
import { createInternalAgentTextPart, resolveInheritedPromptTools } from "../../shared"
import { normalizeAgentForExecution, normalizeAgentForSessionPrompt } from "../../shared/agent-display-names"
import {
  getMessageAgent,
  getMessageModel,
  getMessageRole,
  getMessageTools,
} from "./message-accessors"

const RECOVERY_RESUME_TEXT = "[session recovered - continuing previous task]"
const RESUME_RETRY_ATTEMPTS = 20
const RESUME_RETRY_DELAY_MS = 250

type Client = ReturnType<typeof createOpencodeClient>
type ResumePromptInput = {
  path: { id: string }
  body: {
    parts: Array<{ type: "text"; text: string }>
    agent?: string
    model?: { providerID: string; modelID: string }
    tools?: Record<string, boolean>
  }
  query?: { directory: string }
}
type ResumePromptFn = (input: ResumePromptInput) => Promise<unknown>
type ResumePromptAttemptResult = {
  ok: boolean
  lastError?: unknown
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function extractResumeErrorMessage(error: unknown): string {
  if (!error) {
    return ""
  }

  if (typeof error === "string") {
    return error
  }

  if (error instanceof Error) {
    return error.message
  }

  if (typeof error === "object" && error !== null) {
    const record = error as {
      message?: unknown
      data?: { message?: unknown } | unknown
      cause?: { message?: unknown } | unknown
    }

    if (typeof record.message === "string") {
      return record.message
    }
    if (typeof record.data === "object" && record.data !== null && typeof (record.data as { message?: unknown }).message === "string") {
      return (record.data as { message: string }).message
    }
    if (typeof record.cause === "object" && record.cause !== null && typeof (record.cause as { message?: unknown }).message === "string") {
      return (record.cause as { message: string }).message
    }
  }

  return ""
}

function isRetryableResumeError(error: unknown): boolean {
  const message = extractResumeErrorMessage(error)

  if (!message) {
    return false
  }

  const normalized = message.toLowerCase()
  return (
    normalized.includes("aborted")
    || normalized.includes("busy")
    || normalized.includes("already running")
    || normalized.includes("another prompt")
    || normalized.includes("prompt in progress")
    || normalized.includes("session is not idle")
  )
}

function isAgentResolutionResumeError(error: unknown): boolean {
  const message = extractResumeErrorMessage(error)
  if (!message) {
    return false
  }

  return /(?:default\s+)?agent .*not found/i.test(message)
}

function buildResumePromptInput(
  config: ResumeConfig,
  agentOverride?: string,
): ResumePromptInput {
  const inheritedTools = resolveInheritedPromptTools(config.sessionID, config.tools)

  return {
    path: { id: config.sessionID },
    body: {
      parts: [createInternalAgentTextPart(config.continuationText ?? RECOVERY_RESUME_TEXT)],
      ...(agentOverride ? { agent: agentOverride } : {}),
      model: config.model,
      ...(inheritedTools ? { tools: inheritedTools } : {}),
    },
    ...(config.directory ? { query: { directory: config.directory } } : {}),
  }
}

function buildResumePromptInputs(config: ResumeConfig): ResumePromptInput[] {
  const variants = new Set<string>()
  const promptAgent = normalizeAgentForSessionPrompt(config.agent) ?? config.agent
  const executionAgent = normalizeAgentForExecution(config.agent)
  const trimmedAgent = typeof config.agent === "string" ? config.agent.trim() : undefined

  if (typeof promptAgent === "string" && promptAgent.trim().length > 0) {
    variants.add(promptAgent.trim())
  }
  if (typeof executionAgent === "string" && executionAgent.trim().length > 0) {
    variants.add(executionAgent.trim())
  }
  if (typeof trimmedAgent === "string" && trimmedAgent.length > 0) {
    variants.add(trimmedAgent)
  }

  return [...variants].map((agent) => buildResumePromptInput(config, agent))
}

async function tryResumePrompt(
  fn: ResumePromptFn | undefined,
  promptInput: ResumePromptInput,
): Promise<ResumePromptAttemptResult> {
  if (typeof fn !== "function") {
    return { ok: false }
  }

  for (let attempt = 1; attempt <= RESUME_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await fn(promptInput)
      return { ok: true }
    } catch (error) {
      if (isAgentResolutionResumeError(error)) {
        return { ok: false, lastError: error }
      }

      if (!isRetryableResumeError(error) || attempt === RESUME_RETRY_ATTEMPTS) {
        return { ok: false, lastError: error }
      }

      await sleep(RESUME_RETRY_DELAY_MS)
    }
  }

  return { ok: false }
}

export function findLastUserMessage(messages: MessageData[]): MessageData | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (getMessageRole(messages[i]) === "user") {
      return messages[i]
    }
  }
  return undefined
}

export function extractResumeConfig(userMessage: MessageData | undefined, sessionID: string): ResumeConfig {
  return {
    sessionID,
    agent: getMessageAgent(userMessage),
    model: getMessageModel(userMessage),
    tools: getMessageTools(userMessage),
  }
}

export async function resumeSession(client: Client, config: ResumeConfig): Promise<boolean> {
  const session = client.session as {
    promptAsync?: (input: ResumePromptInput) => Promise<unknown>
    prompt?: (input: ResumePromptInput) => Promise<unknown>
  }

  for (const promptInput of buildResumePromptInputs(config)) {
    const promptAsyncResult = await tryResumePrompt(session.promptAsync, promptInput)
    if (promptAsyncResult.ok) {
      return true
    }

    if (!isAgentResolutionResumeError(promptAsyncResult.lastError)) {
      const promptResult = await tryResumePrompt(session.prompt, promptInput)
      if (promptResult.ok) {
        return true
      }

      if (!isAgentResolutionResumeError(promptResult.lastError)) {
        break
      }
    }
  }

  return false
}
