import type { CouncilMemberResponse, CouncilVerdict } from "./council-contract"

export interface CouncilSynthesisInput {
  responses: CouncilMemberResponse[]
  failedMembers: string[]
  quorumReached: boolean
}

export interface CouncilSynthesisResult {
  majorityVerdict: CouncilVerdict
  consensusLevel: "unanimous" | "strong" | "split" | "fragmented"
  agreementMembers: string[]
  disagreementMembers: string[]
  commonActions: string[]
  contestedRisks: string[]
  unresolvedQuestions: string[]
  gracefulDegradation: boolean
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase()
}

function getMajorityVerdict(responses: CouncilMemberResponse[]): CouncilVerdict {
  const counts = new Map<CouncilVerdict, number>()
  for (const response of responses) {
    counts.set(response.verdict, (counts.get(response.verdict) ?? 0) + 1)
  }

  const orderedVerdicts: CouncilVerdict[] = ["support", "mixed", "oppose", "abstain"]
  let winner: CouncilVerdict = "abstain"
  let winnerCount = -1

  for (const verdict of orderedVerdicts) {
    const count = counts.get(verdict) ?? 0
    if (count > winnerCount) {
      winner = verdict
      winnerCount = count
    }
  }

  return winner
}

function deriveConsensusLevel(agreementCount: number, totalCount: number): CouncilSynthesisResult["consensusLevel"] {
  if (totalCount === 0) {
    return "fragmented"
  }

  if (agreementCount === totalCount) {
    return "unanimous"
  }

  const ratio = agreementCount / totalCount
  if (ratio >= 0.75) {
    return "strong"
  }
  if (ratio >= 0.5) {
    return "split"
  }
  return "fragmented"
}

function collectCommonActions(responses: CouncilMemberResponse[]): string[] {
  const counts = new Map<string, { text: string; count: number }>()
  for (const response of responses) {
    for (const action of response.proposed_actions) {
      const key = normalizeKey(action)
      const existing = counts.get(key)
      if (!existing) {
        counts.set(key, { text: action, count: 1 })
        continue
      }
      existing.count += 1
    }
  }

  const threshold = Math.max(2, Math.ceil(responses.length / 2))
  return [...counts.values()]
    .filter((item) => item.count >= threshold)
    .map((item) => item.text)
}

function collectContestedRisks(responses: CouncilMemberResponse[]): string[] {
  const counts = new Map<string, { text: string; count: number }>()
  for (const response of responses) {
    for (const risk of response.risks) {
      const key = normalizeKey(risk)
      const existing = counts.get(key)
      if (!existing) {
        counts.set(key, { text: risk, count: 1 })
        continue
      }
      existing.count += 1
    }
  }

  return [...counts.values()]
    .filter((item) => item.count === 1)
    .map((item) => item.text)
}

function collectUnresolvedQuestions(responses: CouncilMemberResponse[]): string[] {
  const seen = new Set<string>()
  const questions: string[] = []

  for (const response of responses) {
    for (const question of response.missing_information) {
      const key = normalizeKey(question)
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      questions.push(question)
    }
  }

  return questions
}

export function synthesizeCouncilOutcome(input: CouncilSynthesisInput): CouncilSynthesisResult {
  const majorityVerdict = getMajorityVerdict(input.responses)
  const agreementMembers = input.responses
    .filter((response) => response.verdict === majorityVerdict)
    .map((response) => response.member)
  const disagreementMembers = input.responses
    .filter((response) => response.verdict !== majorityVerdict)
    .map((response) => response.member)
    .concat(input.failedMembers)

  return {
    majorityVerdict,
    consensusLevel: deriveConsensusLevel(agreementMembers.length, input.responses.length),
    agreementMembers,
    disagreementMembers,
    commonActions: collectCommonActions(input.responses),
    contestedRisks: collectContestedRisks(input.responses),
    unresolvedQuestions: collectUnresolvedQuestions(input.responses),
    gracefulDegradation: input.quorumReached && input.failedMembers.length > 0,
  }
}
