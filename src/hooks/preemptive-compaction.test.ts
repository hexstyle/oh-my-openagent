/// <reference types="bun-types" />

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test"

const ANTHROPIC_CONTEXT_ENV_KEY = "ANTHROPIC_1M_CONTEXT"
const VERTEX_CONTEXT_ENV_KEY = "VERTEX_ANTHROPIC_1M_CONTEXT"

const originalAnthropicContextEnv = process.env[ANTHROPIC_CONTEXT_ENV_KEY]
const originalVertexContextEnv = process.env[VERTEX_CONTEXT_ENV_KEY]

function resetContextLimitEnv(): void {
  if (originalAnthropicContextEnv === undefined) {
    delete process.env[ANTHROPIC_CONTEXT_ENV_KEY]
  } else {
    process.env[ANTHROPIC_CONTEXT_ENV_KEY] = originalAnthropicContextEnv
  }

  if (originalVertexContextEnv === undefined) {
    delete process.env[VERTEX_CONTEXT_ENV_KEY]
  } else {
    process.env[VERTEX_CONTEXT_ENV_KEY] = originalVertexContextEnv
  }
}

const logMock = mock(() => {})

mock.module("../shared/logger", () => ({
  log: logMock,
}))

const { createPreemptiveCompactionHook } = await import("./preemptive-compaction")

function createMockCtx() {
  return {
    client: {
      session: {
        messages: mock(() => Promise.resolve({ data: [] })),
        summarize: mock(() => Promise.resolve({})),
      },
      tui: {
        showToast: mock(() => Promise.resolve()),
      },
    },
    directory: "/tmp/test",
  }
}

function setupImmediateTimeouts(): () => void {
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout

  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, _delay?: number, ...args: unknown[]) => {
    callback(...args)
    return 1 as unknown as ReturnType<typeof setTimeout>
  }) as typeof setTimeout

  globalThis.clearTimeout = (() => {}) as typeof clearTimeout

  return () => {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }
}

