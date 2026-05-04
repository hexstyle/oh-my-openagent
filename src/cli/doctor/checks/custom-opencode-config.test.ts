import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { collectFallbackPolicyViolations } from "../../../custom-opencode/model-config-validation"
import {
  MANAGED_HOST_INSTRUCTION_ENTRIES,
  MANAGED_HOST_PLUGIN_ENTRIES,
} from "../../../shared/managed-opencode-runtime"

const hostConfigPath = new URL("../../../../assets/custom-opencode/opencode.json", import.meta.url)
const pluginConfigPath = new URL("../../../../assets/custom-opencode/oh-my-opencode.json", import.meta.url)

const EXECUTION_PROMPT_APPEND = "Check AGENTS.md on first repo interaction; create/update if missing or stale. /start-work, Prometheus handoff, or active boulder = permission to execute. Drive the plan to completion — delegate, verify, iterate. Do not stop at summaries or partial progress. Return control only for destructive actions, missing info, or hard blockers (network/DNS failure = hard blocker — commit locally and stop, don't loop). Short timeouts by default; diagnose before retrying slow commands. CI RULES: Never escalate failures as 'data-dependent' or 'unfixable'. failed==0 is the only DoD — create missing data in TestInitialize, mock deps, adjust CI params. Test execution target: ≤15min, hard limit 20min. COMPREHENSIVE FIX: Every fix session must fix ALL known failures, not just a subset. Read ALL evidence, fix ALL files, push ONCE. If you see a fixable test — fix it, regardless of task boundaries. NO PARTIAL PUSHES: do not push while any current failing test lacks a current-iteration tracker update, concrete fix path or blocker conclusion, staged-diff coverage or explicit no-code-change rationale, and local verification coverage or explicit repo-native verification blocker. CI EVIDENCE ORDER: For `.sisyphus` CI repos, read only AGENTS.md, `.sisyphus/boulder.json`, the active plan, `ci-loop-checkpoint.md`, `repair-log.md`, the latest build analysis, and `.sisyphus/evidence/tests/`. Check tracker-dir existence only with `test -d` or `ls`; never use a file-read tool on the directory path. PER-TEST LEDGER HARD GATE: re-fetch the live failing test list every iteration and reconcile it one-by-one against tracker files before editing code. If the tracker directory is absent, if any current failing test lacks a tracker, or if canonical per-test tracker count/status/error text for the CURRENT live failing set disagrees with CI, STOP and rebuild the canonical tracker set before code edits. Legacy alias/build-summary tracker notes are supplemental context only: keep them if useful, but they must not block the first evidence write batch or inflate the failing tracker count. Never probe legacy alias paths like `.sisyphus/ci-loop-checkpoint.md` or `.sisyphus/repair-log.md`; read only the canonical `.sisyphus/evidence/*` files. If the current-build evidence already agrees on build/revision/failing-set scope, do NOT spend the startup turn on another Bamboo truth fetch; use the current evidence as startup truth, validate the dirty batch, and fetch Bamboo again only if the evidence proves stale or after a push/build-monitoring transition. EVIDENCE MATERIALIZATION GATE: after the live failing list is fetched, immediately write/update tracker files, `repair-log.md`, and `ci-loop-checkpoint.md` for the current build before any source-code reads outside `.sisyphus/evidence/`. EVIDENCE EXIT GATE: once live CI list, trackers, current-build analysis, checkpoint, and repair-log agree, do one compact evidence update and move directly into the constrained source pass. Do NOT waste a cycle on repeated `wc`, repeated clean-tree checks, or another evidence-only loop before the first edit batch. ACTIVE PLAN REBASE GATE: if the active plan still names an older build, revision, failing-test count, or superseded Task 2 scope, rewrite the active plan on disk immediately after evidence materialization and before any source-code reads outside `.sisyphus/evidence/`. SINGLE-FILE FIX RULE: one shared helper/file may cover multiple failing tests only if every affected test tracker explicitly maps that test to that shared file/helper and records the attempted approach, result, and conclusion for the current iteration. Do not glob notepads or `run-continuation` unless the core evidence is insufficient. HYPOTHESIS GATE: If the plan, checkpoint, and repair-log disagree on root cause, reconcile the conflicting hypotheses in evidence before editing code. TRIGGER-ONLY BUILDS: Distinguish empty/retrigger commits from code-changing revisions in `repair-log.md` and `ci-loop-checkpoint.md`; do not treat a retrigger revision as a code fix. LOCAL VERIFY MANDATE: Before pushing Playwright test fixes, run `dotnet test --filter` for ALL affected tests locally. Push ONLY after local pass. MANDATORY CLAUDE REVIEW: After local verify passes and before commit/push, run `review-work` or an Oracle review, record `Claude review: PASS` in evidence, and push ONLY after that review passes. PRE-PUSH GATE: Before commit/push, restate and satisfy the repair-log checklist: `dotnet build`, local targeted test filter, mandatory Claude review, staged-tree/symbol completeness, and one-to-one failing-test coverage for the current build. Evidence hygiene: delete any .sisyphus/evidence/ file >10KB and any raw JSON/log/TRX before each iteration. Total evidence <500KB."
const PROMETHEUS_PROMPT_APPEND = "Check AGENTS.md on first repo interaction; create/update if missing or stale. You are the planning front door. Stay in planning mode, resolve scope/tradeoffs, produce a concrete plan + /start-work guidance. Do not execute yourself. Short timeouts by default; diagnose before retrying slow commands. CI PLANS: Load ci-green-loop skill FIRST. Plans MUST have EXACTLY 2 tasks: Task 1 = Diagnosis (fetch ALL build data, classify ALL failures), Task 2 = Fix ALL (one comprehensive task fixing EVERY failure across ALL files, ending with build+commit+push). NEVER split fixes into multiple tasks — each task = ~2 min dispatch overhead + risk of parallel file conflicts. 100% failure coverage mandatory. failed==0 is the only DoD. No escalation as 'data-dependent' or 'unfixable'. Test target: ≤15min. CI PLAN INPUT ORDER: For `.sisyphus` repos, diagnosis reads only AGENTS.md, `.sisyphus/boulder.json`, the active plan, `ci-loop-checkpoint.md`, `repair-log.md`, the latest build analysis, and `.sisyphus/evidence/tests/` before any historical notepads or `run-continuation`. Check tracker-dir existence only with `test -d` or `ls`; never use a file-read tool on the directory path. PER-TEST PLANNING HARD GATE: planner must require one tracker per current failing test and explicit per-test history/conclusion refresh on every iteration before any code-edit task may start. If trackers are missing or incomplete, Task 1 must recreate/reconcile them instead of allowing fast-path execution. EVIDENCE MATERIALIZATION GATE: planner must explicitly tell the executor to write/update tracker files, `repair-log.md`, and `ci-loop-checkpoint.md` immediately after live CI fetch and before any source-code reads outside `.sisyphus/evidence/`. ACTIVE PLAN REBASE GATE: if the current active plan still names an older build, revision, failing-test count, or superseded Task 2 scope, the planner/executor must rewrite the active plan on disk before any source-code reads outside `.sisyphus/evidence/`. Every CI plan must explicitly reconcile conflicting root-cause hypotheses from plan/checkpoint/repair-log before code edits, must distinguish trigger-only builds from code-changing revisions, and must restate the pre-push verification checklist (`dotnet build`, local targeted test filter, mandatory Claude review, staged-tree/symbol completeness). Planner must require a mandatory pre-push Claude review (`review-work` or Oracle fallback) that records `Claude review: PASS` in evidence before any commit/push step. SINGLE-FILE FIX RULE: if a future edit batch intends to touch one shared file/helper for multiple failing tests, the plan must explicitly say that every affected test tracker maps to that shared file/helper. WRITE TOOL LIMIT: Files >30 lines MUST use bash heredoc (`cat > file << 'EOF'`), split chunks <30 lines. Write tool silently fails on large content. ANTI-PLAN-CHURN: Before generating a new CI plan, check .sisyphus/plans/ for existing plans <24h old covering current failures. If one covers >=80% with no new failure types, instruct executor to continue it. 3+ regenerations without a push = stop and execute."
const hostConfig = JSON.parse(readFileSync(hostConfigPath, "utf-8")) as {
  $schema?: string
  default_agent?: string
  instructions?: string[]
  plugin?: string[]
  provider?: Record<string, { models?: Record<string, { limit?: { context?: number } }> }>
  lsp?: Record<string, { command?: string[]; extensions?: string[] }>
}

