const ENCLOSING_QUOTE_PAIRS: Array<[string, string]> = [
  ["\"", "\""],
  ["'", "'"],
  ["`", "`"],
  ["“", "”"],
  ["‘", "’"],
]

const ESCAPED_ENCLOSING_QUOTE_PAIRS: Array<[string, string]> = [
  ["\\\"", "\\\""],
  ["\\'", "\\'"],
  ["\\`", "\\`"],
]

export function stripSingleEnclosingQuotes(value: string): string {
  let trimmed = value.trim()
  let changed = true

  while (changed) {
    changed = false

    for (const [open, close] of [...ENCLOSING_QUOTE_PAIRS, ...ESCAPED_ENCLOSING_QUOTE_PAIRS]) {
      if (trimmed.startsWith(open) && trimmed.endsWith(close) && trimmed.length >= open.length + close.length) {
        trimmed = trimmed.slice(open.length, trimmed.length - close.length).trim()
        changed = true
        break
      }
    }
  }

  return trimmed
}