describe("preemptive-compaction", () => {
  let ctx: ReturnType<typeof createMockCtx>

  beforeEach(() => {
    ctx = createMockCtx()
    logMock.mockClear()
    delete process.env[ANTHROPIC_CONTEXT_ENV_KEY]
    delete process.env[VERTEX_CONTEXT_ENV_KEY]
  })

  afterEach(() => {
    resetContextLimitEnv()
  })

  // #given event caches token info from message.updated
  // #when tool.execute.after is called
  // #then session.messages() should NOT be called
  it("should use cached token info instead of fetching session.messages()", async () => {
    const hook = createPreemptiveCompactionHook(ctx as never, {} as never)
    const sessionID = "ses_test1"

    // Simulate message.updated with token info below threshold
    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            role: "assistant",
            sessionID,
            providerID: "anthropic",
            modelID: "claude-sonnet-4-6",
            finish: true,
            tokens: {
              input: 50000,
              output: 1000,
              reasoning: 0,
              cache: { read: 5000, write: 0 },
            },
          },
        },
      },
    })

    const output = { title: "", output: "test", metadata: null }
    await hook["tool.execute.after"](
      { tool: "bash", sessionID, callID: "call_1" },
      output
    )

    expect(ctx.client.session.messages).not.toHaveBeenCalled()
  })

  // #given no cached token info
  // #when tool.execute.after is called
  // #then should skip without fetching
  it("should skip gracefully when no cached token info exists", async () => {
    const hook = createPreemptiveCompactionHook(ctx as never, {} as never)

    const output = { title: "", output: "test", metadata: null }
    await hook["tool.execute.after"](
      { tool: "bash", sessionID: "ses_none", callID: "call_1" },
      output
    )

    expect(ctx.client.session.messages).not.toHaveBeenCalled()
  })

  // #given usage above 78% threshold
  // #when tool.execute.after runs
  // #then should trigger summarize
  it("should trigger compaction when usage exceeds threshold", async () => {
    const hook = createPreemptiveCompactionHook(ctx as never, {} as never)
    const sessionID = "ses_high"

    // 170K input + 10K cache = 180K → 90% of 200K
    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            role: "assistant",
            sessionID,
            providerID: "anthropic",
            modelID: "claude-sonnet-4-6",
            finish: true,
            tokens: {
              input: 170000,
              output: 1000,
              reasoning: 0,
              cache: { read: 10000, write: 0 },
            },
          },
        },
      },
    })

    const output = { title: "", output: "test", metadata: null }
    await hook["tool.execute.after"](
      { tool: "bash", sessionID, callID: "call_1" },
      output
    )

    expect(ctx.client.session.messages).not.toHaveBeenCalled()
    expect(ctx.client.session.summarize).toHaveBeenCalled()
  })

  it("should trigger compaction for google-vertex-anthropic provider", async () => {
    //#given google-vertex-anthropic usage above threshold
    const hook = createPreemptiveCompactionHook(ctx as never, {} as never)
    const sessionID = "ses_vertex_anthropic_high"

    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            role: "assistant",
            sessionID,
            providerID: "google-vertex-anthropic",
            modelID: "claude-sonnet-4-6",
            finish: true,
            tokens: {
              input: 170000,
              output: 1000,
              reasoning: 0,
              cache: { read: 10000, write: 0 },
            },
          },
        },
      },
    })

    //#when tool.execute.after runs
    const output = { title: "", output: "test", metadata: null }
    await hook["tool.execute.after"](
      { tool: "bash", sessionID, callID: "call_1" },
      output
    )

    //#then summarize should be triggered
    expect(ctx.client.session.summarize).toHaveBeenCalled()
  })

  // #given session deleted
  // #then cache should be cleaned up
  it("should clean up cache on session.deleted", async () => {
    const hook = createPreemptiveCompactionHook(ctx as never, {} as never)
    const sessionID = "ses_del"

    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            role: "assistant",
            sessionID,
            providerID: "anthropic",
            modelID: "claude-sonnet-4-6",
            finish: true,
            tokens: { input: 180000, output: 0, reasoning: 0, cache: { read: 10000, write: 0 } },
          },
        },
      },
    })

    await hook.event({
      event: {
        type: "session.deleted",
        properties: { info: { id: sessionID } },
      },
    })

    const output = { title: "", output: "test", metadata: null }
    await hook["tool.execute.after"](
      { tool: "bash", sessionID, callID: "call_1" },
      output
    )

    expect(ctx.client.session.summarize).not.toHaveBeenCalled()
  })

  it("should log summarize errors instead of swallowing them", async () => {
    //#given
    const hook = createPreemptiveCompactionHook(ctx as never, {} as never)
    const sessionID = "ses_log_error"
    const summarizeError = new Error("summarize failed")
    ctx.client.session.summarize.mockRejectedValueOnce(summarizeError)

    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            role: "assistant",
            sessionID,
            providerID: "anthropic",
            modelID: "claude-sonnet-4-6",
            finish: true,
            tokens: {
              input: 170000,
              output: 0,
              reasoning: 0,
              cache: { read: 10000, write: 0 },
            },
          },
        },
      },
    })

    //#when
    await hook["tool.execute.after"](
      { tool: "bash", sessionID, callID: "call_log" },
      { title: "", output: "test", metadata: null }
    )

    //#then
    expect(logMock).toHaveBeenCalledWith("[preemptive-compaction] Compaction failed", {
      sessionID,
      error: String(summarizeError),
    })
  })

  // #given compaction fails
  // #when tool.execute.after is called again immediately
  // #then should NOT retry due to cooldown
  it("should enforce cooldown even after failed compaction to prevent rapid retry loops", async () => {
    //#given
    const hook = createPreemptiveCompactionHook(ctx as never, {} as never)
    const sessionID = "ses_fail_cooldown"
    ctx.client.session.summarize.mockRejectedValueOnce(new Error("rate limited"))

    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            role: "assistant",
            sessionID,
            providerID: "anthropic",
            modelID: "claude-sonnet-4-6",
            finish: true,
            tokens: {
              input: 170000,
              output: 0,
              reasoning: 0,
              cache: { read: 10000, write: 0 },
            },
          },
        },
      },
    })

    await hook["tool.execute.after"](
      { tool: "bash", sessionID, callID: "call_fail" },
      { title: "", output: "test", metadata: null }
    )

    expect(ctx.client.session.summarize).toHaveBeenCalledTimes(1)

    //#when - message.updated clears compactedSessions, but cooldown should still block
    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            role: "assistant",
            sessionID,
            providerID: "anthropic",
            modelID: "claude-sonnet-4-6",
            finish: true,
            tokens: {
              input: 170000,
              output: 0,
              reasoning: 0,
              cache: { read: 10000, write: 0 },
            },
          },
        },
      },
    })

    await hook["tool.execute.after"](
      { tool: "bash", sessionID, callID: "call_fail_2" },
      { title: "", output: "test", metadata: null }
    )

    //#then - should NOT have retried
    expect(ctx.client.session.summarize).toHaveBeenCalledTimes(1)
  })

  it("should use 1M limit when model cache flag is enabled", async () => {
    //#given
    const hook = createPreemptiveCompactionHook(ctx as never, {} as never, {
      anthropicContext1MEnabled: true,
    })
    const sessionID = "ses_1m_flag"

    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            role: "assistant",
            sessionID,
            providerID: "anthropic",
            modelID: "claude-sonnet-4-6",
            finish: true,
            tokens: {
              input: 300000,
              output: 1000,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
        },
      },
    })

    //#when
    await hook["tool.execute.after"](
      { tool: "bash", sessionID, callID: "call_1" },
      { title: "", output: "test", metadata: null }
    )

    //#then
    expect(ctx.client.session.summarize).not.toHaveBeenCalled()
  })

  it("should keep env var fallback when model cache flag is disabled", async () => {
    //#given
    process.env[ANTHROPIC_CONTEXT_ENV_KEY] = "true"
    const hook = createPreemptiveCompactionHook(ctx as never, {} as never, {
      anthropicContext1MEnabled: false,
    })
    const sessionID = "ses_env_fallback"

    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            role: "assistant",
            sessionID,
            providerID: "anthropic",
            modelID: "claude-sonnet-4-6",
            finish: true,
            tokens: {
              input: 300000,
              output: 1000,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          },
        },
      },
    })

    //#when
    await hook["tool.execute.after"](
      { tool: "bash", sessionID, callID: "call_1" },
      { title: "", output: "test", metadata: null }
    )

    //#then
    expect(ctx.client.session.summarize).not.toHaveBeenCalled()
  })

  it("should clear in-progress lock when summarize times out", async () => {
    //#given
    const restoreTimeouts = setupImmediateTimeouts()
    const hook = createPreemptiveCompactionHook(ctx as never, {} as never)
    const sessionID = "ses_timeout"

    ctx.client.session.summarize
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({})

    try {
      await hook.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              role: "assistant",
              sessionID,
              providerID: "anthropic",
              modelID: "claude-sonnet-4-6",
              finish: true,
              tokens: {
                input: 170000,
                output: 0,
                reasoning: 0,
                cache: { read: 10000, write: 0 },
              },
            },
          },
        },
      })

      //#when
      await hook["tool.execute.after"](
        { tool: "bash", sessionID, callID: "call_timeout_1" },
        { title: "", output: "test", metadata: null },
      )

      //#then - first call timed out
      expect(ctx.client.session.summarize).toHaveBeenCalledTimes(1)
      expect(logMock).toHaveBeenCalledWith("[preemptive-compaction] Compaction failed", {
        sessionID,
        error: expect.stringContaining("Compaction summarize timed out"),
      })

      //#when - advance past cooldown, clear compactedSessions via message.updated, then retry
      const originalNow = Date.now
      Date.now = () => originalNow() + 61_000
      try {
        await hook.event({
          event: {
            type: "message.updated",
            properties: {
              info: {
                role: "assistant",
                sessionID,
                providerID: "anthropic",
                modelID: "claude-sonnet-4-6",
                finish: true,
                tokens: {
                  input: 170000,
                  output: 0,
                  reasoning: 0,
                  cache: { read: 10000, write: 0 },
                },
              },
            },
          },
        })

        await hook["tool.execute.after"](
          { tool: "bash", sessionID, callID: "call_timeout_2" },
          { title: "", output: "test", metadata: null },
        )

        //#then - should have retried after cooldown
        expect(ctx.client.session.summarize).toHaveBeenCalledTimes(2)
      } finally {
        Date.now = originalNow
      }
    } finally {
      restoreTimeouts()
    }
  })

  it("should not immediately recompact after a long successful compaction completes", async () => {
    const hook = createPreemptiveCompactionHook(ctx as never, {} as never)
    const sessionID = "ses_no_immediate_recompact"
    const originalNow = Date.now
    let now = 0

    Date.now = () => now

    try {
      await hook.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              role: "assistant",
              sessionID,
              providerID: "anthropic",
              modelID: "claude-sonnet-4-6",
              finish: true,
              tokens: {
                input: 170000,
                output: 0,
                reasoning: 0,
                cache: { read: 10000, write: 0 },
              },
            },
          },
        },
      })

      await hook["tool.execute.after"](
        { tool: "bash", sessionID, callID: "call_1" },
        { title: "", output: "test", metadata: null }
      )

      expect(ctx.client.session.summarize).toHaveBeenCalledTimes(1)

      now = 121_000

      await hook.event({
        event: {
          type: "session.compacted",
          properties: { sessionID },
        },
      })

      await hook.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              role: "assistant",
              sessionID,
              providerID: "anthropic",
              modelID: "claude-sonnet-4-6",
              finish: true,
              tokens: {
                input: 170000,
                output: 0,
                reasoning: 0,
                cache: { read: 10000, write: 0 },
              },
            },
          },
        },
      })

      now = 122_000

      await hook.event({
        event: {
          type: "session.idle",
          properties: { sessionID },
        },
      })

      expect(ctx.client.session.summarize).toHaveBeenCalledTimes(1)
    } finally {
      Date.now = originalNow
    }
  })

  it("should allow re-compaction only after meaningful post-compaction token growth", async () => {
    const hook = createPreemptiveCompactionHook(ctx as never, {} as never)
    const sessionID = "ses_recompact_after_growth"
    const originalNow = Date.now
    let now = 0

    Date.now = () => now

    try {
      await hook.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              role: "assistant",
              sessionID,
              providerID: "anthropic",
              modelID: "claude-sonnet-4-6",
              finish: true,
              tokens: {
                input: 170000,
                output: 0,
                reasoning: 0,
                cache: { read: 10000, write: 0 },
              },
            },
          },
        },
      })

      await hook["tool.execute.after"](
        { tool: "bash", sessionID, callID: "call_1" },
        { title: "", output: "test", metadata: null }
      )

      expect(ctx.client.session.summarize).toHaveBeenCalledTimes(1)

      now = 121_000

      await hook.event({
        event: {
          type: "session.compacted",
          properties: { sessionID },
        },
      })

      await hook.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              role: "assistant",
              sessionID,
              providerID: "anthropic",
              modelID: "claude-sonnet-4-6",
              finish: true,
              tokens: {
                input: 170000,
                output: 0,
                reasoning: 0,
                cache: { read: 10000, write: 0 },
              },
            },
          },
        },
      })

      now = 182_000

      await hook.event({
        event: {
          type: "message.updated",
          properties: {
            info: {
              role: "assistant",
              sessionID,
              providerID: "anthropic",
              modelID: "claude-sonnet-4-6",
              finish: true,
              tokens: {
                input: 195000,
                output: 0,
                reasoning: 0,
                cache: { read: 10000, write: 0 },
              },
            },
          },
        },
      })

      await hook["tool.execute.after"](
        { tool: "bash", sessionID, callID: "call_2" },
        { title: "", output: "test", metadata: null }
      )

      expect(ctx.client.session.summarize).toHaveBeenCalledTimes(2)
    } finally {
      Date.now = originalNow
    }
  })

  // #given modelContextLimitsCache has model-specific limit (256k)
  // #when tokens are above the 200k threshold but below 68% of 256k
  // #then should NOT trigger compaction
  it("should use model-specific context limit from modelContextLimitsCache", async () => {
    const modelContextLimitsCache = new Map<string, number>()
    modelContextLimitsCache.set("opencode/kimi-k2.5-free", 262144)

    const hook = createPreemptiveCompactionHook(ctx as never, {} as never, {
      anthropicContext1MEnabled: false,
      modelContextLimitsCache,
    })
    const sessionID = "ses_kimi_limit"

    // 170k total tokens -> above 68% of 200k (136k) but below 68% of 256k (~178k)
    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            role: "assistant",
            sessionID,
            providerID: "opencode",
            modelID: "kimi-k2.5-free",
            finish: true,
            tokens: {
              input: 160000,
              output: 0,
              reasoning: 0,
              cache: { read: 10000, write: 0 },
            },
          },
        },
      },
    })

    await hook["tool.execute.after"](
      { tool: "bash", sessionID, callID: "call_1" },
      { title: "", output: "test", metadata: null }
    )

    expect(ctx.client.session.summarize).not.toHaveBeenCalled()
  })

  // #given modelContextLimitsCache has model-specific limit (256k)
  // #when tokens exceed 68% of the model-specific limit
  // #then should trigger compaction
  it("should trigger compaction at model-specific threshold", async () => {
    const modelContextLimitsCache = new Map<string, number>()
    modelContextLimitsCache.set("opencode/kimi-k2.5-free", 262144)

    const hook = createPreemptiveCompactionHook(ctx as never, {} as never, {
      anthropicContext1MEnabled: false,
      modelContextLimitsCache,
    })
    const sessionID = "ses_kimi_trigger"

    // 210k total -> above 68% of 256k (~178k)
    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            role: "assistant",
            sessionID,
            providerID: "opencode",
            modelID: "kimi-k2.5-free",
            finish: true,
            tokens: {
              input: 200000,
              output: 0,
              reasoning: 0,
              cache: { read: 10000, write: 0 },
            },
          },
        },
      },
    })

    await hook["tool.execute.after"](
      { tool: "bash", sessionID, callID: "call_1" },
      { title: "", output: "test", metadata: null }
    )

    expect(ctx.client.session.summarize).toHaveBeenCalled()
  })

  it("should use the earlier threshold for GPT-5.4 effective 250K context limits", async () => {
    const modelContextLimitsCache = new Map<string, number>()
    modelContextLimitsCache.set("openai/gpt-5.4", 1_000_000)

    const hook = createPreemptiveCompactionHook(ctx as never, {} as never, {
      anthropicContext1MEnabled: false,
      modelContextLimitsCache,
    })
    const sessionID = "ses_gpt54_early_trigger"

    // 170k total -> 68% of the effective 250k cap, should trigger early compaction.
    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            role: "assistant",
            sessionID,
            providerID: "openai",
            modelID: "gpt-5.4",
            finish: true,
            tokens: {
              input: 160000,
              output: 0,
              reasoning: 0,
              cache: { read: 10000, write: 0 },
            },
          },
        },
      },
    })

    await hook["tool.execute.after"](
      { tool: "bash", sessionID, callID: "call_1" },
      { title: "", output: "test", metadata: null },
    )

    expect(ctx.client.session.summarize).toHaveBeenCalled()
  })

  it("should not trigger GPT-5.4 compaction before the earlier effective threshold", async () => {
    const modelContextLimitsCache = new Map<string, number>()
    modelContextLimitsCache.set("openai/gpt-5.4", 1_000_000)

    const hook = createPreemptiveCompactionHook(ctx as never, {} as never, {
      anthropicContext1MEnabled: false,
      modelContextLimitsCache,
    })
    const sessionID = "ses_gpt54_below_trigger"

    // 150k total -> 60% of the effective 250k cap, should not trigger yet.
    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            role: "assistant",
            sessionID,
            providerID: "openai",
            modelID: "gpt-5.4",
            finish: true,
            tokens: {
              input: 145000,
              output: 0,
              reasoning: 0,
              cache: { read: 5000, write: 0 },
            },
          },
        },
      },
    })

    await hook["tool.execute.after"](
      { tool: "bash", sessionID, callID: "call_1" },
      { title: "", output: "test", metadata: null },
    )

    expect(ctx.client.session.summarize).not.toHaveBeenCalled()
  })

  it("should trigger compaction on session.idle when cached usage is already above threshold", async () => {
    const modelContextLimitsCache = new Map<string, number>()
    modelContextLimitsCache.set("openai/gpt-5.4", 1_000_000)

    const hook = createPreemptiveCompactionHook(ctx as never, {} as never, {
      anthropicContext1MEnabled: false,
      modelContextLimitsCache,
    })
    const sessionID = "ses_idle_trigger"

    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            role: "assistant",
            sessionID,
            providerID: "openai",
            modelID: "gpt-5.4",
            finish: true,
            tokens: {
              input: 160000,
              output: 0,
              reasoning: 0,
              cache: { read: 10000, write: 0 },
            },
          },
        },
      },
    })

    await hook.event({
      event: {
        type: "session.idle",
        properties: { sessionID },
      },
    })

    expect(ctx.client.session.summarize).toHaveBeenCalled()
  })

  it("should trigger compaction once configured absolute token threshold is reached", async () => {
    const hook = createPreemptiveCompactionHook(
      ctx as never,
      {
        experimental: {
          preemptive_compaction_input_tokens: 200000,
        },
      } as never,
      {
        anthropicContext1MEnabled: false,
      },
    )
    const sessionID = "ses_absolute_threshold"

    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            role: "assistant",
            sessionID,
            providerID: "openai",
            modelID: "gpt-5.4",
            finish: true,
            tokens: {
              input: 195000,
              output: 0,
              reasoning: 0,
              cache: { read: 8000, write: 0 },
            },
          },
        },
      },
    })

    await hook["tool.execute.after"](
      { tool: "bash", sessionID, callID: "call_absolute_threshold" },
      { title: "", output: "test", metadata: null },
    )

    expect(ctx.client.session.summarize).toHaveBeenCalled()
  })

  it("should ignore stale cached Anthropic limits for older models", async () => {
    const modelContextLimitsCache = new Map<string, number>()
    modelContextLimitsCache.set("anthropic/claude-sonnet-4-5", 500000)

    const hook = createPreemptiveCompactionHook(ctx as never, {} as never, {
      anthropicContext1MEnabled: false,
      modelContextLimitsCache,
    })
    const sessionID = "ses_old_anthropic_limit"

    await hook.event({
      event: {
        type: "message.updated",
        properties: {
          info: {
            role: "assistant",
            sessionID,
            providerID: "anthropic",
            modelID: "claude-sonnet-4-5",
            finish: true,
            tokens: {
              input: 170000,
              output: 0,
              reasoning: 0,
              cache: { read: 10000, write: 0 },
            },
          },
        },
      },
    })

    await hook["tool.execute.after"](
      { tool: "bash", sessionID, callID: "call_1" },
      { title: "", output: "test", metadata: null }
    )

    expect(ctx.client.session.summarize).toHaveBeenCalled()
  })
})
