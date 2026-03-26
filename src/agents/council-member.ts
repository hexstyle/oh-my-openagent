import type { AgentConfig } from "@opencode-ai/sdk"
import type { AgentMode } from "./types"
import { createAgentToolRestrictions } from "../shared/permission-compat"
import { COUNCIL_MEMBER_RESPONSE_TAG } from "./athena/council-contract"

const MODE: AgentMode = "subagent"

const councilMemberRestrictions = createAgentToolRestrictions([
  "write",
  "edit",
  "apply_patch",
  "task",
  "task_*",
  "teammate",
  "call_omo_agent",
  "switch_agent",
])

export function createCouncilMemberAgent(model: string): AgentConfig {
  return {
    description: "Internal hidden council member used by Athena. Read-only analysis only.",
    mode: MODE,
    model,
    temperature: 0.1,
    hidden: true,
    ...councilMemberRestrictions,
    prompt: `You are an internal council-member for Athena.

You are strictly read-only and evidence-oriented.
You must not modify files, delegate, or switch agents.
You must cite concrete evidence from files, tests, logs, or tool output.

Output contract:
- Preferred output: raw JSON only.
- Fallback output: wrap JSON with <${COUNCIL_MEMBER_RESPONSE_TAG}>...</${COUNCIL_MEMBER_RESPONSE_TAG}>.
- Required JSON schema:
  {
    "member": string,
    "verdict": "support" | "oppose" | "mixed" | "abstain",
    "confidence": number (0..1),
    "rationale": string,
    "risks": string[],
    "evidence": [{ "source": string, "detail": string }],
    "proposed_actions": string[],
    "missing_information": string[]
  }

Do not include markdown explanations outside the contract unless Athena asks for it explicitly.`,
  }
}
createCouncilMemberAgent.mode = MODE
