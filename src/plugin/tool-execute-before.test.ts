const { describe, expect, test } = require("bun:test")
const { createToolExecuteBeforeHandler } = require("./tool-execute-before")
const { createToolRegistry } = require("./tool-registry")
const { builtinTools } = require("../tools")
const { mkdtempSync, mkdirSync, rmSync } = require("node:fs")
const { join } = require("node:path")
const { tmpdir } = require("node:os")
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

  test("blocks task in ci fast-path before forward progress", async () => {
    const sessionID = "ses_ci_task_before_progress"
    setSessionFlag(sessionID, "ci-fast-path")

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
        { tool: "task", sessionID, callID: "call_task_before_progress" },
        { args: { prompt: "consult oracle" } as Record<string, unknown> },
      ),
    ).rejects.toThrow('Tool "task" is blocked for CI fast-path session')

    clearSessionTools()
  })

  test("allows task in ci fast-path after forward progress", async () => {
    const sessionID = "ses_ci_task_after_progress"
    setSessionFlag(sessionID, "ci-fast-path")
    setSessionFlag(sessionID, "ci-forward-progress")

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
        { tool: "task", sessionID, callID: "call_task_after_progress" },
        { args: { prompt: "claude review" } as Record<string, unknown> },
      ),
    ).resolves.toBeUndefined()

    clearSessionTools()
  })

  test("blocks skill in ci fast-path even without stored session tools", async () => {
    const sessionID = "ses_ci_skill_block"
    setSessionFlag(sessionID, "ci-fast-path")

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
        { tool: "skill", sessionID, callID: "call_skill_block" },
        { args: { name: "/review-work" } as Record<string, unknown> },
      ),
    ).rejects.toThrow('Tool "skill" is blocked for CI fast-path session')

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

  test("blocks read on directory paths", async () => {
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
        { tool: "read", sessionID: "ses_dir_read", callID: "call_dir_read" },
        { args: { filePath: "." } as Record<string, unknown> },
      ),
    ).rejects.toThrow("Refusing read on a directory")
  })

  test("blocks legacy evidence alias reads in CI fast-path", async () => {
    const sessionID = "ses_ci_legacy_alias"

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
        { tool: "read", sessionID, callID: "call_legacy_alias" },
        { args: { filePath: "/repo/.sisyphus/ci-loop-checkpoint.md" } as Record<string, unknown> },
      ),
    ).rejects.toThrow("Refusing legacy .sisyphus evidence alias read")

    clearSessionTools()
  })

  test("blocks core evidence rereads after dirty-batch inspection and before forward progress", async () => {
    const sessionID = "ses_ci_core_reread_lock"
    setSessionFlag(sessionID, "ci-evidence-core-read")
    setSessionFlag(sessionID, "ci-dirty-batch-inspected")

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
        { tool: "read", sessionID, callID: "call_core_reread" },
        { args: { filePath: "/repo/.sisyphus/evidence/repair-log.md" } as Record<string, unknown> },
      ),
    ).rejects.toThrow("Core CI evidence rereads are blocked")

    clearSessionTools()
  })

  test("allows core evidence rereads after forward progress is recorded", async () => {
    const sessionID = "ses_ci_core_reread_after_progress"
    setSessionFlag(sessionID, "ci-evidence-core-read")
    setSessionFlag(sessionID, "ci-dirty-batch-inspected")
    setSessionFlag(sessionID, "ci-forward-progress")

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
        { tool: "read", sessionID, callID: "call_core_reread_after_progress" },
        { args: { filePath: "/repo/.sisyphus/evidence/repair-log.md" } as Record<string, unknown> },
      ),
    ).resolves.toBeUndefined()

    clearSessionTools()
  })

  test("records dirty-batch inspection and then blocks a repeated core evidence read", async () => {
    const sessionID = "ses_ci_dirty_then_reread"

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
        { tool: "read", sessionID, callID: "call_initial_core_read" },
        { args: { filePath: "/repo/.sisyphus/evidence/ci-loop-checkpoint.md" } as Record<string, unknown> },
      ),
    ).resolves.toBeUndefined()

    await expect(
      handler(
        { tool: "bash", sessionID, callID: "call_dirty_batch_inspect" },
        { args: { command: "git status --short && git diff -- Optimizer.PlaywrightTests" } as Record<string, unknown> },
      ),
    ).resolves.toBeUndefined()

    await expect(
      handler(
        { tool: "read", sessionID, callID: "call_blocked_core_reread" },
        { args: { filePath: "/repo/.sisyphus/evidence/build-332-analysis.md" } as Record<string, unknown> },
      ),
    ).rejects.toThrow("Core CI evidence rereads are blocked")

    clearSessionTools()
  })

  test("does not treat evidence ls commands as evidence materialization writes", async () => {
    const sessionID = "ses_ci_evidence_ls_only"
    setSessionFlag(sessionID, "ci-fast-path")

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
        { tool: "bash", sessionID, callID: "call_evidence_ls" },
        { args: { command: "ls .sisyphus/evidence/tests/ | head -20" } as Record<string, unknown> },
      ),
    ).resolves.toBeUndefined()

    await expect(
      handler(
        { tool: "read", sessionID, callID: "call_tracker_after_ls" },
        { args: { filePath: "/repo/.sisyphus/evidence/tests/Scenario.md" } as Record<string, unknown> },
      ),
    ).resolves.toBeUndefined()

    clearSessionTools()
  })

  test("blocks repeated dirty-batch code rereads after the same file is read too many times", async () => {
    const sessionID = "ses_ci_reread_cap"
    setSessionFlag(sessionID, "ci-fast-path")
    setSessionFlag(sessionID, "ci-dirty-batch-inspected")

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

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(
        handler(
          { tool: "read", sessionID, callID: `call_code_read_${attempt}` },
          { args: { filePath: "/repo/Optimizer.PlaywrightTests/TaskGroupExecutionE2ETests.cs" } as Record<string, unknown> },
        ),
      ).resolves.toBeUndefined()
    }

    await expect(
      handler(
        { tool: "read", sessionID, callID: "call_code_read_5" },
        { args: { filePath: "/repo/Optimizer.PlaywrightTests/TaskGroupExecutionE2ETests.cs" } as Record<string, unknown> },
      ),
    ).rejects.toThrow("Repeated dirty-batch code rereads are blocked")

    clearSessionTools()
  })

  test("clears dirty-batch reread caps after forward progress", async () => {
    const sessionID = "ses_ci_reread_after_progress"
    setSessionFlag(sessionID, "ci-fast-path")
    setSessionFlag(sessionID, "ci-dirty-batch-inspected")

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

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await handler(
        { tool: "read", sessionID, callID: `call_code_reset_${attempt}` },
        { args: { filePath: "/repo/Optimizer.PlaywrightTests/UserAdministrationE2ETests.cs" } as Record<string, unknown> },
      )
    }

    await handler(
      { tool: "bash", sessionID, callID: "call_progress" },
      { args: { command: "dotnet build Optimizer.PlaywrightTests/Optimizer.PlaywrightTests.csproj --nologo" } as Record<string, unknown> },
    )

    await expect(
      handler(
        { tool: "read", sessionID, callID: "call_code_after_progress" },
        { args: { filePath: "/repo/Optimizer.PlaywrightTests/UserAdministrationE2ETests.cs" } as Record<string, unknown> },
      ),
    ).resolves.toBeUndefined()

    clearSessionTools()
  })

  test("blocks evidence-only git diff reflection after dirty-batch inspection and before forward progress", async () => {
    const sessionID = "ses_ci_evidence_diff_reflection"
    setSessionFlag(sessionID, "ci-evidence-core-read")
    setSessionFlag(sessionID, "ci-dirty-batch-inspected")

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
        { tool: "bash", sessionID, callID: "call_evidence_diff_reflection" },
        { args: { command: "git diff -- .sisyphus/evidence/ci-loop-checkpoint.md .sisyphus/evidence/repair-log.md" } as Record<string, unknown> },
      ),
    ).rejects.toThrow("Evidence reflection loops are blocked")

    clearSessionTools()
  })

  test("blocks opencode tool-output reflection after dirty-batch inspection and before forward progress", async () => {
    const sessionID = "ses_ci_tool_output_reflection"
    setSessionFlag(sessionID, "ci-evidence-core-read")
    setSessionFlag(sessionID, "ci-dirty-batch-inspected")

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
        { tool: "read", sessionID, callID: "call_tool_output_reflection" },
        { args: { filePath: "/Users/me/.local/share/opencode/tool-output/tool_deadbeef" } as Record<string, unknown> },
      ),
    ).rejects.toThrow("Evidence reflection loops are blocked")

    clearSessionTools()
  })

  test("blocks historical .sisyphus/notepads reads after core evidence pass and before forward progress", async () => {
    const sessionID = "ses_ci_notepad_history_read"
    setSessionFlag(sessionID, "ci-evidence-core-read")
    setSessionFlag(sessionID, "ci-dirty-batch-inspected")

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
        { tool: "read", sessionID, callID: "call_notepad_history_read" },
        { args: { filePath: "/repo/.sisyphus/notepads/ci-green-build313-final/learnings.md" } as Record<string, unknown> },
      ),
    ).rejects.toThrow("Historical .sisyphus note reads are blocked")

    clearSessionTools()
  })

  test("allows product-code git diff after dirty-batch inspection and before forward progress", async () => {
    const sessionID = "ses_ci_product_diff_allowed"
    setSessionFlag(sessionID, "ci-evidence-core-read")
    setSessionFlag(sessionID, "ci-dirty-batch-inspected")

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
        { tool: "bash", sessionID, callID: "call_product_diff_allowed" },
        { args: { command: "git diff -- Optimizer.PlaywrightTests/ScenarioE2ETests.cs" } as Record<string, unknown> },
      ),
    ).resolves.toBeUndefined()

    clearSessionTools()
  })

  test("blocks broad multi-file dirty-batch git diff output in CI fast-path", async () => {
    const sessionID = "ses_ci_broad_dirty_diff"
    setSessionFlag(sessionID, "ci-fast-path")

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
        { tool: "bash", sessionID, callID: "call_broad_dirty_diff" },
        {
          args: {
            command: "git diff -- Optimizer.PlaywrightTests/CalculationSessionsE2ETests.cs Optimizer.PlaywrightTests/ReportFormTemplatesE2ETests.cs Optimizer.PlaywrightTests/ScenarioE2ETests.cs Optimizer.PlaywrightTests/TaskGroupExecutionE2ETests.cs Optimizer.PlaywrightTests/UserAdministrationE2ETests.cs",
          } as Record<string, unknown>,
        },
      ),
    ).rejects.toThrow("Broad dirty-batch git diff output is blocked")

    clearSessionTools()
  })

  test("blocks broad multi-file dirty-batch git diff output after core evidence pass even without fast-path flag", async () => {
    const sessionID = "ses_ci_broad_diff_after_evidence"
    setSessionFlag(sessionID, "ci-evidence-core-read")

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
        { tool: "bash", sessionID, callID: "call_broad_dirty_diff_after_evidence" },
        {
          args: {
            command: "git diff --unified=0 -- Optimizer.PlaywrightTests/CalculationSessionsE2ETests.cs Optimizer.PlaywrightTests/ReportFormTemplatesE2ETests.cs Optimizer.PlaywrightTests/ScenarioE2ETests.cs Optimizer.PlaywrightTests/TaskGroupExecutionE2ETests.cs Optimizer.PlaywrightTests/UserAdministrationE2ETests.cs",
          } as Record<string, unknown>,
        },
      ),
    ).rejects.toThrow("Broad dirty-batch git diff output is blocked")

    clearSessionTools()
  })

  test("blocks historical Playwright verify artifact reads when a newer iteration already exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "omo-historical-verify-"))
    const iteration13 = join(root, "Optimizer.PlaywrightTests/TestResults/iteration13")
    const iteration15 = join(root, "Optimizer.PlaywrightTests/TestResults/iteration15")
    mkdirSync(iteration13, { recursive: true })
    mkdirSync(iteration15, { recursive: true })

    try {
      const sessionID = "ses_historical_verify_read"
      setSessionFlag(sessionID, "ci-evidence-core-read")
      setSessionFlag(sessionID, "ci-dirty-batch-inspected")

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
          { tool: "read", sessionID, callID: "call_historical_verify_read" },
          {
            args: {
              filePath: join(iteration13, "local-verify-iteration13-host.trx"),
            } as Record<string, unknown>,
          },
        ),
      ).rejects.toThrow("Historical local verify artifact read is blocked")
    } finally {
      rmSync(root, { recursive: true, force: true })
      clearSessionTools()
    }
  })

  test("allows narrow or summary dirty-batch git diff inspection in CI fast-path", async () => {
    const sessionID = "ses_ci_narrow_dirty_diff"
    setSessionFlag(sessionID, "ci-fast-path")

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
        { tool: "bash", sessionID, callID: "call_narrow_dirty_diff" },
        {
          args: {
            command: "git diff --stat -- Optimizer.PlaywrightTests/CalculationSessionsE2ETests.cs Optimizer.PlaywrightTests/ReportFormTemplatesE2ETests.cs Optimizer.PlaywrightTests/ScenarioE2ETests.cs Optimizer.PlaywrightTests/TaskGroupExecutionE2ETests.cs Optimizer.PlaywrightTests/UserAdministrationE2ETests.cs",
          } as Record<string, unknown>,
        },
      ),
    ).resolves.toBeUndefined()

    clearSessionTools()
  })

  test("blocks Playwright project dotnet test without provisioned contour env or generated instance source", async () => {
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
        { tool: "bash", sessionID: "ses_playwright_missing_contour", callID: "call_playwright_missing_contour" },
        {
          args: {
            command: "/opt/homebrew/opt/dotnet@8/libexec/dotnet test Optimizer.PlaywrightTests/Optimizer.PlaywrightTests.csproj --nologo --filter '(FullyQualifiedName~Foo)'",
          } as Record<string, unknown>,
        },
      ),
    ).rejects.toThrow("Refusing Playwright test run")
  })

  test("allows Playwright project dotnet test when provisioned contour env is exported inline", async () => {
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
        { tool: "bash", sessionID: "ses_playwright_inline_env", callID: "call_playwright_inline_env" },
        {
          args: {
            command: "export OPTIEX_PLAYWRIGHT_BASE_URL=http://localhost:5055 OPTIEX_PLAYWRIGHT_CONF_CONNECTION_STRING='Data Source=localhost' && EXPECTED_TEST_COUNT=8 && RESULTS_DIR='Optimizer.PlaywrightTests/TestResults/iterationX' && TRX_NAME='iterationX.trx' && echo 'RERUN_PRECHECK start' && ps -axo pid,etime,command | rg 'dotnet test|testhost|headless_shell|run-driver' || true && pkill -f 'Optimizer.PlaywrightTests.*testhost.dll|playwright/package/cli.js run-driver|headless_shell.*playwright_chromiumdev_profile' || true && python3 - <<'PY'\nimport xml.etree.ElementTree as ET\nprint('RERUN_START')\nprint('TRX parser ready for UnitTestResult coverage checks')\nprint('RERUN_END')\nprint('RERUN_HEARTBEAT bootstrap')\nPY\n&& (while kill -0 \"$TEST_PID\" 2>/dev/null; do echo \"RERUN_HEARTBEAT waiting for trx\"; sleep 30; done) & TEST_PID=$! && perl -e 'alarm shift; exec @ARGV' 900 /opt/homebrew/opt/dotnet@8/libexec/dotnet test Optimizer.PlaywrightTests/Optimizer.PlaywrightTests.csproj --nologo --logger \"trx;LogFileName=$TRX_NAME\" --results-directory \"$RESULTS_DIR\"",
          } as Record<string, unknown>,
        },
      ),
    ).resolves.toBeUndefined()
  })

  test("allows Playwright project dotnet test when generated TestAppInstances source is referenced", async () => {
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
        { tool: "bash", sessionID: "ses_playwright_generated_source", callID: "call_playwright_generated_source" },
        {
          args: {
            command: "test -f Optimizer.WebSiteTests/generated/TestAppInstances.json && EXPECTED=8 && RESULTS_DIR='Optimizer.PlaywrightTests/TestResults/iterationX' && TRX_NAME='iterationX.trx' && echo 'RERUN_PRECHECK start' && pgrep -fal 'Optimizer.PlaywrightTests.*testhost.dll|playwright/package/cli.js run-driver|headless_shell' || true && pkill -f 'Optimizer.PlaywrightTests.*testhost.dll|playwright/package/cli.js run-driver|headless_shell.*playwright_chromiumdev_profile' || true && python3 - <<'PY'\nimport xml.etree.ElementTree as ET\nprint('RERUN_START')\nprint('UnitTestResult parse ready')\nprint('RERUN_END')\nprint('RERUN_HEARTBEAT bootstrap')\nPY\n&& (while kill -0 \"$TEST_PID\" 2>/dev/null; do echo \"RERUN_HEARTBEAT waiting for trx\"; sleep 30; done) & TEST_PID=$! && perl -e 'alarm shift; exec @ARGV' 900 /opt/homebrew/opt/dotnet@8/libexec/dotnet test Optimizer.PlaywrightTests/Optimizer.PlaywrightTests.csproj --nologo --logger \"trx;LogFileName=$TRX_NAME\" --results-directory \"$RESULTS_DIR\"",
          } as Record<string, unknown>,
        },
      ),
    ).resolves.toBeUndefined()
  })

  test("allows Playwright project dotnet test when rerun coverage accounting is expressed via rerun_expected_tests", async () => {
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
        { tool: "bash", sessionID: "ses_playwright_rerun_expected_tests", callID: "call_playwright_rerun_expected_tests" },
        {
          args: {
            command: "export OPTIEX_PLAYWRIGHT_BASE_URL=http://localhost:5055 OPTIEX_PLAYWRIGHT_CONF_CONNECTION_STRING='Data Source=localhost' OPTIEX_PLAYWRIGHT_DATA_CONNECTION_STRING='Data Source=localhost' RERUN_EXPECTED_TESTS=8 RESULTS_DIR='Optimizer.PlaywrightTests/TestResults/iterationX' TRX_NAME='iterationX.trx' RERUN_TRX_PATH=\"$RESULTS_DIR/$TRX_NAME\" && echo 'RERUN_PRECHECK start' && pgrep -fal 'Optimizer.PlaywrightTests.*testhost.dll|playwright/package/cli.js run-driver|headless_shell' || true && pkill -f 'Optimizer.PlaywrightTests.*testhost.dll|playwright/package/cli.js run-driver|headless_shell.*playwright_chromiumdev_profile' || true && python3 - <<'PY'\nimport xml.etree.ElementTree as ET\nprint('RERUN_START')\nprint('UnitTestResult parse ready')\nprint('RERUN_END')\nprint('RERUN_HEARTBEAT bootstrap')\nprint('RERUN_EXPECTED_TESTS=' + '8')\nPY\n&& (while kill -0 \"$TEST_PID\" 2>/dev/null; do echo \"RERUN_HEARTBEAT waiting for trx\"; sleep 30; done) & TEST_PID=$! && python3 - <<'PY'\nimport subprocess\nprint('timeout=900')\nprint('python3 timeout wrapper ready')\nPY\n&& /opt/homebrew/opt/dotnet@8/libexec/dotnet test Optimizer.PlaywrightTests/Optimizer.PlaywrightTests.csproj --nologo --logger \"trx;LogFileName=$TRX_NAME\" --results-directory \"$RESULTS_DIR\" && python3 - <<'PY'\nimport os, xml.etree.ElementTree as ET\nprint('UnitTestResult parse ready for', os.environ.get('RERUN_TRX_PATH', ''))\nPY",
          } as Record<string, unknown>,
        },
      ),
    ).resolves.toBeUndefined()
  })

  test("allows bounded Playwright rerun immediately after a dedicated stale-runner preflight step", async () => {
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

    const previousPsOutput = process.env.OMO_TEST_PS_OUTPUT
    process.env.OMO_TEST_PS_OUTPUT = ""
    try {
      await expect(
        handler(
          { tool: "bash", sessionID: "ses_playwright_split_preflight", callID: "call_playwright_split_preflight_1" },
          {
            args: {
              command: "export SELF=$$ && echo 'RERUN_PRECHECK start' && ps -ax -o pid=,command= | rg 'dotnet test|testhost|headless_shell|run-driver' || true && pkill -f 'Optimizer.PlaywrightTests.*testhost.dll|playwright/package/cli.js run-driver|headless_shell.*playwright_chromiumdev_profile' || true && echo 'RERUN_START phase=preflight' && echo 'RERUN_END phase=preflight'",
            } as Record<string, unknown>,
          },
        ),
      ).resolves.toBeUndefined()

      await expect(
        handler(
          { tool: "bash", sessionID: "ses_playwright_split_preflight", callID: "call_playwright_split_preflight_2" },
          {
            args: {
              command: "export OPTIEX_PLAYWRIGHT_BASE_URL=http://localhost:5055 OPTIEX_PLAYWRIGHT_CONF_CONNECTION_STRING='Data Source=localhost' OPTIEX_PLAYWRIGHT_DATA_CONNECTION_STRING='Data Source=localhost' RERUN_EXPECTED_TESTS=8 RESULTS_DIR='Optimizer.PlaywrightTests/TestResults/iterationX' TRX_NAME='iterationX.trx' RERUN_TRX_PATH=\"$RESULTS_DIR/$TRX_NAME\" && python3 - <<'PY'\nimport xml.etree.ElementTree as ET\nprint('RERUN_START')\nprint('UnitTestResult parse ready')\nprint('RERUN_END')\nprint('RERUN_HEARTBEAT bootstrap')\nprint('RERUN_EXPECTED_TESTS=' + '8')\nPY\n&& (while kill -0 \"$TEST_PID\" 2>/dev/null; do echo \"RERUN_HEARTBEAT waiting for trx\"; sleep 30; done) & TEST_PID=$! && perl -e 'alarm shift; exec @ARGV' 900 /opt/homebrew/opt/dotnet@8/libexec/dotnet test Optimizer.PlaywrightTests/Optimizer.PlaywrightTests.csproj --nologo --logger \"trx;LogFileName=$TRX_NAME\" --results-directory \"$RESULTS_DIR\" && python3 - <<'PY'\nimport os, xml.etree.ElementTree as ET\nprint('UnitTestResult parse ready for', os.environ.get('RERUN_TRX_PATH', ''))\nPY",
            } as Record<string, unknown>,
          },
        ),
      ).resolves.toBeUndefined()
    } finally {
      if (previousPsOutput === undefined) {
        delete process.env.OMO_TEST_PS_OUTPUT
      } else {
        process.env.OMO_TEST_PS_OUTPUT = previousPsOutput
      }
    }
  })

  test("blocks bounded Playwright rerun after a dedicated preflight when live runners still exist", async () => {
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

    const previousPsOutput = process.env.OMO_TEST_PS_OUTPUT
    process.env.OMO_TEST_PS_OUTPUT = "28723 dotnet test Optimizer.PlaywrightTests/Optimizer.PlaywrightTests.csproj --results-directory Optimizer.PlaywrightTests/TestResults/iteration17"

    try {
      await expect(
        handler(
          { tool: "bash", sessionID: "ses_playwright_split_preflight_stale", callID: "call_playwright_split_preflight_stale_1" },
          {
            args: {
              command: "export SELF=$$ && echo 'RERUN_PRECHECK start' && ps -ax -o pid=,command= | rg 'dotnet test|testhost|headless_shell|run-driver' || true && pkill -f 'Optimizer.PlaywrightTests.*testhost.dll|playwright/package/cli.js run-driver|headless_shell.*playwright_chromiumdev_profile' || true && echo 'RERUN_START phase=preflight' && echo 'RERUN_END phase=preflight'",
            } as Record<string, unknown>,
          },
        ),
      ).resolves.toBeUndefined()

      await expect(
        handler(
          { tool: "bash", sessionID: "ses_playwright_split_preflight_stale", callID: "call_playwright_split_preflight_stale_2" },
          {
            args: {
              command: "export OPTIEX_PLAYWRIGHT_BASE_URL=http://localhost:5055 OPTIEX_PLAYWRIGHT_CONF_CONNECTION_STRING='Data Source=localhost' OPTIEX_PLAYWRIGHT_DATA_CONNECTION_STRING='Data Source=localhost' RERUN_EXPECTED_TESTS=8 RESULTS_DIR='Optimizer.PlaywrightTests/TestResults/iterationX' TRX_NAME='iterationX.trx' RERUN_TRX_PATH=\"$RESULTS_DIR/$TRX_NAME\" && python3 - <<'PY'\nimport xml.etree.ElementTree as ET\nprint('RERUN_START')\nprint('UnitTestResult parse ready')\nprint('RERUN_END')\nprint('RERUN_HEARTBEAT bootstrap')\nprint('RERUN_EXPECTED_TESTS=' + '8')\nPY\n&& (while kill -0 \"$TEST_PID\" 2>/dev/null; do echo \"RERUN_HEARTBEAT waiting for trx\"; sleep 30; done) & TEST_PID=$! && perl -e 'alarm shift; exec @ARGV' 900 /opt/homebrew/opt/dotnet@8/libexec/dotnet test Optimizer.PlaywrightTests/Optimizer.PlaywrightTests.csproj --nologo --logger \"trx;LogFileName=$TRX_NAME\" --results-directory \"$RESULTS_DIR\" && python3 - <<'PY'\nimport os, xml.etree.ElementTree as ET\nprint('UnitTestResult parse ready for', os.environ.get('RERUN_TRX_PATH', ''))\nPY",
            } as Record<string, unknown>,
          },
        ),
      ).rejects.toThrow("did not clear the live eurochemeopt/playwright runner set")
    } finally {
      if (previousPsOutput === undefined) {
        delete process.env.OMO_TEST_PS_OUTPUT
      } else {
        process.env.OMO_TEST_PS_OUTPUT = previousPsOutput
      }
    }
  })

  test("blocks Playwright project dotnet test without bounded rerun markers and hard timeout wrapper", async () => {
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
        { tool: "bash", sessionID: "ses_playwright_unbounded", callID: "call_playwright_unbounded" },
        {
          args: {
            command: "export OPTIEX_PLAYWRIGHT_BASE_URL=http://localhost:5055 OPTIEX_PLAYWRIGHT_CONF_CONNECTION_STRING='Data Source=localhost' && /opt/homebrew/opt/dotnet@8/libexec/dotnet test Optimizer.PlaywrightTests/Optimizer.PlaywrightTests.csproj --nologo --filter '(FullyQualifiedName~Foo)'",
          } as Record<string, unknown>,
        },
      ),
    ).rejects.toThrow("without the bounded rerun markers")
  })

  test("blocks Playwright project dotnet test without hard timeout wrapper even when markers exist", async () => {
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
        { tool: "bash", sessionID: "ses_playwright_no_timeout", callID: "call_playwright_no_timeout" },
        {
          args: {
            command: "export OPTIEX_PLAYWRIGHT_BASE_URL=http://localhost:5055 OPTIEX_PLAYWRIGHT_CONF_CONNECTION_STRING='Data Source=localhost' && EXPECTED=8 && RESULTS_DIR='Optimizer.PlaywrightTests/TestResults/iterationX' && TRX_NAME='iterationX.trx' && python3 - <<'PY'\nimport xml.etree.ElementTree as ET\nprint('RERUN_START')\nprint('UnitTestResult parse ready')\nprint('RERUN_END')\nPY\n&& /opt/homebrew/opt/dotnet@8/libexec/dotnet test Optimizer.PlaywrightTests/Optimizer.PlaywrightTests.csproj --nologo --logger \"trx;LogFileName=$TRX_NAME\" --results-directory \"$RESULTS_DIR\"",
          } as Record<string, unknown>,
        },
      ),
    ).rejects.toThrow("without a hard timeout wrapper")
  })

  test("blocks Playwright project dotnet test without explicit expected-count and TRX coverage parse", async () => {
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
        { tool: "bash", sessionID: "ses_playwright_no_coverage_accounting", callID: "call_playwright_no_coverage_accounting" },
        {
          args: {
            command: "export OPTIEX_PLAYWRIGHT_BASE_URL=http://localhost:5055 OPTIEX_PLAYWRIGHT_CONF_CONNECTION_STRING='Data Source=localhost' && RESULTS_DIR='Optimizer.PlaywrightTests/TestResults/iterationX' && TRX_NAME='iterationX.trx' && python3 -c \"print('RERUN_START'); print('RERUN_END')\" && perl -e 'alarm shift; exec @ARGV' 900 /opt/homebrew/opt/dotnet@8/libexec/dotnet test Optimizer.PlaywrightTests/Optimizer.PlaywrightTests.csproj --nologo --logger \"trx;LogFileName=$TRX_NAME\" --results-directory \"$RESULTS_DIR\"",
          } as Record<string, unknown>,
        },
      ),
    ).rejects.toThrow("without explicit rerun coverage accounting")
  })

  test("blocks Playwright project dotnet test without observable heartbeat loop", async () => {
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
        { tool: "bash", sessionID: "ses_playwright_no_heartbeat", callID: "call_playwright_no_heartbeat" },
        {
          args: {
            command: "export OPTIEX_PLAYWRIGHT_BASE_URL=http://localhost:5055 OPTIEX_PLAYWRIGHT_CONF_CONNECTION_STRING='Data Source=localhost' && EXPECTED=8 && RESULTS_DIR='Optimizer.PlaywrightTests/TestResults/iterationX' && TRX_NAME='iterationX.trx' && echo 'RERUN_PRECHECK start' && pgrep -fal 'Optimizer.PlaywrightTests.*testhost.dll|playwright/package/cli.js run-driver|headless_shell' || true && pkill -f 'Optimizer.PlaywrightTests.*testhost.dll|playwright/package/cli.js run-driver|headless_shell.*playwright_chromiumdev_profile' || true && python3 - <<'PY'\nimport xml.etree.ElementTree as ET\nprint('RERUN_START')\nprint('UnitTestResult parse ready')\nprint('RERUN_END')\nPY\n&& perl -e 'alarm shift; exec @ARGV' 900 /opt/homebrew/opt/dotnet@8/libexec/dotnet test Optimizer.PlaywrightTests/Optimizer.PlaywrightTests.csproj --nologo --logger \"trx;LogFileName=$TRX_NAME\" --results-directory \"$RESULTS_DIR\"",
          } as Record<string, unknown>,
        },
      ),
    ).rejects.toThrow("without observable heartbeat logging")
  })

  test("blocks Playwright project dotnet test without stale-runner preflight", async () => {
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
        { tool: "bash", sessionID: "ses_playwright_no_precheck", callID: "call_playwright_no_precheck" },
        {
          args: {
            command: "export OPTIEX_PLAYWRIGHT_BASE_URL=http://localhost:5055 OPTIEX_PLAYWRIGHT_CONF_CONNECTION_STRING='Data Source=localhost' && EXPECTED=8 && RESULTS_DIR='Optimizer.PlaywrightTests/TestResults/iterationX' && TRX_NAME='iterationX.trx' && python3 - <<'PY'\nimport xml.etree.ElementTree as ET\nprint('RERUN_START')\nprint('UnitTestResult parse ready')\nprint('RERUN_END')\nprint('RERUN_HEARTBEAT bootstrap')\nPY\n&& (while kill -0 \"$TEST_PID\" 2>/dev/null; do echo \"RERUN_HEARTBEAT waiting for trx\"; sleep 30; done) & TEST_PID=$! && perl -e 'alarm shift; exec @ARGV' 900 /opt/homebrew/opt/dotnet@8/libexec/dotnet test Optimizer.PlaywrightTests/Optimizer.PlaywrightTests.csproj --nologo --logger \"trx;LogFileName=$TRX_NAME\" --results-directory \"$RESULTS_DIR\"",
          } as Record<string, unknown>,
        },
      ),
    ).rejects.toThrow("without stale-runner preflight")
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
    ).rejects.toThrow("Refusing direct Bamboo result endpoint fetches")
  })

  test("blocks direct python Bamboo result endpoint fetches without fetch_json", async () => {
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
        { tool: "bash", sessionID: "ses_bamboo_raw_python", callID: "call_bamboo_raw_python" },
        {
          args: {
            command: `python3 - <<'PY'
import urllib.request
print(urllib.request.urlopen("https://bamboo.suek.ru/rest/api/latest/result/EUROPT-DBWDICN0-332.json").read())
PY`,
          } as Record<string, unknown>,
        },
      ),
    ).rejects.toThrow("Refusing direct Bamboo result endpoint fetches")
  })

  test("blocks raw Bamboo JSON stdout even when fetch_json is defined", async () => {
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
        { tool: "bash", sessionID: "ses_bamboo_raw_stdout", callID: "call_bamboo_raw_stdout" },
        {
          args: {
            command: `fetch_json(){ curl -fsSL "$1"; }
fetch_json "https://bamboo.suek.ru/rest/api/latest/result/EUROPT-DBWDICN0/latest.json"`,
          } as Record<string, unknown>,
        },
      ),
    ).rejects.toThrow("Refusing raw Bamboo JSON stdout")
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

  test("blocks git push in CI fast-path before Claude review evidence is recorded", async () => {
    const sessionID = "ses_ci_push_needs_claude_review"
    setSessionFlag(sessionID, "ci-fast-path")

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
        { tool: "bash", sessionID, callID: "call_git_push_blocked" },
        { args: { command: "git push origin HEAD" } as Record<string, unknown> },
      ),
    ).rejects.toThrow("before a passing Claude review is recorded")

    clearSessionTools()
  })

  test("allows git push in CI fast-path after Claude review evidence is recorded", async () => {
    const sessionID = "ses_ci_push_with_claude_review"
    setSessionFlag(sessionID, "ci-fast-path")

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
        { tool: "write", sessionID, callID: "call_review_pass" },
        {
          args: {
            filePath: "/repo/.sisyphus/evidence/repair-log.md",
            content: "## Iteration 9\n- Claude review: PASS\n",
          } as Record<string, unknown>,
        },
      ),
    ).resolves.toBeUndefined()

    await expect(
      handler(
        { tool: "bash", sessionID, callID: "call_git_push_allowed" },
        { args: { command: "git push origin HEAD" } as Record<string, unknown> },
      ),
    ).resolves.toBeUndefined()

    clearSessionTools()
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
