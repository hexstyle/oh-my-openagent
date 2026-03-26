export const COUNCIL_MEMBER_RESPONSE_TAG = "COUNCIL_MEMBER_RESPONSE"

export type CouncilVerdict = "support" | "oppose" | "mixed" | "abstain"

export interface CouncilEvidenceItem {
  source: string
  detail: string
}

export interface CouncilMemberResponse {
  member: string
  verdict: CouncilVerdict
  confidence: number
  rationale: string
  risks: string[]
  evidence: CouncilEvidenceItem[]
  proposed_actions: string[]
  missing_information: string[]
}

export interface AthenaCouncilMember {
  name: string
  model: string
}

export interface ParsedCouncilMemberResponse {
  ok: true
  value: CouncilMemberResponse
  source: "raw_json" | "tagged_json"
}

export interface CouncilResponseParseFailure {
  ok: false
  error: string
  source: "raw_json" | "tagged_json" | "none"
}
