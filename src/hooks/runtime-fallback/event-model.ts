import { parseModelString } from "../../tools/delegate-task/model-string-parser"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function buildModelStringWithVariant(
  modelString: string,
  variant: unknown,
): string {
  if (typeof modelString !== "string" || modelString.length === 0) {
    return modelString
  }

  const parsed = parseModelString(modelString)
  if (!parsed) {
    return modelString
  }

  if (parsed.variant) {
    return `${parsed.providerID}/${parsed.modelID}(${parsed.variant})`
  }

  const normalizedVariant = typeof variant === "string" ? variant.trim() : ""
  if (!normalizedVariant) {
    return `${parsed.providerID}/${parsed.modelID}`
  }

  return `${parsed.providerID}/${parsed.modelID}(${normalizedVariant})`
}

export function extractEventModelString(input: {
  model?: unknown
  providerID?: unknown
  modelID?: unknown
  variant?: unknown
}): string | undefined {
  const { model, providerID, modelID, variant } = input

  if (typeof model === "string" && model.length > 0) {
    if (model.includes("/")) {
      return buildModelStringWithVariant(model, variant)
    }

    if (typeof providerID === "string" && providerID.length > 0) {
      return buildModelStringWithVariant(`${providerID}/${model}`, variant)
    }
  }

  if (isRecord(model)) {
    const nestedProviderID = typeof model.providerID === "string" ? model.providerID : undefined
    const nestedModelID = typeof model.modelID === "string" ? model.modelID : undefined
    const nestedVariant = typeof model.variant === "string" ? model.variant : variant
    if (nestedProviderID && nestedModelID) {
      return buildModelStringWithVariant(`${nestedProviderID}/${nestedModelID}`, nestedVariant)
    }
  }

  if (
    typeof providerID === "string" &&
    providerID.length > 0 &&
    typeof modelID === "string" &&
    modelID.length > 0
  ) {
    return buildModelStringWithVariant(`${providerID}/${modelID}`, variant)
  }

  return undefined
}
