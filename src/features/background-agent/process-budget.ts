import type { BackgroundTaskConfig } from "../../config/schema/background-task"
import {
  DEFAULT_MAX_MCP_ROOTS,
  DEFAULT_MAX_RUNTIME_FALLBACK_ROOTS,
  DEFAULT_MAX_TRACKED_ROOTS,
} from "./constants"

export type BudgetKind = "mcp" | "watchdog" | "probe" | "daemon" | "test"

const KIND_GROUPS = {
  mcp: "mcp",
  watchdog: "runtimeFallback",
  probe: "runtimeFallback",
  daemon: null,
  test: null,
} as const satisfies Record<BudgetKind, "mcp" | "runtimeFallback" | null>

export class ProcessBudgetExceededError extends Error {
  readonly code = "PROCESS_BUDGET_EXCEEDED" as const
  readonly kind: BudgetKind
  readonly current: number
  readonly limit: number

  constructor(kind: BudgetKind, current: number, limit: number) {
    super(`Process budget exceeded for kind "${kind}": ${current}/${limit}`)
    this.name = "ProcessBudgetExceededError"
    this.kind = kind
    this.current = current
    this.limit = limit
  }
}

export class ProcessBudget {
  private readonly maxTotal: number
  private readonly maxMcp: number
  private readonly maxRuntimeFallback: number

  private total = 0
  private byKind: Record<BudgetKind, number> = {
    mcp: 0,
    watchdog: 0,
    probe: 0,
    daemon: 0,
    test: 0,
  }

  constructor(config?: BackgroundTaskConfig) {
    this.maxTotal = config?.processBudget?.maxTrackedRoots ?? DEFAULT_MAX_TRACKED_ROOTS
    this.maxMcp = config?.processBudget?.maxMcpRoots ?? DEFAULT_MAX_MCP_ROOTS
    this.maxRuntimeFallback =
      config?.processBudget?.maxRuntimeFallbackRoots ?? DEFAULT_MAX_RUNTIME_FALLBACK_ROOTS
  }

  getMaxTotal(): number {
    return this.maxTotal
  }

  getMaxForKind(kind: BudgetKind): number {
    const group = KIND_GROUPS[kind]
    if (group === "mcp") return this.maxMcp
    if (group === "runtimeFallback") return this.maxRuntimeFallback
    return this.maxTotal
  }

  reserve(kind: BudgetKind): void {
    if (this.total >= this.maxTotal) {
      throw new ProcessBudgetExceededError(kind, this.total, this.maxTotal)
    }

    const group = KIND_GROUPS[kind]
    if (group === "mcp") {
      const current = this.byKind.mcp
      if (current >= this.maxMcp) {
        throw new ProcessBudgetExceededError(kind, current, this.maxMcp)
      }
    } else if (group === "runtimeFallback") {
      const current = this.byKind.watchdog + this.byKind.probe
      if (current >= this.maxRuntimeFallback) {
        throw new ProcessBudgetExceededError(kind, current, this.maxRuntimeFallback)
      }
    }

    this.total++
    this.byKind[kind]++
  }

  release(kind: BudgetKind): void {
    if (this.byKind[kind] > 0) {
      this.byKind[kind]--
    }
    if (this.total > 0) {
      this.total--
    }
  }

  getCurrentTotal(): number {
    return this.total
  }

  getCurrentByKind(kind: BudgetKind): number {
    return this.byKind[kind]
  }

  clear(): void {
    this.total = 0
    for (const k of Object.keys(this.byKind) as BudgetKind[]) {
      this.byKind[k] = 0
    }
  }
}
