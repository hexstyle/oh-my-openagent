import type { BuiltinSkill } from "../types"

export const dotnetPlaywrightSkill: BuiltinSkill = {
  name: "dotnet-playwright",
  description:
    "Expert .NET build, MSTest, and Playwright E2E testing skill. Use when working with dotnet build, dotnet test, MSBuild errors, Playwright browser automation in C#, TRX test results, or CI test failures. Trigger: 'dotnet', 'MSBuild', 'Playwright', 'csproj', '.NET', 'NuGet', 'TRX', 'E2E test'.",
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

### Evidence Pipeline

Every test failure should produce:
1. **Screenshot** — captured in \`[TestCleanup]\` via \`Page.ScreenshotAsync()\`
2. **TRX attachment** — \`TestContext.AddResultFile(screenshotPath)\`
3. **Dialog text** — capture before \`CloseKnownErrorDialogsAsync()\`
4. **Console logs** — attach browser console output
5. **Network errors** — log failed API responses (don't truncate bodies)

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
