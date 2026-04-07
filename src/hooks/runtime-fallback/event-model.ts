function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function extractEventModelString(input: {
  model?: unknown
  providerID?: unknown
  modelID?: unknown
}): string | undefined {
  const { model, providerID, modelID } = input

  if (typeof model === "string" && model.length > 0) {
    if (model.includes("/")) {
      return model
    }

    if (typeof providerID === "string" && providerID.length > 0) {
      return `${providerID}/${model}`
    }
  }

  if (isRecord(model)) {
    const nestedProviderID = typeof model.providerID === "string" ? model.providerID : undefined
    const nestedModelID = typeof model.modelID === "string" ? model.modelID : undefined
    if (nestedProviderID && nestedModelID) {
      return `${nestedProviderID}/${nestedModelID}`
    }
  }

  if (
    typeof providerID === "string" &&
    providerID.length > 0 &&
    typeof modelID === "string" &&
    modelID.length > 0
  ) {
    return `${providerID}/${modelID}`
  }

  return undefined
}
