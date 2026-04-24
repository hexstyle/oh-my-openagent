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

## Merge Conflict Patterns in .NET

After merging develop:
1. \`*.csproj\` — check for duplicated PackageReference or ProjectReference
2. \`.targets\` — check for duplicated Target blocks (MSBuild cares about order)
3. Test files — check for conflicting using statements, duplicated test methods
4. \`.runsettings\` — verify test configuration preserved
5. Always rebuild after merge: \`dotnet build --nologo\`
`,
}