const pluginConfigContents = readFileSync(pluginConfigPath, "utf-8")
const pluginConfig = JSON.parse(pluginConfigContents) as {
  $schema?: string
  disabled_mcps?: string[]
  agents?: Record<string, Record<string, unknown>>
  categories?: Record<string, Record<string, unknown>>
  fallback_models?: FallbackModelEntry[]
  runtime_fallback?: {
    enabled?: boolean
    max_fallback_attempts?: number
    max_full_chain_cycles?: number
    transient_retry_window_seconds?: number
    transient_retry_initial_delay_seconds?: number
    transient_retry_max_delay_seconds?: number
    manual_provider_clearance_enabled?: boolean
    manual_provider_clearance_pause_window_seconds?: number
    manual_provider_clearance_notify_on_pause?: boolean
  }
  background_task?: {
    staleTimeoutMs?: number
  }
  hashline_edit?: boolean
  sisyphus?: {
    tasks?: Record<string, unknown>
  }
  babysitting?: {
    timeout_ms?: number
  }
  model_capabilities?: {
    refresh_timeout_ms?: number
  }
  experimental?: {
    auto_resume?: boolean
    preemptive_compaction?: boolean
    preemptive_compaction_input_tokens?: number
  }
  notification?: {
    force_enable?: boolean
  }
}

