export const OMO_INTERNAL_INITIATOR_MARKER = "<!-- OMO_INTERNAL_INITIATOR -->"

export function createInternalAgentTextPart(text: string): {
  type: "text"
  text: string
} {
  return {
    type: "text",
    text: `${text}\n${OMO_INTERNAL_INITIATOR_MARKER}`,
  }
}

export function hasInternalInitiatorMarker(
  parts: Array<{ type?: string; text?: string }> | undefined,
): boolean {
  return (parts ?? []).some(
    (part) => part.type === "text"
      && typeof part.text === "string"
      && part.text.includes(OMO_INTERNAL_INITIATOR_MARKER),
  )
}
