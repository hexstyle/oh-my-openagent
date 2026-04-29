import { describe, expect, test, beforeEach } from "bun:test"
import { ProcessBudget, ProcessBudgetExceededError } from "./process-budget"

describe("ProcessBudget", () => {
  let budget: ProcessBudget

  beforeEach(() => {
    budget = new ProcessBudget()
  })

  describe("defaults", () => {
    test("maxTotal defaults to 12", () => {
      expect(budget.getMaxTotal()).toBe(12)
    })

    test("maxForKind mcp defaults to 4", () => {
      expect(budget.getMaxForKind("mcp")).toBe(4)
    })

    test("maxForKind watchdog defaults to 4", () => {
      expect(budget.getMaxForKind("watchdog")).toBe(4)
    })

    test("maxForKind probe defaults to 4", () => {
      expect(budget.getMaxForKind("probe")).toBe(4)
    })
  })

  describe("config overrides", () => {
    test("respects maxTrackedRoots override", () => {
      const b = new ProcessBudget({ processBudget: { maxTrackedRoots: 20 } })
      expect(b.getMaxTotal()).toBe(20)
    })

    test("respects maxMcpRoots override", () => {
      const b = new ProcessBudget({ processBudget: { maxMcpRoots: 8 } })
      expect(b.getMaxForKind("mcp")).toBe(8)
    })

    test("respects maxRuntimeFallbackRoots override", () => {
      const b = new ProcessBudget({ processBudget: { maxRuntimeFallbackRoots: 6 } })
      expect(b.getMaxForKind("watchdog")).toBe(6)
    })
  })

  describe("reserve", () => {
    test("allows reserving up to total cap", () => {
      const b = new ProcessBudget({ processBudget: { maxTrackedRoots: 3 } })
      b.reserve("daemon")
      b.reserve("daemon")
      b.reserve("daemon")
      expect(b.getCurrentTotal()).toBe(3)
    })

    test("throws after total cap reached", () => {
      const b = new ProcessBudget({ processBudget: { maxTrackedRoots: 2 } })
      b.reserve("daemon")
      b.reserve("daemon")
      expect(() => b.reserve("daemon")).toThrow(ProcessBudgetExceededError)
    })

    test("error has correct code", () => {
      const b = new ProcessBudget({ processBudget: { maxTrackedRoots: 1 } })
      b.reserve("daemon")
      try {
        b.reserve("daemon")
        expect(false).toBe(true)
      } catch (err) {
        expect((err as ProcessBudgetExceededError).code).toBe("PROCESS_BUDGET_EXCEEDED")
      }
    })

    test("failed reserve does NOT increment counter", () => {
      const b = new ProcessBudget({ processBudget: { maxTrackedRoots: 1 } })
      b.reserve("daemon")
      try { b.reserve("daemon") } catch { /* expected */ }
      expect(b.getCurrentTotal()).toBe(1)
    })

    test("mcp cap rejects 5th mcp even if total has room", () => {
      const b = new ProcessBudget({
        processBudget: { maxTrackedRoots: 20, maxMcpRoots: 4 },
      })
      b.reserve("mcp")
      b.reserve("mcp")
      b.reserve("mcp")
      b.reserve("mcp")
      expect(() => b.reserve("mcp")).toThrow(ProcessBudgetExceededError)
    })

    test("runtime-fallback cap rejects 5th watchdog/probe even if total has room", () => {
      const b = new ProcessBudget({
        processBudget: { maxTrackedRoots: 20, maxRuntimeFallbackRoots: 4 },
      })
      b.reserve("watchdog")
      b.reserve("watchdog")
      b.reserve("probe")
      b.reserve("probe")
      expect(() => b.reserve("watchdog")).toThrow(ProcessBudgetExceededError)
    })
  })

  describe("release", () => {
    test("decrements correctly", () => {
      budget.reserve("daemon")
      budget.reserve("daemon")
      budget.release("daemon")
      expect(budget.getCurrentTotal()).toBe(1)
      expect(budget.getCurrentByKind("daemon")).toBe(1)
    })

    test("does not go below 0", () => {
      budget.release("daemon")
      expect(budget.getCurrentTotal()).toBe(0)
      expect(budget.getCurrentByKind("daemon")).toBe(0)
    })
  })

  describe("clear", () => {
    test("resets all counters", () => {
      budget.reserve("mcp")
      budget.reserve("watchdog")
      budget.reserve("daemon")
      budget.clear()
      expect(budget.getCurrentTotal()).toBe(0)
      expect(budget.getCurrentByKind("mcp")).toBe(0)
      expect(budget.getCurrentByKind("watchdog")).toBe(0)
      expect(budget.getCurrentByKind("daemon")).toBe(0)
    })
  })

  describe("getCurrentByKind", () => {
    test("tracks per-kind counts independently", () => {
      budget.reserve("mcp")
      budget.reserve("mcp")
      budget.reserve("watchdog")
      expect(budget.getCurrentByKind("mcp")).toBe(2)
      expect(budget.getCurrentByKind("watchdog")).toBe(1)
      expect(budget.getCurrentByKind("probe")).toBe(0)
    })
  })
})
