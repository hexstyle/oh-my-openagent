import { afterEach, describe, expect, test } from "bun:test"
import { getProviderSmokeConfig, resolveSmokeTimeoutMs } from "./verify-local-opencode-install"
import { MANAGED_RUNTIME_PLUGIN_DEPENDENCIES } from "../src/shared/managed-opencode-runtime"

const GLOBAL_TIMEOUT_ENV = "OH_MY_OPENAGENT_VERIFY_SMOKE_TIMEOUT_MS"
const ANTHROPIC_TIMEOUT_ENV = "OH_MY_OPENAGENT_VERIFY_ANTHROPIC_SMOKE_TIMEOUT_MS"

describe("verify-local-opencode-install smoke timeout policy", () => {
  afterEach(() => {
    delete process.env[GLOBAL_TIMEOUT_ENV]
    delete process.env[ANTHROPIC_TIMEOUT_ENV]
  })

  test("uses faster default smoke timeout for non-Anthropic agents", () => {
    expect(resolveSmokeTimeoutMs("Hephaestus (Deep Agent)")).toBe(90_000)
  })

  test("uses Anthropic-specific timeout for Prometheus smoke", () => {
    expect(resolveSmokeTimeoutMs("Prometheus (Plan Builder)")).toBe(120_000)
  })

  test("global override wins for every smoke", () => {
    process.env[GLOBAL_TIMEOUT_ENV] = "45000"
    process.env[ANTHROPIC_TIMEOUT_ENV] = "123000"

    expect(resolveSmokeTimeoutMs("Hephaestus (Deep Agent)")).toBe(45_000)
    expect(resolveSmokeTimeoutMs("Prometheus (Plan Builder)")).toBe(45_000)
  })

  test("Anthropic override applies only to Prometheus smoke", () => {
    process.env[ANTHROPIC_TIMEOUT_ENV] = "150000"

    expect(resolveSmokeTimeoutMs("Prometheus (Plan Builder)")).toBe(150_000)
    expect(resolveSmokeTimeoutMs("Hephaestus (Deep Agent)")).toBe(90_000)
  })

  test("provider smoke config pins explicit provider/model pairs", () => {
    expect(getProviderSmokeConfig("anthropic")).toEqual({
      agentName: "Sisyphus (Ultraworker)",
      model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" },
    })
    expect(getProviderSmokeConfig("openai")).toEqual({
      agentName: "Sisyphus (Ultraworker)",
      model: { providerID: "openai", modelID: "gpt-5.4" },
    })
  })

  test("managed claude auth runtime pin tracks the OAuth-compatible release", () => {
    expect(MANAGED_RUNTIME_PLUGIN_DEPENDENCIES["opencode-claude-auth"]).toBe("1.5.3")
  })
})
