const { describe, expect, test } = require("bun:test")
const { createToolExecuteBeforeHandler } = require("./tool-execute-before")
const { createToolRegistry } = require("./tool-registry")
const { builtinTools } = require("../tools")
const {
  clearSessionTools,
  setSessionTools,
  setSessionFlag,
} = require("../shared/session-tools-store")

describe("createToolExecuteBeforeHandler", () => {
  test("blocks task when session tools explicitly disable it", async () => {
    const sessionID = "ses_ci_block_task"
    setSessionTools(sessionID, { task: false })

    const handler = createToolExecuteBeforeHandler({
      ctx: {
        client: {
          session: {
            messages: async () => ({ data: [] }),
          },
        },
      },
      hooks: {},
    })

    await expect(
      handler(
        { tool: "task", sessionID, callID: "call_task" },
        { args: { prompt: "do work" } as Record<string, unknown> },
      ),
    ).rejects.toThrow(`Tool "task" is disabled for session ${sessionID}`)

    clearSessionTools()
  })

  test("blocks call_omo_agent when session tools explicitly disable it", async () => {
    const sessionID = "ses_ci_block_call_omo"
    setSessionTools(sessionID, { call_omo_agent: false })

    const handler = createToolExecuteBeforeHandler({
      ctx: {
        client: {
          session: {
            messages: async () => ({ data: [] }),
          },
        },
      },
      hooks: {},
    })

    await expect(
      handler(
        { tool: "call_omo_agent", sessionID, callID: "call_omo" },
        { args: { prompt: "delegate" } as Record<string, unknown> },
      ),
    ).rejects.toThrow(`Tool "call_omo_agent" is disabled for session ${sessionID}`)

    clearSessionTools()
  })

  test("blocks todowrite case-insensitively when session tools disable the lowercase name", async () => {
    const sessionID = "ses_ci_block_todowrite"
    setSessionTools(sessionID, { todowrite: false })

    const handler = createToolExecuteBeforeHandler({
      ctx: {
        client: {
          session: {
            messages: async () => ({ data: [] }),
          },
        },
      },
      hooks: {},
    })

    await expect(
      handler(
        { tool: "TodoWrite", sessionID, callID: "call_todowrite" },
        { args: { todos: [] } as Record<string, unknown> },
      ),
    ).rejects.toThrow(`Tool "TodoWrite" is disabled for session ${sessionID}`)

    clearSessionTools()
  })

  test("blocks empty bash commands before execution", async () => {
    const handler = createToolExecuteBeforeHandler({
      ctx: {
        client: {
          session: {
            messages: async () => ({ data: [] }),
          },
        },
      },
      hooks: {},
    })

    await expect(
      handler(
        { tool: "bash", sessionID: "ses_empty_bash", callID: "call_empty_bash" },
        { args: {} as Record<string, unknown> },
      ),
    ).rejects.toThrow('Refusing empty bash command for session ses_empty_bash')
  })

  test("blocks tracker rereads after CI evidence materialization", async () => {
    const sessionID = "ses_ci_tracker_lock"
    setSessionFlag(sessionID, "ci-evidence-materialized")

    const handler = createToolExecuteBeforeHandler({
      ctx: {
        client: {
          session: {
            messages: async () => ({ data: [] }),
          },
        },
      },
      hooks: {},
    })

    await expect(
      handler(
        { tool: "read", sessionID, callID: "call_read_tracker" },
        { args: { filePath: "/repo/.sisyphus/evidence/tests/Scenario.md" } as Record<string, unknown> },
      ),
    ).rejects.toThrow("Tracker evidence rereads are blocked")

    clearSessionTools()
  })

  test("allows non-tracker reads after CI evidence materialization", async () => {
    const sessionID = "ses_ci_non_tracker_read"
    setSessionFlag(sessionID, "ci-evidence-materialized")

    const handler = createToolExecuteBeforeHandler({
      ctx: {
        client: {
          session: {
            messages: async () => ({ data: [] }),
          },
        },
      },
      hooks: {},
    })

    await expect(
      handler(
        { tool: "read", sessionID, callID: "call_read_code" },
        { args: { filePath: "/repo/src/app.ts" } as Record<string, unknown> },
      ),
    ).resolves.toBeUndefined()

    clearSessionTools()
  })

  test("blocks direct curl to Bamboo result endpoints", async () => {
    const handler = createToolExecuteBeforeHandler({
      ctx: {
        client: {
          session: {
            messages: async () => ({ data: [] }),
          },
        },
      },
      hooks: {},
    })

    await expect(
      handler(
        { tool: "bash", sessionID: "ses_bamboo_raw_curl", callID: "call_bamboo_raw_curl" },
        {
          args: {
            command: 'curl -fsSL "https://bamboo.suek.ru/rest/api/latest/result/EUROPT-DBWDICN0/latest.json"',
          } as Record<string, unknown>,
        },
      ),
    ).rejects.toThrow("Refusing direct curl to Bamboo result endpoints")
  })

  test("blocks Bamboo browse-page scrapes", async () => {
    const handler = createToolExecuteBeforeHandler({
      ctx: {
        client: {
          session: {
            messages: async () => ({ data: [] }),
          },
        },
      },
      hooks: {},
    })

    await expect(
      handler(
        { tool: "bash", sessionID: "ses_bamboo_html_scrape", callID: "call_bamboo_html_scrape" },
        {
          args: {
            command: 'curl -fsSL "https://bamboo.suek.ru/browse/EUROPT-DBWDICN0-332"',
          } as Record<string, unknown>,
        },
      ),
    ).rejects.toThrow("Refusing Bamboo HTML scrape")
  })

  test("blocks Bamboo all-tests expansion", async () => {
    const handler = createToolExecuteBeforeHandler({
      ctx: {
        client: {
          session: {
            messages: async () => ({ data: [] }),
          },
        },
      },
      hooks: {},
    })

    await expect(
      handler(
        { tool: "bash", sessionID: "ses_bamboo_all_tests", callID: "call_bamboo_all_tests" },
        {
          args: {
            command: 'fetch_json "https://bamboo.suek.ru/rest/api/latest/result/EUROPT-DBWDICN0-332?expand=testResults.allTests"',
          } as Record<string, unknown>,
        },
      ),
    ).rejects.toThrow("Refusing Bamboo all-tests expansion")
  })

  test("allows Bamboo fetch_json commands with compact parsing", async () => {
    const handler = createToolExecuteBeforeHandler({
      ctx: {
        client: {
          session: {
            messages: async () => ({ data: [] }),
          },
        },
      },
      hooks: {},
    })

    await expect(
      handler(
        { tool: "bash", sessionID: "ses_bamboo_fetch_json", callID: "call_bamboo_fetch_json" },
        {
          args: {
            command: `fetch_json "https://bamboo.suek.ru/rest/api/latest/result/EUROPT-DBWDICN0/latest.json"
JSON="$(fetch_json "https://bamboo.suek.ru/rest/api/latest/result/EUROPT-DBWDICN0/latest.json")"
JSON="$JSON" python3 <<'PY'
import json, os
print(json.loads(os.environ["JSON"]).get("buildNumber"))
PY`,
          } as Record<string, unknown>,
        },
      ),
    ).resolves.toBeUndefined()
  })

  test("does not execute subagent question blocker hook for question tool", async () => {
    //#given
    const ctx = {
      client: {
        session: {
          messages: async () => ({ data: [] }),
        },
      },
    }

    const hooks = {
      subagentQuestionBlocker: {
        "tool.execute.before": async () => {
          throw new Error("subagentQuestionBlocker should not run")
        },
      },
    }

    const handler = createToolExecuteBeforeHandler({ ctx, hooks })
    const input = { tool: "question", sessionID: "ses_sub", callID: "call_1" }
    const output = { args: { questions: [] } as Record<string, unknown> }

    //#when
    const run = handler(input, output)

    //#then
    await expect(run).resolves.toBeUndefined()
  })

  test("triggers session notification hook for question tools", async () => {
    let called = false
    const ctx = {
      client: {
        session: {
          messages: async () => ({ data: [] }),
        },
      },
    }

    const hooks = {
      sessionNotification: async (input: { event: { type: string; properties?: Record<string, unknown> } }) => {
        called = true
        expect(input.event.type).toBe("tool.execute.before")
        expect(input.event.properties?.sessionID).toBe("ses_q")
        expect(input.event.properties?.tool).toBe("question")
      },
    }

    const handler = createToolExecuteBeforeHandler({ ctx, hooks })
    const input = { tool: "question", sessionID: "ses_q", callID: "call_q" }
    const output = { args: { questions: [{ question: "Proceed?", options: [{ label: "Yes" }] }] } as Record<string, unknown> }

    await handler(input, output)

    expect(called).toBe(true)
  })

  test("does not trigger session notification hook for non-question tools", async () => {
    let called = false
    const ctx = {
      client: {
        session: {
          messages: async () => ({ data: [] }),
        },
      },
    }

    const hooks = {
      sessionNotification: async () => {
        called = true
      },
    }

    const handler = createToolExecuteBeforeHandler({ ctx, hooks })

    await handler(
      { tool: "bash", sessionID: "ses_b", callID: "call_b" },
      { args: { command: "pwd" } as Record<string, unknown> },
    )

    expect(called).toBe(false)
  })

  describe("task tool subagent_type normalization", () => {
    const emptyHooks = {}

    function createCtxWithSessionMessages(messages: Array<{ info?: { agent?: string; role?: string } }> = []) {
      return {
        client: {
          session: {
            messages: async () => ({ data: messages }),
          },
        },
      }
    }

    test("sets subagent_type to sisyphus-junior when category is provided without subagent_type", async () => {
      //#given
      const ctx = createCtxWithSessionMessages()
      const handler = createToolExecuteBeforeHandler({ ctx, hooks: emptyHooks })
      const input = { tool: "task", sessionID: "ses_123", callID: "call_1" }
      const output = { args: { category: "quick", description: "Test" } as Record<string, unknown> }

      //#when
      await handler(input, output)

      //#then
      expect(output.args.subagent_type).toBe("sisyphus-junior")
    })

    test("preserves existing subagent_type when explicitly provided", async () => {
      //#given
      const ctx = createCtxWithSessionMessages()
      const handler = createToolExecuteBeforeHandler({ ctx, hooks: emptyHooks })
      const input = { tool: "task", sessionID: "ses_123", callID: "call_1" }
      const output = { args: { subagent_type: "plan", description: "Plan test" } as Record<string, unknown> }

      //#when
      await handler(input, output)

      //#then
      expect(output.args.subagent_type).toBe("plan")
    })

    test("sets subagent_type to sisyphus-junior when category provided with different subagent_type", async () => {
      //#given
      const ctx = createCtxWithSessionMessages()
      const handler = createToolExecuteBeforeHandler({ ctx, hooks: emptyHooks })
      const input = { tool: "task", sessionID: "ses_123", callID: "call_1" }
      const output = { args: { category: "quick", subagent_type: "oracle", description: "Test" } as Record<string, unknown> }

      //#when
      await handler(input, output)

      //#then
      expect(output.args.subagent_type).toBe("sisyphus-junior")
    })

    test("resolves subagent_type from session first message when session_id provided without subagent_type", async () => {
      //#given
      const ctx = createCtxWithSessionMessages([
        { info: { role: "user" } },
        { info: { role: "assistant", agent: "explore" } },
        { info: { role: "assistant", agent: "oracle" } },
      ])
      const handler = createToolExecuteBeforeHandler({ ctx, hooks: emptyHooks })
      const input = { tool: "task", sessionID: "ses_123", callID: "call_1" }
      const output = { args: { session_id: "ses_abc123", description: "Continue task", prompt: "fix it" } as Record<string, unknown> }

      //#when
      await handler(input, output)

      //#then
      expect(output.args.subagent_type).toBe("explore")
    })

    test("falls back to 'continue' when session has no agent info", async () => {
      //#given
      const ctx = createCtxWithSessionMessages([
        { info: { role: "user" } },
        { info: { role: "assistant" } },
      ])
      const handler = createToolExecuteBeforeHandler({ ctx, hooks: emptyHooks })
      const input = { tool: "task", sessionID: "ses_123", callID: "call_1" }
      const output = { args: { session_id: "ses_abc123", description: "Continue task", prompt: "fix it" } as Record<string, unknown> }

      //#when
      await handler(input, output)

      //#then
      expect(output.args.subagent_type).toBe("continue")
    })

    test("preserves subagent_type when session_id is provided with explicit subagent_type", async () => {
      //#given
      const ctx = createCtxWithSessionMessages()
      const handler = createToolExecuteBeforeHandler({ ctx, hooks: emptyHooks })
      const input = { tool: "task", sessionID: "ses_123", callID: "call_1" }
      const output = { args: { session_id: "ses_abc123", subagent_type: "explore", description: "Continue explore" } as Record<string, unknown> }

      //#when
      await handler(input, output)

      //#then
      expect(output.args.subagent_type).toBe("explore")
    })

    test("does not modify args for non-task tools", async () => {
      //#given
      const ctx = createCtxWithSessionMessages()
      const handler = createToolExecuteBeforeHandler({ ctx, hooks: emptyHooks })
      const input = { tool: "bash", sessionID: "ses_123", callID: "call_1" }
      const output = { args: { command: "ls" } as Record<string, unknown> }

      //#when
      await handler(input, output)

      //#then
      expect(output.args.subagent_type).toBeUndefined()
    })

    test("does not set subagent_type when neither category nor session_id is provided and subagent_type is present", async () => {
      //#given
      const ctx = createCtxWithSessionMessages()
      const handler = createToolExecuteBeforeHandler({ ctx, hooks: emptyHooks })
      const input = { tool: "task", sessionID: "ses_123", callID: "call_1" }
      const output = { args: { subagent_type: "oracle", description: "Oracle task" } as Record<string, unknown> }

      //#when
      await handler(input, output)

      //#then
      expect(output.args.subagent_type).toBe("oracle")
    })
  })
})

