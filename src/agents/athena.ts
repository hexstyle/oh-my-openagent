import type { AgentConfig } from "@opencode-ai/sdk"
import type { AgentMode } from "./types"
import { buildAthenaPrompt, type AthenaPromptOptions } from "./athena/prompt"

const MODE: AgentMode = "primary"

export function createAthenaAgent(model: string, options?: AthenaPromptOptions): AgentConfig {
  return {
    description: "Primary council orchestrator for Athena workflows. (Athena - OhMyOpenCode)",
    mode: MODE,
    model,
    temperature: 0.1,
    prompt: buildAthenaPrompt(options),
  }
}
createAthenaAgent.mode = MODE
