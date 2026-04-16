export function resolveParentAgent(input: {
  sessionAgent?: string | null
  toolAgent?: string | null
  firstMessageAgent?: string | null
  previousMessageAgent?: string | null
}): string | undefined {
  return (
    input.sessionAgent
    ?? input.toolAgent
    ?? input.firstMessageAgent
    ?? input.previousMessageAgent
    ?? undefined
  )
}
