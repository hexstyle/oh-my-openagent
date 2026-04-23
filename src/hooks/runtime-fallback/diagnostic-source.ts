const MAX_SEGMENTS = 12
const REPEATING_PROMOTION_PAIR = ["timeout", "prometheus-plan-promotion"] as const

export function compactDiagnosticSource(source: string): string {
  const rawSegments = source
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)

  if (rawSegments.length === 0) {
    return "session.timeout"
  }

  const compacted: string[] = []
  for (const segment of rawSegments) {
    const lastSegment = compacted[compacted.length - 1]
    if (lastSegment === segment) {
      continue
    }

    const trailingPromotionPair =
      compacted[compacted.length - 2] === REPEATING_PROMOTION_PAIR[0]
      && compacted[compacted.length - 1] === REPEATING_PROMOTION_PAIR[1]

    if (segment === REPEATING_PROMOTION_PAIR[0] && trailingPromotionPair) {
      continue
    }

    compacted.push(segment)
  }

  if (compacted.length <= MAX_SEGMENTS) {
    return compacted.join(".")
  }

  const head = compacted.slice(0, 4)
  const tail = compacted.slice(-(MAX_SEGMENTS - head.length - 1))
  return [...head, "...", ...tail].join(".")
}

export function appendDiagnosticSourceSegment(source: string, segment: string): string {
  return compactDiagnosticSource(`${source}.${segment}`)
}
