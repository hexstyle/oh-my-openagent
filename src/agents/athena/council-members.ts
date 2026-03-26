import type { AthenaCouncilMember } from "./council-contract"

function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function toCouncilMemberAgentName(memberName: string): string {
  const slug = slugify(memberName)
  return `council-member-${slug || "member"}`
}

export function buildCouncilRosterSection(members: AthenaCouncilMember[]): string {
  if (members.length === 0) {
    return "- No configured council roster. Use default subagent_type=\"council-member\"."
  }

  return members
    .map((member) => `- ${member.name} | model=${member.model} | subagent_type=${toCouncilMemberAgentName(member.name)}`)
    .join("\n")
}
