import { stripSingleEnclosingQuotes } from "../../shared/strip-enclosing-quotes"

const KEYWORD_PATTERN = /\b(ultrawork|ulw)\b/gi
const WORKTREE_FLAG_PATTERN = /--worktree(?:\s+(\S+))?/

export interface ParsedUserRequest {
  planName: string | null
  explicitWorktreePath: string | null
}

function extractRawStartWorkArguments(promptText: string): string | null {
  const trimmed = stripSingleEnclosingQuotes(promptText)
  const match = trimmed.match(/^\/start-work(?:\s+([\s\S]*))?$/i)
  if (!match) return null
  return (match[1] ?? "").trim()
}

export function parseUserRequest(promptText: string): ParsedUserRequest {
  const tagMatch = promptText.match(/<user-request>\s*([\s\S]*?)\s*<\/user-request>/i)
  const rawStartWorkArguments = tagMatch ? null : extractRawStartWorkArguments(promptText)
  if (!tagMatch && rawStartWorkArguments === null) {
    return { planName: null, explicitWorktreePath: null }
  }

  let rawArg = (tagMatch ? tagMatch[1] : rawStartWorkArguments)?.trim() ?? ""
  if (!rawArg) return { planName: null, explicitWorktreePath: null }

  const worktreeMatch = rawArg.match(WORKTREE_FLAG_PATTERN)
  const explicitWorktreePath = worktreeMatch ? (worktreeMatch[1] ?? null) : null

  if (worktreeMatch) {
    rawArg = rawArg.replace(worktreeMatch[0], "").trim()
  }

  const cleanedArg = rawArg.replace(KEYWORD_PATTERN, "").trim()

  return {
    planName: cleanedArg || null,
    explicitWorktreePath,
  }
}
