import type { BuiltinSkill } from "../types"

export const dotnetPlaywrightSkill: BuiltinSkill = {
  name: "dotnet-playwright",
  description:
    "Expert .NET build, MSTest, and Playwright E2E testing skill with mandatory diagnostic logging. Use when writing, fixing, or analyzing Playwright tests in C#. Covers dotnet build, dotnet test, MSBuild errors, TRX results, CI test failures, DOM snapshot logging, state context logging, and rich assertion messages. Trigger: 'dotnet', 'MSBuild', 'Playwright', 'csproj', '.NET', 'NuGet', 'TRX', 'E2E test', 'test logging', 'test diagnostics'.",
  template: `# .NET Playwright Testing Skill

Expert knowledge for .NET solutions with Playwright E2E tests in CI/local environments.

## Build Commands

### Build Solution
\`\`\`bash
dotnet build {Solution}.sln --nologo
# If build fails, read the FULL error — MSBuild errors often have line:col references
\`\`\`

### Build Specific Project
\`\`\`bash
dotnet build {Project}/{Project}.csproj --nologo
\`\`\`

### Common MSBuild Errors
- \`MSB4038: element must be last under Target\` — XML ordering error in .targets file, check for duplicated Target blocks after merge
- \`CS0246: type or namespace not found\` — missing NuGet reference, run \`dotnet restore\`
- \`NU1100: unable to resolve package\` — NuGet source misconfigured, check \`NuGet.config\`

## Test Execution

### Run Full Test Suite
\`\`\`bash
dotnet test {TestProject}/{TestProject}.csproj --nologo
\`\`\`

### Run Filtered Tests
\`\`\`bash
# Single test method
dotnet test --filter "FullyQualifiedName~TestClassName.TestMethodName" --nologo

# Multiple tests (OR)
dotnet test --filter "FullyQualifiedName~Test1|FullyQualifiedName~Test2" --nologo

# Test class
dotnet test --filter "ClassName~ScenarioE2ETests" --nologo

# Exclude tests
dotnet test --filter "ClassName!~SlowTests" --nologo
\`\`\`

### Generate TRX Results
\`\`\`bash
dotnet test --logger "trx;LogFileName=results.trx" --nologo
# TRX is XML — parse with grep/python for test names and errors
\`\`\`

### List Tests Without Running
\`\`\`bash
dotnet test --list-tests --nologo
\`\`\`

## Playwright-Specific Patterns

### Browser Installation
\`\`\`bash
# Install Playwright browsers
pwsh -Command "playwright install chromium"
# Or via dotnet tool
dotnet tool install --global Microsoft.Playwright.CLI
playwright install chromium
\`\`\`

### Common Playwright Failure Patterns

#### TargetClosedException / Process Exited
- **Cause**: Browser process crashed during test
- **Root cause checklist**:
  1. Check \`[ClassInitialize]\` / \`[TestInitialize]\` — is browser context shared between tests that shouldn't share it?
  2. Check crash recovery in \`[TestCleanup]\` — does it properly detect and handle dead contexts?
  3. Check if previous test left modal dialogs open that crash next test
  4. Check for resource leaks (unclosed pages, contexts)
- **Fix pattern**: Isolate browser contexts per test class, add health check before each test

#### Timeout Waiting for Selector
- **Cause**: DOM element not found within timeout
- **Root cause checklist**:
  1. Is the selector correct? Check actual DOM structure (screenshots, page.content())
  2. Did the page finish loading? Check for loading indicators
  3. Is the element inside an iframe? Need \`page.FrameLocator()\`
  4. Is there a modal/dialog blocking interaction?
  5. Did the app state change after a merge? (new UI, renamed elements)
- **Fix pattern**: Update selector to match actual DOM, add proper wait conditions
- **NEVER**: Just increase timeout as the fix — find the right selector

#### Element Not Visible / Not Interactable
- **Cause**: Element exists in DOM but not visible/clickable
- **Root cause checklist**:
  1. Is there an overlay (loading spinner, modal)?
  2. Is the element outside viewport? Need scroll first
  3. Is the element hidden by CSS? Check \`display:none\`, \`visibility:hidden\`
  4. Is a side menu/drawer closed?
- **Fix pattern**: Wait for visibility, scroll into view, open container first

### Wait Patterns (GOOD vs BAD)

**GOOD** — Condition-driven waits:
\`\`\`csharp
await page.WaitForSelectorAsync(".result-row", new() { State = WaitForSelectorState.Visible });
await page.WaitForResponseAsync(url => url.Contains("/api/data"));
await page.WaitForLoadStateAsync(LoadState.NetworkIdle);
await Expect(page.Locator(".status")).ToHaveTextAsync("Complete");
\`\`\`

**BAD** — Time-based waits (avoid unless animation/transition delay):
\`\`\`csharp
await page.WaitForTimeoutAsync(5000); // DON'T — hides real timing issues
\`\`\`

### Idle / Empty Wait Failure Mode (MANDATORY)

Playwright can look "busy" while the test is actually waiting on the wrong thing forever. Treat this as a first-class failure mode:
- A long wait with no meaningful DOM/API state change is a bug, not "flaky timing".
- Always identify the exact awaited signal: selector, response, dialog, navigation, grid row, download, or command surface.
- If a wait times out, log what changed and what did NOT change during that interval. "Still waiting" is not a diagnosis.
- For response waits, log request URL, whether the request fired at all, whether it failed transport-level (\`ERR_CONNECTION_REFUSED\`, \`ERR_ABORTED\`, etc.), and whether retries actually triggered a new request.
- For UI waits, log the visible fallback surface (\`Edit page\`, loader, modal, overlay, disabled button, empty grid, etc.) and whether the page became interactive or stayed in shell/loading state.
- If a Playwright run spends minutes without converging, suspect an empty wait loop or wrong awaited predicate before blaming the app.
- The fixing agent must watch for these hangs while writing, running, and diagnosing Playwright tests. A rerun that times out without a concrete awaited-signal diagnosis is incomplete.

### Bounded Rerun Contract (MANDATORY)

- Every local Playwright rerun must be launched through a bounded wrapper, not as an opaque fire-and-wait shell step.
- The bounded wrapper must include a real hard timeout (\`perl -e 'alarm ...'\`, \`timeout\`/\`gtimeout\`, or a python subprocess timeout). A plain \`dotnet test\` is not bounded.
- The wrapper must emit:
  - the exact results directory and intended TRX path
  - the filtered test count or named failing-set coverage
  - a visible start marker before \`dotnet test\`
  - a visible terminal marker after \`dotnet test\`
- The same bash command must also declare the expected test count for that rerun and parse the resulting TRX \`UnitTestResult\` entries before treating the verify step as complete.
- A rerun is incomplete if the TRX shows fewer results than the intended failing-set coverage, even if the command itself exited 0.
- If a rerun lives materially longer than the last comparable local baseline and still has no TRX file or no new result artifacts, treat that as a hang signal, not as "still probably running normally".
- The rerun command must emit a recurring heartbeat while the test process is alive (for example \`RERUN_HEARTBEAT elapsed=... trx_exists=... artifact_count=...\` every 20-30s).
- Before launching the bounded rerun, do a stale-runner preflight (\`RERUN_PRECHECK\`): audit lingering \`dotnet test\`, \`testhost.dll\`, Playwright \`run-driver\`, and Chromium \`headless_shell\` leftovers from prior iterations, and clean them up before spending the one rerun.
- If an older local rerun is still alive, do NOT stack a new rerun on top of it. Kill the stale leftover, record that fact in evidence, and only then launch the fresh bounded rerun.
- If the heartbeat keeps reporting "still no TRX" or no artifact growth, treat that as direct evidence of an idle wait or wrong awaited predicate and stop guessing.
- In that case, capture the hang as evidence, name the most likely stuck awaited surface, and continue diagnosis from that fact.
- Do not silently burn more time on an unobservable rerun.

### Coverage Integrity (MANDATORY)

Any Playwright fix must preserve the intended end-to-end chain:
- Do NOT replace a real UI/API/data-path validation with a stub, fake response, or simplified smoke path unless the test is explicitly meant to verify that stubbed seam.
- Do NOT weaken coverage by removing the assertion that proves the business outcome, skipping the step that triggers the real backend call, or turning a real full-chain test into a partial shortcut.
- Do NOT turn a failing full-chain Playwright test into a helper-only shortcut, a direct database proof, or a fake green based on setup state alone.
- Do NOT bypass the awaited UI/API/backend path just to get CI green. If the original failure is in the live chain, the fix must still prove that same live chain.
- Retries, helper fallbacks, and direct-navigation recovery are allowed only when they still verify the same real product behavior.
- If you add a fallback path, the final assertion must still prove the original user-visible or backend-visible outcome.

### Evidence Pipeline

Every test failure should produce:
1. **Screenshot** — captured in \`[TestCleanup]\` via \`Page.ScreenshotAsync()\`
2. **TRX attachment** — \`TestContext.AddResultFile(screenshotPath)\`
3. **Dialog text** — capture before \`CloseKnownErrorDialogsAsync()\`
4. **Console logs** — attach browser console output
5. **Network errors** — log failed API responses (don't truncate bodies)

## Diagnostic Logging — MANDATORY FOR ALL TESTS

### Philosophy

A test failure message like \`"Menu editor did not expose either editable items or the root-level add action."\` is USELESS for debugging. It tells you the WHAT but not the WHY. Every test MUST produce enough context in its output to answer: "What did the DOM actually look like? What state was the app in? What sequence of actions led here?"

### Three Pillars of Test Diagnostics

Every Playwright test MUST log:
1. **Step log** — chronological record of actions taken (navigation, clicks, waits, assertions)
2. **DOM snapshot** — the relevant DOM subtree at the point of assertion or failure
3. **State context** — application state, loaded data, API responses that informed the test logic

### Step Logging Pattern (MANDATORY)

Use \`Console.WriteLine\` with a structured prefix for every meaningful action:
\`\`\`csharp
[TestMethod]
public async Task MenuEditor_ShouldExposeEditableItems()
{
    Console.WriteLine("[STEP] Navigating to admin menu editor page");
    await Page.GotoAsync(MenuEditorUrl);
    await Page.WaitForLoadStateAsync(LoadState.NetworkIdle);

    Console.WriteLine("[STEP] Waiting for menu tree to render");
    var menuTree = Page.Locator(".menu-tree-container");
    await menuTree.WaitForAsync(new() { State = WaitForSelectorState.Visible, Timeout = 15000 });

    Console.WriteLine("[STEP] Querying editable menu items");
    var editableItems = menuTree.Locator("[data-editable='true']");
    var itemCount = await editableItems.CountAsync();
    Console.WriteLine($"[STATE] Found {itemCount} editable items in menu tree");

    if (itemCount == 0)
    {
        // Log DOM BEFORE failing so CI output contains the full picture
        var domSnapshot = await menuTree.InnerHTMLAsync();
        Console.WriteLine($"[DOM] Menu tree innerHTML:\\n{domSnapshot}");

        var rootActions = Page.Locator(".menu-root-actions button");
        var rootActionCount = await rootActions.CountAsync();
        Console.WriteLine($"[STATE] Root-level action buttons: {rootActionCount}");

        if (rootActionCount > 0)
        {
            var actionTexts = await rootActions.AllTextContentsAsync();
            Console.WriteLine($"[STATE] Action button labels: {string.Join(", ", actionTexts)}");
        }

        Assert.Fail(
            $"Menu editor did not expose editable items or root-level add action. " +
            $"Items found: {itemCount}, Root actions: {rootActionCount}. " +
            $"See [DOM] and [STATE] logs above for full context.");
    }
}
\`\`\`

### DOM Snapshot Rules

1. **ALWAYS log the relevant DOM subtree before any assertion that could fail**:
\`\`\`csharp
// WRONG — opaque failure
await Expect(grid).ToHaveCountAsync(5);

// CORRECT — diagnostic failure
var rows = grid.Locator("tr");
var actualCount = await rows.CountAsync();
if (actualCount != 5)
{
    var gridHtml = await grid.InnerHTMLAsync();
    Console.WriteLine($"[DOM] Grid content (expected 5 rows, got {actualCount}):\\n{gridHtml}");
}
await Expect(rows).ToHaveCountAsync(5);
\`\`\`

2. **Limit DOM dumps to the relevant container** — don't dump \`page.ContentAsync()\` for the whole page unless necessary. Target the specific container you're asserting against.

3. **For large containers, use structured extraction**:
\`\`\`csharp
Console.WriteLine("[DOM] Extracting visible items from dropdown:");
var options = await dropdown.Locator("option").AllTextContentsAsync();
Console.WriteLine($"[DOM] Options ({options.Count}): {string.Join(" | ", options)}");
\`\`\`

### State Context Rules

Log any data that was used to make test decisions:
\`\`\`csharp
// Log what the API returned (state the test depends on)
var scenarios = await GetScenariosViaApiAsync();
Console.WriteLine($"[STATE] API returned {scenarios.Count} scenarios: " +
    string.Join(", ", scenarios.Select(s => $"{s.Name} (Id={s.Id}, Model={s.ModelId})")));

// Log which scenario was selected and why
var selected = scenarios.FirstOrDefault(s => s.ModelId != null);
Console.WriteLine($"[STATE] Selected scenario: {selected?.Name ?? "NONE"} " +
    $"(criteria: ModelId != null)");

// Log user context
Console.WriteLine($"[STATE] Test user: {TestUserLogin}, Scenario: {CurrentScenarioName}");
\`\`\`

### Assertion Message Requirements

**NEVER** use bare Assert.Fail or Assert.IsTrue without context:
\`\`\`csharp
// FORBIDDEN — useless in CI logs
Assert.IsTrue(items.Count > 0);
Assert.Fail("Test failed");

// REQUIRED — self-diagnosing assertions
Assert.IsTrue(items.Count > 0,
    $"Expected at least 1 item but found {items.Count}. " +
    $"Page URL: {Page.Url}, Visible containers: {containerCount}");

Assert.AreEqual(expected, actual,
    $"Scenario name mismatch. DB returned: '{actual}', " +
    $"expected pattern: '{expected}'. User: {TestUserLogin}");
\`\`\`

### Pre-Action State Dump Helper Pattern

For complex tests, implement a diagnostic helper:
\`\`\`csharp
private async Task LogDiagnosticContextAsync(string phase, ILocator targetContainer = null)
{
    Console.WriteLine($"[DIAG:{phase}] URL: {Page.Url}");
    Console.WriteLine($"[DIAG:{phase}] Title: {await Page.TitleAsync()}");

    // Visible dialogs/modals that might be blocking
    var dialogs = Page.Locator("[role='dialog']:visible, .modal.show, .overlay:visible");
    var dialogCount = await dialogs.CountAsync();
    if (dialogCount > 0)
    {
        Console.WriteLine($"[DIAG:{phase}] WARNING: {dialogCount} visible dialog(s) detected");
        for (int i = 0; i < dialogCount; i++)
        {
            var text = await dialogs.Nth(i).TextContentAsync();
            Console.WriteLine($"[DIAG:{phase}]   Dialog {i}: {text?.Substring(0, Math.Min(200, text.Length))}");
        }
    }

    // Loading indicators
    var loaders = Page.Locator(".loading, .spinner, [aria-busy='true']");
    var loaderCount = await loaders.CountAsync();
    if (loaderCount > 0)
        Console.WriteLine($"[DIAG:{phase}] WARNING: {loaderCount} loading indicator(s) still active");

    // Target container DOM if provided
    if (targetContainer != null)
    {
        var html = await targetContainer.InnerHTMLAsync();
        Console.WriteLine($"[DIAG:{phase}] Target container DOM ({html.Length} chars):\\n{html}");
    }
}
\`\`\`

Usage in test:
\`\`\`csharp
await LogDiagnosticContextAsync("before-click", menuTree);
await editButton.ClickAsync();
await Page.WaitForLoadStateAsync(LoadState.NetworkIdle);
await LogDiagnosticContextAsync("after-click", menuTree);
\`\`\`

### Network Response Logging (for data-dependent tests)

\`\`\`csharp
// Capture API responses that feed the UI being tested
Page.Response += (_, response) =>
{
    if (response.Url.Contains("/api/") && response.Status != 200)
    {
        Console.WriteLine($"[NET] {response.Status} {response.Request.Method} {response.Url}");
    }
};

// For critical API calls, log the body
var apiResponse = await Page.WaitForResponseAsync(url => url.Contains("/api/menu/items"));
var body = await apiResponse.TextAsync();
Console.WriteLine($"[NET] /api/menu/items response ({apiResponse.Status}): {body}");
\`\`\`

### Log Tag Reference
| Tag | Purpose | When to use |
|-----|---------|-------------|
| \`[STEP]\` | Action being performed | Every navigation, click, fill, wait |
| \`[STATE]\` | Application/data state | Before assertions, after data loads |
| \`[DOM]\` | DOM subtree snapshot | Before failing assertions, unexpected state |
| \`[NET]\` | Network request/response | API calls that feed the test logic |
| \`[DIAG:phase]\` | Full diagnostic dump | Before/after critical transitions |
| \`[WARN]\` | Non-fatal anomaly | Unexpected but non-blocking state |

### CI Output Contract

The combination of these logs MUST answer without reproduction:
1. **What was the test trying to do?** → \`[STEP]\` log sequence
2. **What did the page look like?** → \`[DOM]\` snapshots
3. **What data was available?** → \`[STATE]\` and \`[NET]\` logs
4. **What went wrong?** → Rich assertion message with values
5. **What might have caused it?** → \`[DIAG]\` (blocking dialogs, spinners, wrong URL)

### CI Shard Balancing

When tests are split into parallel shards in CI:
\`\`\`powershell
# Shard by class filter
$shards = @(
  "ClassName~ScenarioE2E|ClassName~GridForms",      # Shard 1: UI-heavy
  "ClassName~Admin|ClassName~UserAdmin",              # Shard 2: Admin
  "ClassName~Navigation|ClassName~Menu",              # Shard 3: Navigation
  "ClassName~TaskGroup|ClassName~CalcSession"          # Shard 4: Execution
)
\`\`\`
- Every test class must appear in exactly one shard
- Balance by execution time, not test count
- After adding new tests, verify shards still cover everything

## Per-Test Time Targets
| Test Type | Target | Max |
|-----------|--------|-----|
| Simple UI assertion | < 10s | 30s |
| Form interaction (fill + submit) | < 20s | 45s |
| Full workflow (multi-page) | < 45s | 90s |
| Data-heavy operation (export/import) | < 30s | 60s |

Tests exceeding "Max" are candidates for optimization, not timeout increases.

## MSTest V2 Lifecycle — CRITICAL

### TestInitialize inheritance (MANDATORY KNOWLEDGE)
In MSTest V2, BOTH base and derived \`[TestInitialize]\` methods run — base FIRST, then derived.
\`\`\`
Base.TestInitialize()    ← runs FIRST (e.g. browser recovery, scenario assignment)
Derived.TestInitialize() ← runs SECOND (your per-class setup)
Base.TestCleanup()       ← runs AFTER derived cleanup
\`\`\`
**BEFORE adding \`[TestInitialize]\` to a derived class**: READ the base class. If the base already does scenario assignment / data seeding, adding it again is redundant — and removing the base call to "move it" to derived will break OTHER classes.

### TryEnsure wrapper pattern (silent failure trap)
Many base classes wrap setup methods in try/catch that silently swallows exceptions:
\`\`\`csharp
private static async Task TryEnsureStableLocalTestUserScenarioAssignedAsync()
{
    try { await EnsureLocalTestUserScenarioAssignedAsync(); }
    catch (Exception ex) { Console.WriteLine($"TESTWARN: ...{ex.Message}"); }
}
\`\`\`
If this pattern exists, the REAL failure is hidden in build log as TESTWARN. Search build logs for \`TESTWARN\` before assuming TestInitialize works.

## SQL Seed Data — UPSERT Traps

### WRONG: IF NOT EXISTS only inserts, never updates existing rows
\`\`\`sql
-- BROKEN: If row exists with wrong values, INSERT never fires, bad data persists
IF NOT EXISTS (SELECT 1 FROM [Table] WHERE [Name] = @name)
INSERT INTO [Table] ([Name], [Flag]) VALUES (@name, 1)
\`\`\`

### CORRECT: INSERT + unconditional UPDATE
\`\`\`sql
-- Insert if missing
IF NOT EXISTS (SELECT 1 FROM [Table] WHERE [Name] = @name)
INSERT INTO [Table] ([Name], [Flag]) VALUES (@name, 1);
-- Always fix values on existing rows
UPDATE [Table] SET [Flag] = 1 WHERE [Name] = @name AND [Flag] <> 1;
\`\`\`

### CORRECT: MERGE pattern (alternative)
\`\`\`sql
MERGE [Table] AS target
USING (SELECT @name AS [Name]) AS source ON target.[Name] = source.[Name]
WHEN MATCHED THEN UPDATE SET [Flag] = 1
WHEN NOT MATCHED THEN INSERT ([Name], [Flag]) VALUES (@name, 1);
\`\`\`

**Why this matters in CI**: Bamboo reuses DB between builds. Previous builds may have inserted rows with wrong column values (e.g. \`IsModelCalc=0\`). IF NOT EXISTS sees the row exists and skips — the bad value persists across ALL subsequent builds.

### Child row pattern (task group lines, related records)
When seeding a parent + child rows, check BOTH:
\`\`\`sql
-- Parent exists? Good. But does it have ALL required child rows?
IF NOT EXISTS (SELECT 1 FROM [ChildTable] WHERE [ParentId] = @id AND [Name] = 'Required_Line')
INSERT INTO [ChildTable] ([ParentId], [Name], ...) VALUES (@id, 'Required_Line', ...)
\`\`\`

## Data Setup Patterns

### Pattern: TestInitialize Data Setup
\`\`\`csharp
[TestInitialize]
public async Task EnsureTestData()
{
    // Check if required data exists
    var scenarios = await GetScenariosViaApiAsync();
    if (scenarios.Count == 0)
    {
        // CREATE the data the test needs — don't skip
        await CreateTestScenarioViaApiAsync("AutoTest_Scenario_1");
        await CreateTestScenarioViaApiAsync("AutoTest_Scenario_2");
    }
}
\`\`\`

### Cleanup Pattern
\`\`\`csharp
[TestCleanup]
public async Task CleanupTestData()
{
    // Remove data created during test to avoid polluting other tests
    foreach (var id in _createdEntityIds)
    {
        await HttpClient.DeleteAsync($"/api/Entity/{id}");
    }
}
\`\`\`

## Seed Scenario Default Selection — CRITICAL RANKING KNOWLEDGE

### The Selection Query (ResolveStableScenarioNamesCoreAsync)
The app picks a "default" user scenario via this SQL ranking:
\`\`\`sql
SELECT TOP 1 s.[Name]
FROM [Scenario] s
WHERE s.[UserId] = @userId
  AND ISNULL(s.[Blocked], 0) = 0
  AND s.[DeletionDate] IS NULL
  AND s.[Name] NOT LIKE 'pw%'
  AND s.[Name] NOT LIKE 'Deleted[_]%'
ORDER BY
  CASE WHEN s.[ModelId] IS NOT NULL THEN 0 ELSE 1 END,
  CASE WHEN s.[Protected] = 1 THEN 1 ELSE 0 END,
  s.[Id] DESC
\`\`\`

**Ranking priority**: ModelId NOT NULL (best) → Protected=0 (preferred) → highest Id (newest).

### pw- Prefix Convention
Test seed scenarios MUST use the \`pw-\` prefix (e.g. \`pw-ci-copy-src-3p\`) so the \`NOT LIKE 'pw%'\` filter excludes them from default selection. This prevents seed data from hijacking the user's default scenario assignment.

**NEVER** use the \`Protected=1\` flag to exclude seed scenarios from default selection — Protected=1 also hides the scenario from the web app's copy dialog "Source scenario" dropdown, which breaks copy tests.

### Side-Effect Awareness for SQL Changes
Before changing ANY column on a seed scenario, check ALL queries that reference that column:
| Column | Side effect if changed |
|--------|----------------------|
| \`Protected=1\` | Hidden from copy dialog dropdown (breaks CopySubmit tests) |
| \`Blocked=1\` | Filtered out of ALL scenario queries (breaks everything) |
| \`DeletionDate IS NOT NULL\` | Soft-deleted, invisible everywhere |
| \`ModelId IS NULL\` | Drops in ranking (may lose default selection) |
| \`Name LIKE 'pw%'\` | Excluded from default selection (desired for seeds) |
| \`Name LIKE 'Deleted[_]%'\` | Excluded from default selection |

**Before pushing a SQL change**: grep the ENTIRE test project for the column/flag name and verify no other test depends on the current value.

## Git Commit Safety

**NEVER use \`git add -A\` or \`git add .\`** in CI fix workflows. Stage only the files you changed:
\`\`\`bash
git add Optimizer.PlaywrightTests/SqlTestHelper.cs Optimizer.PlaywrightTests/SomeOtherFile.cs
git diff --staged --stat   # VERIFY: only your files, no .sisyphus/ or test artifacts
git commit -m "fix(playwright): description [TICKET-ID]"
\`\`\`

## Merge Conflict Patterns in .NET

After merging develop:
1. \`*.csproj\` — check for duplicated PackageReference or ProjectReference
2. \`.targets\` — check for duplicated Target blocks (MSBuild cares about order)
3. Test files — check for conflicting using statements, duplicated test methods
4. \`.runsettings\` — verify test configuration preserved
5. Always rebuild after merge: \`dotnet build --nologo\`
`,
}
