import { describe, expect, it } from "bun:test"

import { extractConfiguredModelReferences } from "./model-config-validation"

describe("extractConfiguredModelReferences", () => {
  it("collects primary, fallback, and host limit model references without variant noise", () => {
    const result = extractConfiguredModelReferences(
      {
        agents: {
          prometheus: {
            model: "anthropic/claude-opus-4-6",
            fallback_models: [
              "anthropic/claude-opus-4-6(max)",
              "openai/gpt-5.4(xhigh)",
              "openai/gpt-5.3-codex-spark",
            ],
          },
        },
        categories: {
          quick: {
            model: "openai/gpt-5.4(low)",
          },
        },
        fallback_models: [
          "openai/gpt-5.3-codex-spark",
          "opencode/big-pickle",
        ],
        background_task: {
          modelConcurrency: {
            "openai/gpt-5.4": 3,
          },
        },
      } as any,
      {
        provider: {
          openai: {
            models: {
              "gpt-5.4": {
                limit: { context: 200000 },
              },
            },
          },
        },
      },
    )

    expect(result.models).toEqual([
      {
        model: "anthropic/claude-opus-4-6",
        sources: [
          "agents.prometheus.fallback_models[0]",
          "agents.prometheus.model",
        ],
      },
      {
        model: "openai/gpt-5.3-codex-spark",
        sources: [
          "agents.prometheus.fallback_models[2]",
          "fallback_models[0]",
        ],
      },
      {
        model: "openai/gpt-5.4",
        sources: [
          "agents.prometheus.fallback_models[1]",
          "background_task.modelConcurrency.openai/gpt-5.4",
          "categories.quick.model",
          "provider.openai.models.gpt-5.4",
        ],
      },
      {
        model: "opencode/big-pickle",
        sources: [
          "fallback_models[1]",
        ],
      },
    ])
    expect(result.hostContextLimits).toEqual([
      {
        model: "openai/gpt-5.4",
        requestedContext: 200000,
        source: "provider.openai.models.gpt-5.4.limit.context",
      },
    ])
  })
})
