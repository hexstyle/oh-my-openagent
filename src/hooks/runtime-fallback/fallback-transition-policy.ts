import { normalizeAgentName } from "./agent-resolver"
import { getRuntimeFallbackTier } from "./fallback-policy"

export type RuntimeFallbackTransitionMode = "same_session" | "scoped_handoff"

const SAME_SESSION_NARROW_AGENTS = new Set([
  "explore",
])

export function getRuntimeFallbackTransitionMode(args: {
  resolvedAgent?: string
  currentModel: string
  newModel: string
  isScopedFallbackChild?: boolean
}): RuntimeFallbackTransitionMode {
  // Never nest scoped handoffs — if this session is already a scoped fallback
  // child, keep all further fallbacks in the same session to prevent cascade.
  if (args.isScopedFallbackChild) {
    return "same_session"
  }

  const normalizedAgent = normalizeAgentName(args.resolvedAgent)
  if (normalizedAgent && SAME_SESSION_NARROW_AGENTS.has(normalizedAgent)) {
    return "same_session"
  }

  const currentTier = getRuntimeFallbackTier(args.currentModel)
  const nextTier = getRuntimeFallbackTier(args.newModel)
  if (currentTier === "paid" && nextTier !== "paid") {
    return "scoped_handoff"
  }

  return "same_session"
}
