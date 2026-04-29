import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { collectFallbackPolicyViolations } from "../../../custom-opencode/model-config-validation"
import {
  MANAGED_HOST_INSTRUCTION_ENTRIES,
  MANAGED_HOST_PLUGIN_ENTRIES,
} from "../../../shared/managed-opencode-runtime"

const hostConfigPath = new URL("../../../../assets/custom-opencode/opencode.json", import.meta.url)
const pluginConfigPath = new URL("../../../../assets/custom-opencode/oh-my-opencode.json", import.meta.url)

const EXECUTION_PROMPT_APPEND = "Check AGENTS.md on first repo interaction; create/update if missing or stale. /start-work, Prometheus handoff, or active boulder = permission to execute. Drive the plan to completion — delegate, verify, iterate. Do not stop at summaries or partial progress. Return control only for destructive actions, missing info, or hard blockers (network/DNS failure = hard blocker — commit locally and stop, don't loop). Short timeouts by default; diagnose before retrying slow commands. CI RULES: Never escalate failures as 'data-dependent' or 'unfixable'. failed==0 is the only DoD — create missing data in TestInitialize, mock deps, adjust CI params. Test execution target: ≤15min, hard limit 20min. COMPREHENSIVE FIX: Every fix session must fix ALL known failures, not just a subset. Read ALL evidence, fix ALL files, push ONCE. If you see a fixable test — fix it, regardless of task boundaries. LOCAL VERIFY MANDATE: Before pushing Playwright test fixes, run `dotnet test --filter` for ALL affected tests locally. Push ONLY after local pass. If local infra unavailable, document why in commit. Evidence hygiene: delete any .sisyphus/evidence/ file >10KB and any raw JSON/log/TRX before each iteration. Total evidence <500KB."
const PROMETHEUS_PROMPT_APPEND = "Check AGENTS.md on first repo interaction; create/update if missing or stale. You are the planning front door. Stay in planning mode, resolve scope/tradeoffs, produce a concrete plan + /start-work guidance. Do not execute yourself. Short timeouts by default; diagnose before retrying slow commands. CI PLANS: Load ci-green-loop skill FIRST. Plans MUST have EXACTLY 2 tasks: Task 1 = Diagnosis (fetch ALL build data, classify ALL failures), Task 2 = Fix ALL (one comprehensive task fixing EVERY failure across ALL files, ending with build+commit+push). NEVER split fixes into multiple tasks — each task = ~2 min dispatch overhead + risk of parallel file conflicts. 100% failure coverage mandatory. failed==0 is the only DoD. No escalation as 'data-dependent' or 'unfixable'. Test target: ≤15min. WRITE TOOL LIMIT: Files >30 lines MUST use bash heredoc (`cat > file << 'EOF'`), split chunks <30 lines. Write tool silently fails on large content. ANTI-PLAN-CHURN: Before generating a new CI plan, check .sisyphus/plans/ for existing plans <24h old covering current failures. If one covers >=80% with no new failure types, instruct executor to continue it. 3+ regenerations without a push = stop and execute."
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

  it("pins Claude as primary for all agents with gpt-5.4 as cross-provider fallback after Claude models", () => {
    const prometheus = pluginConfig.agents?.prometheus
    expect(prometheus?.model).toBe("anthropic/claude-opus-4-7")
    expect(prometheus?.variant).toBe("max")
    expect(prometheus?.textVerbosity).toBe("high")

    // Controller/review agents use Opus
    for (const reviewAgentName of ["momus", "metis"] as const) {
      const reviewAgent = pluginConfig.agents?.[reviewAgentName]
      expect(reviewAgent?.model).toBe("anthropic/claude-opus-4-7")
    }

    // Executor agents use Sonnet
    for (const executorName of ["sisyphus", "oracle", "atlas", "hephaestus", "librarian", "sisyphus-junior"] as const) {
      expect(pluginConfig.agents?.[executorName]?.model).toBe("anthropic/claude-sonnet-4-6")
    }

    expect(pluginConfig.agents?.explore?.model).toBe("anthropic/claude-sonnet-4-6")
    expect(pluginConfig.agents?.["sisyphus-junior"]?.variant).toBe("medium")

    // CROSS-PROVIDER INVARIANT: Every agent chain must have both Claude AND OpenAI models.
    // This ensures provider-level redundancy — if one provider is down, the other takes over.
    // gpt-5.4 appears AFTER Claude models in all chains (Claude is primary, OpenAI is fallback).
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

    expect(pluginConfig.categories?.deep?.model).toBe("anthropic/claude-sonnet-4-6")
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
