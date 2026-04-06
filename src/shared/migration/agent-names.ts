export const AGENT_NAME_MAP: Record<string, string> = {
  // Sisyphus variants → "sisyphus"
  omo: "sisyphus",
  OmO: "sisyphus",
  Sisyphus: "sisyphus",
  "Sisyphus (Ultraworker)": "sisyphus",
  sisyphus: "sisyphus",

  // Prometheus variants → "prometheus"
  "OmO-Plan": "prometheus",
  "omo-plan": "prometheus",
  "Planner-Sisyphus": "prometheus",
  "planner-sisyphus": "prometheus",
  "Prometheus (Planner)": "prometheus",
  "Prometheus (Plan Builder)": "prometheus",
  prometheus: "prometheus",

  // Atlas variants → "atlas"
  "orchestrator-sisyphus": "atlas",
  Atlas: "atlas",
  "Atlas (Plan Executor)": "atlas",
  atlas: "atlas",

  // Metis variants → "metis"
  "plan-consultant": "metis",
  "Metis (Plan Consultant)": "metis",
  metis: "metis",

  // Momus variants → "momus"
  "Momus (Plan Reviewer)": "momus",
  "Momus (Plan Critic)": "momus",
  momus: "momus",

  // Sisyphus-Junior → "sisyphus-junior"
  "Sisyphus-Junior": "sisyphus-junior",
  "Sisyphus Junior": "sisyphus-junior",
  "Sisyphus Junior (Focused Executor)": "sisyphus-junior",
  "sisyphus-junior": "sisyphus-junior",

  // Hephaestus variants → "hephaestus"
  Hephaestus: "hephaestus",
  "Hephaestus (Deep Agent)": "hephaestus",
  hephaestus: "hephaestus",

  // Oracle variants → "oracle"
  Oracle: "oracle",
  "Oracle (Strategic Advisor)": "oracle",
  oracle: "oracle",

  // Librarian variants → "librarian"
  Librarian: "librarian",
  "Librarian (OSS Research)": "librarian",
  librarian: "librarian",

  // Explore variants → "explore"
  Explore: "explore",
  "Explore (Code Search)": "explore",
  explore: "explore",

  // Multimodal Looker variants → "multimodal-looker"
  "Multimodal Looker": "multimodal-looker",
  "Multimodal Looker (Document Vision)": "multimodal-looker",
  "multimodal-looker": "multimodal-looker",

  // Already lowercase - passthrough
  build: "build",
}

export const BUILTIN_AGENT_NAMES = new Set([
  "sisyphus", // was "Sisyphus"
  "hephaestus",
  "oracle",
  "librarian",
  "explore",
  "multimodal-looker",
  "metis", // was "Metis (Plan Consultant)"
  "momus", // was "Momus (Plan Reviewer)"
  "prometheus", // was "Prometheus (Planner)"
  "atlas", // was "Atlas"
  "build",
])

export function migrateAgentNames(
  agents: Record<string, unknown>
): { migrated: Record<string, unknown>; changed: boolean } {
  const migrated: Record<string, unknown> = {}
  let changed = false

  for (const [key, value] of Object.entries(agents)) {
    const newKey = AGENT_NAME_MAP[key.toLowerCase()] ?? AGENT_NAME_MAP[key] ?? key
    if (newKey !== key) {
      changed = true
    }
    migrated[newKey] = value
  }

  return { migrated, changed }
}
