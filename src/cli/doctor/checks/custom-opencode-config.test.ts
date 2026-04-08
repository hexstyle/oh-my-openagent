import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import {
  MANAGED_HOST_INSTRUCTION_ENTRIES,
  MANAGED_HOST_PLUGIN_ENTRIES,
} from "../../../shared/managed-opencode-runtime"

const hostConfigPath = new URL("../../../../assets/custom-opencode/opencode.json", import.meta.url)
const pluginConfigPath = new URL("../../../../assets/custom-opencode/oh-my-opencode.json", import.meta.url)

const EXECUTION_PROMPT_APPEND = "Before substantive work in any repository, first check whether the root AGENTS.md exists and matches the current project. If it is missing, outdated, or clearly incomplete, create or refresh it immediately before major edits. Keep it concise and factual. Add nested AGENTS.md files only when the repository is large or conventions differ by subtree. Maintain these files as you learn the repo's structure, commands, tests, conventions, and gotchas. If execution begins via /start-work, an approved Prometheus handoff, or an active boulder, treat that as explicit permission to implement. In execution mode, drive the plan to completion, keep delegating and verifying until all planned work is done, and do not stop at interim summaries or partial progress. Return control early only for destructive or irreversible actions, materially missing information, or hard environment blockers that cannot be solved from the repo. Default to short, task-appropriate timeouts for every operation. Long-running commands are exceptions, not the default. Break work into minimal steps, avoid waiting idle on commands that show no useful progress, and if something runs unexpectedly long, stop to diagnose it before retrying with a larger timeout."
const PROMETHEUS_PROMPT_APPEND = "Before substantive work in any repository, first check whether the root AGENTS.md exists and matches the current project. If it is missing, outdated, or clearly incomplete, create or refresh it immediately before major edits. Keep it concise and factual. Add nested AGENTS.md files only when the repository is large or conventions differ by subtree. Maintain these files as you learn the repo's structure, commands, tests, conventions, and gotchas. You are the planning and negotiation front door. Stay in planning mode, resolve scope and tradeoffs with the user, and finish with a concrete executable plan plus /start-work guidance. Do not execute the plan yourself unless the user explicitly overrides this role. Default to short, task-appropriate timeouts for every operation. Long-running commands are exceptions, not the default. Break work into minimal steps, avoid waiting idle on commands that show no useful progress, and if something runs unexpectedly long, stop to diagnose it before retrying with a larger timeout."
const PAID_MODELS = [
  "anthropic/claude-opus-4-6",
  "anthropic/claude-sonnet-4-6",
  "openai/gpt-5.4",
] as const
const SPARK_MODELS = ["openai/gpt-5.3-codex-spark"] as const
const FREE_MODELS = [
  "opencode/nemotron-3-super-free",
  "opencode/minimax-m2.5-free",
  "opencode/big-pickle",
] as const

type FallbackModelEntry = string | { model?: string }

function extractModelID(entry: FallbackModelEntry): string {
  if (typeof entry === "string") return entry
  return entry.model ?? ""
}

