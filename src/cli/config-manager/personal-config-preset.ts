import type { OpenCodeConfig } from "./parse-opencode-config-file"

const PERSONAL_OPENCODE_CONFIG: OpenCodeConfig = {
  $schema: "https://opencode.ai/config.json",
  plugin: ["oh-my-openagent"],
  model: "opencode/minimax-m2.5-free",
  small_model: "opencode/big-pickle",
  compaction: {
    auto: true,
    prune: true,
    reserved: 12000,
  },
  provider: {
    opencode: {
      whitelist: [
        "big-pickle",
        "minimax-m2.5-free",
        "nemotron-3-super-free",
        "qwen3.6-plus-free",
      ],
      options: {
        timeout: 45000,
        chunkTimeout: 15000,
      },
      models: {
        "big-pickle": {
          limit: {
            context: 200000,
            output: 64000,
          },
        },
        "minimax-m2.5-free": {
          limit: {
            context: 200000,
            output: 64000,
          },
        },
        "nemotron-3-super-free": {
          limit: {
            context: 200000,
            output: 64000,
          },
        },
        "qwen3.6-plus-free": {
          limit: {
            context: 200000,
            output: 64000,
          },
        },
      },
    },
  },
}

const PERSONAL_OMO_CONFIG: Record<string, unknown> = {
  $schema: "https://raw.githubusercontent.com/hexstyle/oh-my-openagent/dev/assets/oh-my-opencode.schema.json",
  default_run_agent: "sisyphus",
  model_fallback: true,
  runtime_fallback: {
    enabled: true,
    retry_on_errors: [
      400,
      401,
      403,
      408,
      409,
      421,
      425,
      429,
      500,
      502,
      503,
      504,
      520,
      522,
      523,
      524,
      525,
      526,
    ],
    max_fallback_attempts: 4,
    cooldown_seconds: 300,
    timeout_seconds: 45,
    notify_on_fallback: true,
  },
  background_task: {
    defaultConcurrency: 2,
    providerConcurrency: {
      opencode: 2,
    },
    modelConcurrency: {
      "opencode/big-pickle": 2,
      "opencode/minimax-m2.5-free": 2,
      "opencode/nemotron-3-super-free": 1,
      "opencode/qwen3.6-plus-free": 1,
    },
  },
  experimental: {
    preemptive_compaction: true,
  },
  agents: {
    sisyphus: {
      model: "opencode/minimax-m2.5-free",
      reasoningEffort: "high",
      maxTokens: 48000,
      fallback_models: [
        "opencode/nemotron-3-super-free",
        "opencode/qwen3.6-plus-free",
        "opencode/big-pickle",
      ],
      compaction: {
        model: "opencode/big-pickle",
      },
    },
    hephaestus: {
      model: "opencode/minimax-m2.5-free",
      reasoningEffort: "high",
      maxTokens: 48000,
      fallback_models: [
        "opencode/nemotron-3-super-free",
        "opencode/qwen3.6-plus-free",
        "opencode/big-pickle",
      ],
      compaction: {
        model: "opencode/big-pickle",
      },
    },
    oracle: {
      model: "opencode/minimax-m2.5-free",
      reasoningEffort: "high",
      maxTokens: 48000,
      fallback_models: [
        "opencode/nemotron-3-super-free",
        "opencode/qwen3.6-plus-free",
        "opencode/big-pickle",
      ],
      compaction: {
        model: "opencode/big-pickle",
      },
    },
    explore: {
      model: "opencode/big-pickle",
      reasoningEffort: "low",
      fallback_models: [
        "opencode/minimax-m2.5-free",
        "opencode/nemotron-3-super-free",
      ],
      compaction: {
        model: "opencode/big-pickle",
      },
    },
    "multimodal-looker": {
      model: "opencode/nemotron-3-super-free",
      reasoningEffort: "medium",
      fallback_models: [
        "opencode/minimax-m2.5-free",
        "opencode/qwen3.6-plus-free",
        "opencode/big-pickle",
      ],
      compaction: {
        model: "opencode/big-pickle",
      },
    },
    prometheus: {
      model: "opencode/minimax-m2.5-free",
      reasoningEffort: "high",
      maxTokens: 48000,
      fallback_models: [
        "opencode/nemotron-3-super-free",
        "opencode/qwen3.6-plus-free",
        "opencode/big-pickle",
      ],
      compaction: {
        model: "opencode/big-pickle",
      },
    },
    metis: {
      model: "opencode/minimax-m2.5-free",
      reasoningEffort: "high",
      maxTokens: 48000,
      fallback_models: [
        "opencode/nemotron-3-super-free",
        "opencode/qwen3.6-plus-free",
        "opencode/big-pickle",
      ],
      compaction: {
        model: "opencode/big-pickle",
      },
    },
    momus: {
      model: "opencode/minimax-m2.5-free",
      reasoningEffort: "high",
      maxTokens: 48000,
      fallback_models: [
        "opencode/nemotron-3-super-free",
        "opencode/qwen3.6-plus-free",
        "opencode/big-pickle",
      ],
      compaction: {
        model: "opencode/big-pickle",
      },
    },
    atlas: {
      model: "opencode/minimax-m2.5-free",
      reasoningEffort: "medium",
      fallback_models: [
        "opencode/big-pickle",
        "opencode/nemotron-3-super-free",
        "opencode/qwen3.6-plus-free",
      ],
      compaction: {
        model: "opencode/big-pickle",
      },
    },
    "sisyphus-junior": {
      model: "opencode/big-pickle",
      reasoningEffort: "low",
      fallback_models: [
        "opencode/minimax-m2.5-free",
        "opencode/nemotron-3-super-free",
      ],
      compaction: {
        model: "opencode/big-pickle",
      },
    },
    librarian: {
      model: "opencode/minimax-m2.5-free",
      reasoningEffort: "medium",
      fallback_models: [
        "opencode/big-pickle",
        "opencode/nemotron-3-super-free",
        "opencode/qwen3.6-plus-free",
      ],
      compaction: {
        model: "opencode/big-pickle",
      },
    },
  },
  categories: {
    "visual-engineering": {
      model: "opencode/nemotron-3-super-free",
      reasoningEffort: "high",
      fallback_models: [
        "opencode/minimax-m2.5-free",
        "opencode/qwen3.6-plus-free",
        "opencode/big-pickle",
      ],
      compaction: {
        model: "opencode/big-pickle",
      },
    },
    ultrabrain: {
      model: "opencode/minimax-m2.5-free",
      reasoningEffort: "high",
      fallback_models: [
        "opencode/nemotron-3-super-free",
        "opencode/qwen3.6-plus-free",
        "opencode/big-pickle",
      ],
      compaction: {
        model: "opencode/big-pickle",
      },
    },
    deep: {
      model: "opencode/minimax-m2.5-free",
      reasoningEffort: "high",
      fallback_models: [
        "opencode/nemotron-3-super-free",
        "opencode/qwen3.6-plus-free",
        "opencode/big-pickle",
      ],
      compaction: {
        model: "opencode/big-pickle",
      },
    },
    quick: {
      model: "opencode/big-pickle",
      reasoningEffort: "low",
      fallback_models: [
        "opencode/minimax-m2.5-free",
        "opencode/nemotron-3-super-free",
      ],
      compaction: {
        model: "opencode/big-pickle",
      },
    },
    "unspecified-low": {
      model: "opencode/big-pickle",
      reasoningEffort: "low",
      fallback_models: [
        "opencode/minimax-m2.5-free",
        "opencode/nemotron-3-super-free",
      ],
      compaction: {
        model: "opencode/big-pickle",
      },
    },
    "unspecified-high": {
      model: "opencode/minimax-m2.5-free",
      reasoningEffort: "high",
      fallback_models: [
        "opencode/nemotron-3-super-free",
        "opencode/qwen3.6-plus-free",
        "opencode/big-pickle",
      ],
      compaction: {
        model: "opencode/big-pickle",
      },
    },
    writing: {
      model: "opencode/minimax-m2.5-free",
      reasoningEffort: "medium",
      fallback_models: [
        "opencode/big-pickle",
        "opencode/nemotron-3-super-free",
        "opencode/qwen3.6-plus-free",
      ],
      compaction: {
        model: "opencode/big-pickle",
      },
    },
    artistry: {
      model: "opencode/nemotron-3-super-free",
      reasoningEffort: "high",
      fallback_models: [
        "opencode/minimax-m2.5-free",
        "opencode/qwen3.6-plus-free",
        "opencode/big-pickle",
      ],
      compaction: {
        model: "opencode/big-pickle",
      },
    },
  },
}

function cloneRecord<T extends Record<string, unknown>>(value: T): T {
  return structuredClone(value)
}

export function getPersonalOpenCodeConfig(pluginEntry = "oh-my-openagent"): OpenCodeConfig {
  const preset = cloneRecord(PERSONAL_OPENCODE_CONFIG)
  preset.plugin = [pluginEntry]
  return preset
}

export function getPersonalOmoConfig(): Record<string, unknown> {
  return cloneRecord(PERSONAL_OMO_CONFIG)
}