describe("managed custom OpenCode config assets", () => {
  it("keeps explicit package-plugin registration in the host config", () => {
    expect(hostConfig.default_agent).toBe("Prometheus (Plan Builder)")
    expect(hostConfig.instructions).toEqual([...MANAGED_HOST_INSTRUCTION_ENTRIES])
    expect(hostConfig.plugin).toEqual([...MANAGED_HOST_PLUGIN_ENTRIES])
  })

  it("pins managed provider context limits to validated runtime-safe values", () => {
    expect(hostConfig.provider?.openai?.models?.["gpt-5.4"]?.limit?.context).toBe(200000)
    expect(hostConfig.provider?.openai?.models?.["gpt-5.3-codex"]).toBeUndefined()
    expect(hostConfig.provider?.openai?.models?.["gpt-5.3-codex-spark"]?.limit?.context).toBe(128000)
    expect(hostConfig.provider?.anthropic?.models?.["claude-opus-4-6"]?.limit?.context).toBe(200000)
    expect(hostConfig.provider?.anthropic?.models?.["claude-sonnet-4-6"]?.limit?.context).toBe(200000)
  })

  it("pins managed TypeScript and C# LSP entries in the host config", () => {
    expect(hostConfig.lsp?.typescript).toEqual({
      command: ["typescript-language-server", "--stdio"],
      extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"],
    })
    expect(hostConfig.lsp?.csharp).toEqual({
      command: ["csharp-ls"],
      extensions: [".cs"],
    })
  })

  it("pins role-appropriate execution lanes and preserves cross-provider fallbacks", () => {
    const prometheus = pluginConfig.agents?.prometheus
    expect(prometheus?.model).toBe("anthropic/claude-opus-4-7")
    expect(prometheus?.variant).toBe("max")
    expect(prometheus?.textVerbosity).toBe("high")

    // Controller/review agents use Opus
    for (const reviewAgentName of ["momus", "metis"] as const) {
      const reviewAgent = pluginConfig.agents?.[reviewAgentName]
      expect(reviewAgent?.model).toBe("anthropic/claude-opus-4-7")
    }

    // Managed policy is Claude-first for every non-explore agent.
    for (const executorName of ["sisyphus", "atlas", "hephaestus", "librarian", "multimodal-looker", "sisyphus-junior"] as const) {
      expect(pluginConfig.agents?.[executorName]?.model).toBe("anthropic/claude-sonnet-4-6")
    }

    // Oracle remains Claude-primary.
    expect(pluginConfig.agents?.oracle?.model).toBe("anthropic/claude-sonnet-4-6")

    // Explore is the only spark-primary speed lane.
    expect(pluginConfig.agents?.explore?.model).toBe("openai/gpt-5.3-codex-spark")
    expect(pluginConfig.agents?.["sisyphus-junior"]?.variant).toBe("medium")
    expect(pluginConfig.agents?.["sisyphus-junior"]?.fallback_models).toEqual([
      "anthropic/claude-opus-4-7",
      "openai/gpt-5.4",
      "openai/gpt-5.3-codex-spark",
      "opencode/nemotron-3-super-free",
      "opencode/minimax-m2.5-free",
      "opencode/big-pickle",
    ])

    // CROSS-PROVIDER INVARIANT: Every agent chain must have both Claude AND OpenAI models.
    // This ensures provider-level redundancy — if one provider is down, the other takes over.
    // The primary model can vary by role, but every chain must retain both providers.
    for (const [agentName, agentConfig] of Object.entries(pluginConfig.agents ?? {})) {
      const fallback = agentConfig?.fallback_models as unknown[]
      if (!fallback || fallback.length === 0) continue
      const flat = fallback.map((m: any) => typeof m === "string" ? m : m.model) as string[]
      const hasOpenAI = flat.some((m: string) => m.startsWith("openai/"))
      const hasAnthropic = (agentConfig?.model as string)?.startsWith("anthropic/") ||
        flat.some((m: string) => m.startsWith("anthropic/"))
      expect(hasOpenAI).toBe(true)
      expect(hasAnthropic).toBe(true)
    }

    for (const categoryName of ["deep", "quick", "unspecified-low", "unspecified-high", "writing", "artistry", "visual-engineering"] as const) {
      expect(pluginConfig.categories?.[categoryName]?.model).toBe("anthropic/claude-sonnet-4-6")
    }
    expect(pluginConfig.default_run_agent).toBe("Prometheus (Plan Builder)")
  })

  it("keeps free fallbacks behind paid OpenAI and Claude models in every managed chain", () => {
    const violations = collectFallbackPolicyViolations(pluginConfig as any)
    expect(violations).toEqual([])
  })

  it("preserves the audited prompt_append text only for the intended agents", () => {
    expect(pluginConfig.agents?.sisyphus?.prompt_append).toBe(EXECUTION_PROMPT_APPEND)
    expect(pluginConfig.agents?.atlas?.prompt_append).toBe(EXECUTION_PROMPT_APPEND)
    expect(pluginConfig.agents?.["sisyphus-junior"]?.prompt_append).toBe(EXECUTION_PROMPT_APPEND)
    expect(pluginConfig.agents?.prometheus?.prompt_append).toBe(PROMETHEUS_PROMPT_APPEND)

    expect(pluginConfig.agents?.oracle?.prompt_append).toBeUndefined()
    expect(pluginConfig.agents?.librarian?.prompt_append).toBeUndefined()
    expect(pluginConfig.agents?.explore?.prompt_append).toBeUndefined()
  })

  it("keeps the intentional runtime knob changes while removing unsupported drift", () => {
    expect(pluginConfig.$schema).toBe("./node_modules/oh-my-openagent/dist/oh-my-opencode.schema.json")
    expect(pluginConfig.disabled_mcps).toEqual(["websearch", "context7", "grep_app"])
    expect(pluginConfigContents).not.toContain("raw.githubusercontent.com/code-yeongyu/oh-my-openagent/dev/assets/oh-my-opencode.schema.json")

    expect(pluginConfig.hashline_edit).toBe(true)
    expect(pluginConfig.background_task?.maxIdenticalTasksPerParent).toBe(1)
    expect(pluginConfig.background_task?.staleTimeoutMs).toBe(1800000)
    expect(pluginConfig.babysitting?.timeout_ms).toBe(900000)
    expect(pluginConfig.model_capabilities?.refresh_timeout_ms).toBe(10000)
    expect(pluginConfig.experimental?.auto_resume).toBe(true)
    expect(pluginConfig.experimental?.preemptive_compaction).toBe(true)
    expect(pluginConfig.experimental?.preemptive_compaction_input_tokens).toBe(300000)
    expect(pluginConfig.notification?.force_enable).toBe(true)
    expect(pluginConfig.runtime_fallback?.enabled).toBe(true)
    expect(pluginConfig.runtime_fallback?.max_fallback_attempts).toBe(12)
    expect(pluginConfig.runtime_fallback?.max_full_chain_cycles).toBe(5)
    expect(pluginConfig.runtime_fallback?.cooldown_seconds).toBe(300)
    expect(pluginConfig.runtime_fallback?.timeout_seconds).toBe(45)
    expect(pluginConfig.runtime_fallback?.transient_retry_window_seconds).toBe(900)
    expect(pluginConfig.runtime_fallback?.transient_retry_initial_delay_seconds).toBe(10)
    expect(pluginConfig.runtime_fallback?.transient_retry_max_delay_seconds).toBe(300)
    expect(pluginConfig.runtime_fallback?.manual_provider_clearance_enabled).toBeUndefined()
    expect(pluginConfig.runtime_fallback?.manual_provider_clearance_pause_window_seconds).toBeUndefined()
    expect(pluginConfig.runtime_fallback?.manual_provider_clearance_notify_on_pause).toBeUndefined()

    expect(pluginConfig.sisyphus?.tasks).toEqual({
      storage_path: ".sisyphus/tasks",
      claude_code_compat: false,
    })
    expect(pluginConfig.sisyphus?.tasks?.enabled).toBeUndefined()
    expect(pluginConfig.disabled_agents).toBeUndefined()

    if (/"tasks"\s*:\s*\{[^}]*"enabled"/s.test(pluginConfigContents)) {
      throw new Error("Managed config must not reintroduce sisyphus.tasks.enabled.")
    }
  })
})
