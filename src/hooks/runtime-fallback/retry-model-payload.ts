import { parseModelString } from "../../tools/delegate-task/model-string-parser"

interface AgentSettings {
  variant?: string
  reasoningEffort?: string
}

export function buildRetryModelPayload(
  model: string,
  agentSettings?: AgentSettings,
): { model: { providerID: string; modelID: string }; variant?: string; reasoningEffort?: string } | undefined {
  const parsedModel = parseModelString(model)
  if (!parsedModel) {
    return undefined
  }

  const variant = parsedModel.variant ?? agentSettings?.variant
  const reasoningEffort = agentSettings?.reasoningEffort

  const result: { model: { providerID: string; modelID: string }; variant?: string; reasoningEffort?: string } = {
    model: {
      providerID: parsedModel.providerID,
      modelID: parsedModel.modelID,
    },
  }

  if (variant) {
    result.variant = variant
  }

  if (reasoningEffort) {
    result.reasoningEffort = reasoningEffort
  }

  return result
}
