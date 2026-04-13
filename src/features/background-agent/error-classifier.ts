export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

const GENERIC_WRAPPER_MESSAGE_PATTERNS = [
  /^tool execution aborted$/i,
  /^forbidden$/i,
]

function isGenericWrapperMessage(message: string | undefined): boolean {
  if (!message) return false
  return GENERIC_WRAPPER_MESSAGE_PATTERNS.some((pattern) => pattern.test(message))
}

function getNestedErrorMessage(error: Record<string, unknown>): string | undefined {
  const dataRaw = error["data"]
  const causeRaw = error["cause"]

  const candidates: unknown[] = [
    causeRaw,
    isRecord(causeRaw) ? causeRaw["error"] : undefined,
    isRecord(dataRaw) ? dataRaw["error"] : undefined,
    dataRaw,
    error["error"],
  ]

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate
    if (
      isRecord(candidate) &&
      typeof candidate["message"] === "string" &&
      candidate["message"].length > 0
    ) {
      return candidate["message"]
    }
  }

  return undefined
}

export function isAbortedSessionError(error: unknown): boolean {
  const message = getErrorText(error)
  return message.toLowerCase().includes("aborted")
}

export function getErrorText(error: unknown): string {
  if (!error) return ""
  if (typeof error === "string") return error
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`
  }
  if (typeof error === "object" && error !== null) {
    if ("message" in error && typeof error.message === "string") {
      return error.message
    }
    if ("name" in error && typeof error.name === "string") {
      return error.name
    }
  }
  return ""
}

export function extractErrorName(error: unknown): string | undefined {
  if (isRecord(error)) {
    if (typeof error["name"] === "string") return error["name"]

    const dataRaw = error["data"]
    if (isRecord(dataRaw) && typeof dataRaw["name"] === "string") return dataRaw["name"]

    const errorRaw = error["error"]
    if (isRecord(errorRaw) && typeof errorRaw["name"] === "string") return errorRaw["name"]

    const causeRaw = error["cause"]
    if (isRecord(causeRaw) && typeof causeRaw["name"] === "string") return causeRaw["name"]
  }
  if (error instanceof Error) return error.name
  return undefined
}

export function extractErrorMessage(error: unknown): string | undefined {
  if (!error) return undefined
  if (typeof error === "string") return error
  if (error instanceof Error) {
    const directMessage = error.message
    const nestedMessage = getNestedErrorMessage(error as unknown as Record<string, unknown>)
    if (nestedMessage && isGenericWrapperMessage(directMessage)) {
      return nestedMessage
    }
    return directMessage
  }

  if (isRecord(error)) {
    const directMessage = typeof error["message"] === "string" && error["message"].length > 0
      ? error["message"]
      : undefined
    const nestedMessage = getNestedErrorMessage(error)

    if (nestedMessage && isGenericWrapperMessage(directMessage)) {
      return nestedMessage
    }

    if (directMessage) {
      return directMessage
    }

    if (nestedMessage) {
      return nestedMessage
    }
  }

  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

interface EventPropertiesLike {
  [key: string]: unknown
}

export function getSessionErrorMessage(properties: EventPropertiesLike): string | undefined {
  const errorRaw = properties["error"]
  if (!isRecord(errorRaw)) return undefined

  const dataRaw = errorRaw["data"]
  if (isRecord(dataRaw)) {
    const message = dataRaw["message"]
    if (typeof message === "string") return message
  }

  const directMessage = typeof errorRaw["message"] === "string" ? errorRaw["message"] : undefined
  const causeRaw = errorRaw["cause"]
  const causeMessage = isRecord(causeRaw) && typeof causeRaw["message"] === "string"
    ? causeRaw["message"]
    : undefined
  const errorMessage = isRecord(errorRaw["error"]) && typeof errorRaw["error"]["message"] === "string"
    ? errorRaw["error"]["message"]
    : undefined
  const nestedMessage = causeMessage ?? errorMessage

  if (nestedMessage && isGenericWrapperMessage(directMessage)) {
    return nestedMessage
  }

  if (directMessage) {
    return directMessage
  }

  return nestedMessage
}