function assertPaidSparkFreeOrdering(chain: FallbackModelEntry[]) {
  expect(chain.length).toBeGreaterThan(0)

  const stageOf = (model: string): 0 | 1 | 2 | 3 => {
    if (PAID_MODELS.includes(model as (typeof PAID_MODELS)[number])) return 0
    if (SPARK_MODELS.includes(model as (typeof SPARK_MODELS)[number])) return 1
    if (FREE_MODELS.includes(model as (typeof FREE_MODELS)[number])) return 2
    return 3
  }

  let previousStage = 0
  for (const entry of chain) {
    const model = extractModelID(entry)
    const stage = stageOf(model)
    expect(stage).not.toBe(3)
    expect(stage).toBeGreaterThanOrEqual(previousStage)
    previousStage = stage
  }

  expect(chain.some((entry) => SPARK_MODELS.includes(extractModelID(entry) as (typeof SPARK_MODELS)[number]))).toBe(true)
  expect(chain.some((entry) => FREE_MODELS.includes(extractModelID(entry) as (typeof FREE_MODELS)[number]))).toBe(true)
}

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

  it("pins controller and review agents to Opus first, keeps GPT-5.4 coding/deep workers, and leaves explore as the spark-only speed lane", () => {
    const prometheus = pluginConfig.agents?.prometheus
    expect(prometheus?.model).toBe("anthropic/claude-opus-4-6")
    expect(prometheus?.variant).toBe("max")
    expect(prometheus?.textVerbosity).toBe("high")

    for (const reviewAgentName of ["sisyphus", "oracle", "momus", "metis"] as const) {
      const reviewAgent = pluginConfig.agents?.[reviewAgentName]
      expect(reviewAgent?.model).toBe("anthropic/claude-opus-4-6")
    }

    expect(pluginConfig.agents?.hephaestus?.model).toBe("openai/gpt-5.4")
    expect(pluginConfig.agents?.hephaestus?.variant).toBe("xhigh")
    expect(pluginConfig.agents?.atlas?.model).toBe("openai/gpt-5.4")
    expect(pluginConfig.agents?.atlas?.variant).toBe("xhigh")
    expect(pluginConfig.agents?.explore?.model).toBe("openai/gpt-5.3-codex-spark")
    expect(pluginConfig.agents?.librarian?.model).toBe("openai/gpt-5.4")
    expect(pluginConfig.agents?.["sisyphus-junior"]?.model).toBe("openai/gpt-5.4")
    expect(pluginConfig.agents?.explore?.variant).toBeUndefined()
    expect(pluginConfig.agents?.["sisyphus-junior"]?.variant).toBe("medium")
    expect(pluginConfig.agents?.explore?.fallback_models).toEqual([
      "openai/gpt-5.3-codex-spark",
      "opencode/nemotron-3-super-free",
      "opencode/minimax-m2.5-free",
      "opencode/big-pickle",
    ])
    expect(pluginConfig.agents?.["sisyphus-junior"]?.fallback_models).toEqual([
      {
        model: "openai/gpt-5.4",
        variant: "medium",
        reasoningEffort: "medium",
      },
      "openai/gpt-5.3-codex-spark",
      "opencode/nemotron-3-super-free",
      "opencode/minimax-m2.5-free",
      "opencode/big-pickle",
    ])

    expect(pluginConfig.categories?.ultrabrain?.model).toBe("anthropic/claude-opus-4-6")
    expect(pluginConfig.categories?.deep?.model).toBe("openai/gpt-5.4")
    expect(pluginConfig.categories?.quick?.model).toBe("openai/gpt-5.4")
    expect(pluginConfig.categories?.["unspecified-low"]?.model).toBe("openai/gpt-5.4")
    expect(pluginConfig.categories?.["unspecified-high"]?.model).toBe("openai/gpt-5.4")
    expect(pluginConfig.default_run_agent).toBe("Prometheus (Plan Builder)")
  })

  it("keeps fallback order as paid -> spark -> free", () => {
    assertPaidSparkFreeOrdering(pluginConfig.fallback_models ?? [])
    assertPaidSparkFreeOrdering((pluginConfig.agents?.prometheus?.fallback_models as FallbackModelEntry[] | undefined) ?? [])
    assertPaidSparkFreeOrdering((pluginConfig.agents?.sisyphus?.fallback_models as FallbackModelEntry[] | undefined) ?? [])
    assertPaidSparkFreeOrdering((pluginConfig.categories?.deep?.fallback_models as FallbackModelEntry[] | undefined) ?? [])
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
    expect(pluginConfig.background_task?.staleTimeoutMs).toBe(600000)
    expect(pluginConfig.babysitting?.timeout_ms).toBe(300000)
    expect(pluginConfig.model_capabilities?.refresh_timeout_ms).toBe(10000)
    expect(pluginConfig.experimental?.auto_resume).toBe(true)
    expect(pluginConfig.experimental?.preemptive_compaction).toBe(true)
    expect(pluginConfig.experimental?.preemptive_compaction_input_tokens).toBe(200000)
    expect(pluginConfig.notification?.force_enable).toBe(true)
    expect(pluginConfig.runtime_fallback?.enabled).toBe(true)
    expect(pluginConfig.runtime_fallback?.max_fallback_attempts).toBe(12)
    expect(pluginConfig.runtime_fallback?.max_full_chain_cycles).toBe(5)
    expect(pluginConfig.runtime_fallback?.cooldown_seconds).toBe(300)
    expect(pluginConfig.runtime_fallback?.timeout_seconds).toBe(45)
    expect(pluginConfig.runtime_fallback?.transient_retry_window_seconds).toBe(14400)
    expect(pluginConfig.runtime_fallback?.transient_retry_initial_delay_seconds).toBe(30)
    expect(pluginConfig.runtime_fallback?.transient_retry_max_delay_seconds).toBe(300)

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
