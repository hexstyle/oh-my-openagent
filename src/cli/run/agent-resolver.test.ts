/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import type { OhMyOpenCodeConfig } from "../../config"
import { resolveRunAgent } from "./agent-resolver"

const createConfig = (overrides: Partial<OhMyOpenCodeConfig> = {}): OhMyOpenCodeConfig => ({
  ...overrides,
})

describe("resolveRunAgent", () => {
  afterEach(() => {
    mock.restore()
  })

  it("preserves unknown explicit agents while honoring priority over env and config", () => {
    //#given
    const config = createConfig({ default_run_agent: "prometheus" })
    const env = { OPENCODE_DEFAULT_AGENT: "Atlas" }

    //#when
    const agent = resolveRunAgent({ message: "test", agent: "  custom-agent  " }, config, env)

    //#then
    expect(agent).toBe("custom-agent")
  })

  it("falls back when an env-selected display-name agent is disabled", () => {
    //#given
    const config = createConfig({ disabled_agents: ["Atlas (Plan Executor)"] })
    const env = { OPENCODE_DEFAULT_AGENT: "Atlas (Plan Executor)" }
    const logSpy = spyOn(console, "log").mockImplementation(mock(() => undefined))

    //#when
    const agent = resolveRunAgent({ message: "test" }, config, env)

    //#then
    expect(agent).toBe("Sisyphus (Ultraworker)")
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain("disabled")
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain("Sisyphus")
  })

  it("treats sisyphus_agent.disabled as disabling the config default agent", () => {
    //#given
    const config = createConfig({
      default_run_agent: "sisyphus",
      sisyphus_agent: { disabled: true },
    })
    const logSpy = spyOn(console, "log").mockImplementation(mock(() => undefined))

    //#when
    const agent = resolveRunAgent({ message: "test" }, config, {})

    //#then
    expect(agent).toBe("Hephaestus (Deep Agent)")
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain("disabled")
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain("Hephaestus")
  })

  it("falls back to the default core agent when a requested core agent is disabled", () => {
    //#given
    const config = createConfig({ disabled_agents: ["Hephaestus"] })

    //#when
    const agent = resolveRunAgent({ message: "test", agent: "Hephaestus" }, config, {})

    //#then
    expect(agent).toBe("Sisyphus (Ultraworker)")
  })

  it("still returns sisyphus when every core agent is disabled", () => {
    //#given
    const config = createConfig({
      disabled_agents: ["sisyphus", "hephaestus", "prometheus", "atlas"],
    })
    const logSpy = spyOn(console, "log").mockImplementation(mock(() => undefined))

    //#when
    const agent = resolveRunAgent({ message: "test", agent: "Atlas" }, config, {})

    //#then
    expect(agent).toBe("Sisyphus (Ultraworker)")
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(String(logSpy.mock.calls[0]?.[0] ?? "")).toContain("no enabled core agent was found")
  })
})
