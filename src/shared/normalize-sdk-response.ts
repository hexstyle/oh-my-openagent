export interface NormalizeSDKResponseOptions {
  preferResponseOnMissingData?: boolean
}

export function normalizeSDKResponse<TData>(
  response: unknown,
  fallback: TData,
  options?: NormalizeSDKResponseOptions,
): TData {
  const expectsArray = Array.isArray(fallback)

  if (response === null || response === undefined) {
    return fallback
  }

  if (Array.isArray(response)) {
    return response as TData
  }

  if (typeof response === "object" && "data" in response) {
    const data = (response as { data?: unknown }).data
    if (data !== null && data !== undefined) {
      if (expectsArray && !Array.isArray(data)) {
        return fallback
      }
      return data as TData
    }

    if (options?.preferResponseOnMissingData === true) {
      if (expectsArray) {
        return fallback
      }
      return response as TData
    }

    return fallback
  }

  if (options?.preferResponseOnMissingData === true) {
    if (expectsArray) {
      return fallback
    }
    return response as TData
  }

  return fallback
}
