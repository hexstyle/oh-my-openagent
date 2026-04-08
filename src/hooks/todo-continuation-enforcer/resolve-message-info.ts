import type { ResolveLatestMessageInfoResult, SessionMessage } from "./types"

export function resolveLatestMessageInfo(
  messages: SessionMessage[] | null | undefined
): ResolveLatestMessageInfoResult {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { resolvedInfo: undefined, encounteredCompaction: false }
  }

  let encounteredCompaction = false

  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i].info
    if (info?.agent === "compaction") {
      encounteredCompaction = true
      continue
    }
    if (info?.agent || info?.model || (info?.modelID && info?.providerID)) {
      return {
        resolvedInfo: {
          agent: info.agent,
          model: info.model ?? (info.providerID && info.modelID ? { providerID: info.providerID, modelID: info.modelID } : undefined),
          tools: info.tools,
        },
        encounteredCompaction,
      }
    }
  }

  return { resolvedInfo: undefined, encounteredCompaction }
}
