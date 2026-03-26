import {
  COUNCIL_MEMBER_RESPONSE_TAG,
  type CouncilMemberResponse,
  type CouncilResponseParseFailure,
  type ParsedCouncilMemberResponse,
} from "./council-contract"

type ParseResult = ParsedCouncilMemberResponse | CouncilResponseParseFailure

function normalizeJsonPayload(input: string): string {
  const trimmed = input.trim()
  if (!trimmed.startsWith("```") || !trimmed.endsWith("```")) {
    return trimmed
  }

  const firstNewLine = trimmed.indexOf("\n")
  if (firstNewLine < 0) {
    return trimmed
  }

  return trimmed.slice(firstNewLine + 1, -3).trim()
}

function tryParseJsonObject(input: string): unknown {
  const normalized = normalizeJsonPayload(input)
  if (!normalized.startsWith("{")) {
    return null
  }

  try {
    return JSON.parse(normalized)
  } catch {
    return null
  }
}

function extractTaggedPayload(raw: string): string | null {
  const xmlLike = new RegExp(
    `<${COUNCIL_MEMBER_RESPONSE_TAG}>([\\s\\S]*?)<\\/${COUNCIL_MEMBER_RESPONSE_TAG}>`,
    "i",
  )
  const xmlMatch = raw.match(xmlLike)
  if (xmlMatch?.[1]) {
    return xmlMatch[1].trim()
  }

  const prefixed = new RegExp(`${COUNCIL_MEMBER_RESPONSE_TAG}\\s*:\\s*`, "i")
  const prefixMatch = raw.match(prefixed)
  if (!prefixMatch) {
    return null
  }

  const matchIndex = prefixMatch.index
  if (matchIndex === undefined) {
    return null
  }

  const rest = raw.slice(matchIndex + prefixMatch[0].length)
  const firstBrace = rest.indexOf("{")
  if (firstBrace < 0) {
    return null
  }

  return rest.slice(firstBrace).trim()
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isEvidenceArray(value: unknown): value is CouncilMemberResponse["evidence"] {
  return Array.isArray(value)
    && value.every(
      (item) =>
        typeof item === "object"
        && item !== null
        && typeof (item as { source?: unknown }).source === "string"
        && typeof (item as { detail?: unknown }).detail === "string",
    )
}

function validateCouncilMemberResponse(payload: unknown): CouncilMemberResponse | null {
  if (typeof payload !== "object" || payload === null) {
    return null
  }

  const candidate = payload as Record<string, unknown>
  const verdict = candidate.verdict
  const confidence = candidate.confidence

  if (
    typeof candidate.member !== "string"
    || (verdict !== "support" && verdict !== "oppose" && verdict !== "mixed" && verdict !== "abstain")
    || typeof confidence !== "number"
    || confidence < 0
    || confidence > 1
    || typeof candidate.rationale !== "string"
    || !isStringArray(candidate.risks)
    || !isEvidenceArray(candidate.evidence)
    || !isStringArray(candidate.proposed_actions)
    || !isStringArray(candidate.missing_information)
  ) {
    return null
  }

  return {
    member: candidate.member,
    verdict,
    confidence,
    rationale: candidate.rationale,
    risks: candidate.risks,
    evidence: candidate.evidence,
    proposed_actions: candidate.proposed_actions,
    missing_information: candidate.missing_information,
  }
}

function parseValidated(payload: unknown, source: ParsedCouncilMemberResponse["source"]): ParseResult {
  const validated = validateCouncilMemberResponse(payload)
  if (!validated) {
    return {
      ok: false,
      error: "Council member response does not match required contract",
      source,
    }
  }

  return {
    ok: true,
    value: validated,
    source,
  }
}

export function parseCouncilMemberResponse(raw: string): ParseResult {
  const directJson = tryParseJsonObject(raw)
  if (directJson) {
    return parseValidated(directJson, "raw_json")
  }

  const taggedPayload = extractTaggedPayload(raw)
  if (taggedPayload) {
    const taggedJson = tryParseJsonObject(taggedPayload)
    if (taggedJson) {
      return parseValidated(taggedJson, "tagged_json")
    }
    return {
      ok: false,
      error: "Tagged council response found, but JSON payload is invalid",
      source: "tagged_json",
    }
  }

  return {
    ok: false,
    error: "No parseable council response payload found",
    source: "none",
  }
}
