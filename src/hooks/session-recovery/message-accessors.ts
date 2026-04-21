type MessageLike = {
  info?: {
    id?: string
    role?: string
    error?: unknown
    agent?: string
    model?: {
      providerID?: string
      modelID?: string
    }
    tools?: Record<string, boolean>
  }
  id?: string
  role?: string
  error?: unknown
  agent?: string
  model?: {
    providerID?: string
    modelID?: string
  }
  providerID?: string
  modelID?: string
  tools?: Record<string, boolean>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function getMessageID(message: MessageLike | undefined): string | undefined {
  if (!message) return undefined
  if (typeof message.info?.id === "string" && message.info.id.length > 0) return message.info.id
  return typeof message.id === "string" && message.id.length > 0 ? message.id : undefined
}

export function getMessageRole(message: MessageLike | undefined): string | undefined {
  if (!message) return undefined
  if (typeof message.info?.role === "string" && message.info.role.length > 0) return message.info.role
  return typeof message.role === "string" && message.role.length > 0 ? message.role : undefined
}

export function getMessageError(message: MessageLike | undefined): unknown {
  if (!message) return undefined
  return message.info?.error ?? message.error
}

export function getMessageAgent(message: MessageLike | undefined): string | undefined {
  if (!message) return undefined

  if (typeof message.info?.agent === "string" && message.info.agent.length > 0) {
    return message.info.agent
  }

  if (typeof message.agent === "string" && message.agent.length > 0) {
    return message.agent
  }

  return undefined
}

export function getMessageModel(
  message: MessageLike | undefined,
): { providerID: string; modelID: string } | undefined {
  if (!message) return undefined

  const infoModel = message.info?.model
  if (infoModel?.providerID && infoModel?.modelID) {
    return {
      providerID: infoModel.providerID,
      modelID: infoModel.modelID,
    }
  }

  if (
    isRecord(message.model)
    && typeof message.model.providerID === "string"
    && message.model.providerID.length > 0
    && typeof message.model.modelID === "string"
    && message.model.modelID.length > 0
  ) {
    return {
      providerID: message.model.providerID,
      modelID: message.model.modelID,
    }
  }

  if (
    typeof message.providerID === "string"
    && message.providerID.length > 0
    && typeof message.modelID === "string"
    && message.modelID.length > 0
  ) {
    return {
      providerID: message.providerID,
      modelID: message.modelID,
    }
  }

  return undefined
}

export function getMessageTools(message: MessageLike | undefined): Record<string, boolean> | undefined {
  if (!message) return undefined
  if (message.info?.tools) return message.info.tools
  if (isRecord(message.tools)) return message.tools as Record<string, boolean>
  return undefined
}