describe("createToolRegistry", () => {
  function createRegistryInput(overrides = {}) {
    return {
      ctx: {
        directory: process.cwd(),
        client: {},
      },
      pluginConfig: {
        ...overrides,
      },
      managers: {
        backgroundManager: {},
        tmuxSessionManager: {},
        skillMcpManager: {},
      },
      skillContext: {
        mergedSkills: [],
        availableSkills: [],
        browserProvider: "playwright",
        disabledSkills: new Set(),
      },
      availableCategories: [],
    }
  }

  describe("#given hashline_edit is undefined", () => {
    describe("#when creating tool registry", () => {
      test("#then should not register edit tool", () => {
        const result = createToolRegistry(createRegistryInput())

        expect(result.filteredTools.edit).toBeUndefined()
      })
    })
  })

  describe("#given hashline_edit is true", () => {
    describe("#when creating tool registry", () => {
      test("#then should register edit tool", () => {
        const result = createToolRegistry(
          createRegistryInput({
            hashline_edit: true,
          }),
        )

        expect(result.filteredTools.edit).toBeDefined()
      })
    })
  })

  describe("#given max_tools is lower than or equal to builtin tool count", () => {
    describe("#when creating the tool registry", () => {
      test("#then it trims to the exact configured cap", () => {
        const result = createToolRegistry(
          createRegistryInput({
            experimental: { max_tools: Object.keys(builtinTools).length },
          }),
        )

        expect(Object.keys(result.filteredTools)).toHaveLength(Object.keys(builtinTools).length)
      })
    })
  })

  describe("#given max_tools is set below the full plugin tool count", () => {
    describe("#when creating the tool registry", () => {
      test("#then it enforces the exact cap deterministically", () => {
        const result = createToolRegistry(
          createRegistryInput({
            experimental: { max_tools: 10 },
          }),
        )

        expect(Object.keys(result.filteredTools)).toHaveLength(10)
      })

      test("#then it keeps the task tool when lower-priority tools can satisfy the cap", () => {
        const result = createToolRegistry(
          createRegistryInput({
            experimental: { max_tools: 10 },
          }),
        )

        expect(result.filteredTools.task).toBeDefined()
      })
    })
  })
})

export {}
