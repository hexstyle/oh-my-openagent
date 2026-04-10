import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"

type DeltaCategoryName =
  | "config_only_deltas"
  | "plugin_code_deltas"
  | "intended_extension_points"
  | "suspicious_runtime_drift"

interface DeltaEntry {
  id: string
  summary: string
  evidence?: Record<string, unknown>
}

interface DeltaFixture {
  audit_scope: string
  categories: Record<DeltaCategoryName, DeltaEntry[]>
}

const fixturePath = new URL("../../../../test/fixtures/local-config-delta/current-local-delta.json", import.meta.url)
const reportPath = new URL("../../../../docs/fork/local-vs-upstream-delta.md", import.meta.url)

const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as DeltaFixture
const report = readFileSync(reportPath, "utf-8")

const REQUIRED_CATEGORY_IDS: Record<Exclude<DeltaCategoryName, "suspicious_runtime_drift">, string[]> = {
  config_only_deltas: [
    "managed-local-config-assets",
    "role-specific-model-policy",
    "single-runtime-fallback-policy",
  ],
  plugin_code_deltas: [
    "local-install-and-live-verification",
    "codex-auth-bridge",
    "canonical-agent-display-names",
    "in-process-runtime-fallback",
  ],
  intended_extension_points: [
    "schema-supported-agent-and-runtime-overrides",
    "config-merge-semantics",
    "explicit-plugin-array-registration",
    "legacy-alias-basename-compatibility",
  ],
}

const REQUIRED_REPORT_SNIPPETS = [
  "## Supported delta",
  "## Managed config and install",
  "## Runtime behavior retained",
  "## Deliberately removed baggage",
  "## Intended extension points",
  "`file://<repo-root>`",
  "`opencode.json`",
  "`oh-my-openagent.json`",
  "`anthropic/claude-opus-4-6`",
  "`openai/gpt-5.4`",
  "`openai/gpt-5.3-codex-spark`",
  "There is no second synced JS plugin layer",
  "No currently-accepted suspicious runtime drift remains in the supported fork contract.",
]

function getCategoryEntries(categoryName: DeltaCategoryName): DeltaEntry[] {
  const entries = fixture.categories[categoryName]

  if (!Array.isArray(entries)) {
    throw new Error(`Delta fixture is missing the '${categoryName}' category.`)
  }

  return entries
}

function getEntry(categoryName: Exclude<DeltaCategoryName, "suspicious_runtime_drift">, entryId: string): DeltaEntry {
  const entry = getCategoryEntries(categoryName).find((item) => item.id === entryId)

  if (!entry) {
    throw new Error(`Delta fixture category '${categoryName}' is missing required entry '${entryId}'.`)
  }

  return entry
}

describe("local delta fixture regression", () => {
  it("keeps the fixture category contract intact", () => {
    expect(fixture.audit_scope).toBe("minimum-supported-delta")

    for (const [categoryName, requiredIds] of Object.entries(REQUIRED_CATEGORY_IDS) as Array<
      [Exclude<DeltaCategoryName, "suspicious_runtime_drift">, string[]]
    >) {
      const categoryEntries = getCategoryEntries(categoryName)
      const ids = new Set(categoryEntries.map((entry) => entry.id))
      const missingIds = requiredIds.filter((id) => !ids.has(id))

      if (missingIds.length > 0) {
        throw new Error(
          `Delta fixture category '${categoryName}' is missing required ids: ${missingIds.join(", ")}.`
        )
      }
    }

    expect(getCategoryEntries("suspicious_runtime_drift")).toEqual([])
  })

  it("captures the reduced fork surface in machine-readable form", () => {
    const managedConfigEntry = getEntry("config_only_deltas", "managed-local-config-assets")
    expect(managedConfigEntry.evidence?.files).toEqual([
      "assets/custom-opencode/opencode.json",
      "assets/custom-opencode/oh-my-opencode.json",
    ])
    expect(managedConfigEntry.evidence?.live_alias).toBe("oh-my-openagent.json")
    expect(managedConfigEntry.evidence?.default_agent).toBe("Prometheus (Plan Builder)")
    expect(managedConfigEntry.evidence?.instructions).toEqual([
      "./node_modules/oh-my-openagent/assets/custom-opencode/instructions/non-interactive-shell.md",
    ])
    expect(managedConfigEntry.evidence?.plugin_entries).toEqual([
      "oh-my-openagent",
      "opencode-claude-auth",
      "opencode-helicone-session",
      "@nick-vi/opencode-type-inject",
    ])

    const modelPolicyEntry = getEntry("config_only_deltas", "role-specific-model-policy")
    expect(modelPolicyEntry.evidence?.opus_first_agents).toEqual([
      "sisyphus",
      "prometheus",
      "oracle",
      "metis",
      "momus",
    ])
    expect(modelPolicyEntry.evidence?.gpt54_agents).toEqual([
      "hephaestus",
      "atlas",
      "librarian",
      "multimodal-looker",
      "sisyphus-junior",
    ])
    expect(modelPolicyEntry.evidence?.spark_agents).toEqual([
      "explore",
    ])
    expect(modelPolicyEntry.evidence?.context_limit).toBe(200000)

    const fallbackPolicyEntry = getEntry("config_only_deltas", "single-runtime-fallback-policy")
    expect(fallbackPolicyEntry.evidence?.enabled).toBe(true)
    expect(fallbackPolicyEntry.evidence?.max_fallback_attempts).toBe(12)
    expect(fallbackPolicyEntry.evidence?.max_full_chain_cycles).toBe(5)
    expect(fallbackPolicyEntry.evidence?.timeout_seconds).toBe(45)
    expect(fallbackPolicyEntry.evidence?.transient_retry_window_seconds).toBe(14400)
    expect(fallbackPolicyEntry.evidence?.transient_retry_initial_delay_seconds).toBe(30)
    expect(fallbackPolicyEntry.evidence?.transient_retry_max_delay_seconds).toBe(300)
  })

  it("records the live fork-specific runtime code paths", () => {
    const installEntry = getEntry("plugin_code_deltas", "local-install-and-live-verification")
    expect(installEntry.evidence?.synced_targets).toEqual([
      "opencode.json",
      "oh-my-openagent.json",
    ])
    expect(installEntry.evidence?.plugin_pin).toBe("file://<repo-root>")

    const authBridgeEntry = getEntry("plugin_code_deltas", "codex-auth-bridge")
    expect(authBridgeEntry.evidence?.source).toBe("~/.codex/auth.json")
    expect(authBridgeEntry.evidence?.target).toBe("~/.local/share/opencode/auth.json")

    const canonicalNamesEntry = getEntry("plugin_code_deltas", "canonical-agent-display-names")
    expect(canonicalNamesEntry.evidence?.name_format).toBe("Agent (Role)")
    expect(canonicalNamesEntry.evidence?.special_case_runtime_key).toBe("explore")
    expect(canonicalNamesEntry.evidence?.special_case_display_name).toBe("Explore (Code Search)")

    const runtimeFallbackEntry = getEntry("plugin_code_deltas", "in-process-runtime-fallback")
    expect(runtimeFallbackEntry.evidence?.no_external_managed_plugin_assets).toBe(true)
  })

  it("keeps the markdown review aligned with the reduced delta contract", () => {
    for (const snippet of REQUIRED_REPORT_SNIPPETS) {
      if (!report.includes(snippet)) {
        throw new Error(`Delta review is missing required text: ${snippet}`)
      }
    }
  })
})
