import type { BuiltinSkill } from "../types"

export const bambooCiSkill: BuiltinSkill = {
  name: "bamboo-ci",
  description:
    "Bamboo CI monitoring, build result analysis, and iteration loop. Use when working with Atlassian Bamboo builds, fetching build results, parsing build logs, or running CI green loops. Trigger: 'bamboo', 'build plan', 'CI build', 'build green', 'EUROPT', 'build failed', 'build log'.",
  template: `# Bamboo CI Skill

Expert knowledge for interacting with Atlassian Bamboo CI from an agent context.

## Core Principles

1. **Anonymous first** — always try public/anonymous endpoints before asking for credentials
2. **Revision tracking** — always correlate build results with exact git SHA
3. **Structured analysis** — classify failures, don't just dump logs
4. **Iterative loop** — push → monitor → analyze → fix → repeat

## API Patterns

### Fetch Latest Build Result
\`\`\`bash
curl -s "https://{BAMBOO_HOST}/rest/api/latest/result/{PLAN_KEY}/latest.json" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'Build: #{d[\"buildNumber\"]}')
print(f'State: {d[\"state\"]}')
print(f'Duration: {d.get(\"buildDurationInSeconds\", \"?\")}s')
print(f'Tests: {d.get(\"successfulTestCount\", 0)} pass, {d.get(\"failedTestCount\", 0)} fail')
print(f'Revision: {d.get(\"vcsRevisionKey\", \"unknown\")}')
print(f'Reason: {d.get(\"buildReason\", \"unknown\")}')
"
\`\`\`

### Fetch Build by Number
\`\`\`bash
curl -s "https://{BAMBOO_HOST}/rest/api/latest/result/{PLAN_KEY}-{N}.json?expand=testResults.failedTests.testResult"
\`\`\`

### Fetch Build Log
\`\`\`bash
curl -s "https://{BAMBOO_HOST}/download/{PLAN_KEY}-JOB1/build_logs/{PLAN_KEY}-JOB1-{N}.log"
\`\`\`

### List Recent Builds
\`\`\`bash
curl -s "https://{BAMBOO_HOST}/rest/api/latest/result/{PLAN_KEY}.json?max-result=5&expand=results.result"
\`\`\`

### Queue a Build (requires auth)
\`\`\`bash
curl -X POST "https://{BAMBOO_HOST}/rest/api/latest/queue/{PLAN_KEY}.json" -u user:token
\`\`\`
If anonymous POST returns 401, do NOT ask for credentials immediately. Instead:
1. Push a new commit to trigger automatic webhook build
2. Add an empty commit if no code changes: \`git commit --allow-empty -m "ci: trigger build"\`
3. Only escalate auth if webhook trigger also fails

## Build Result Analysis Protocol

When a build fails:
1. **Fetch JSON** — get structured test counts and metadata
2. **Fetch log** — get full build output for error context
3. **Correlate revision** — verify the build ran YOUR branch head, not a stale SHA
4. **Classify failures**:
   - \`build-error\`: MSBuild/compilation error (fix code first)
   - \`test-crash\`: TargetClosedException, process exited (browser lifecycle)
   - \`test-timeout\`: Operation timed out (selector/API mismatch)
   - \`test-assertion\`: Assert failed (logic bug in test or app)
   - \`infra-error\`: Checkout failed, agent offline (external blocker)
5. **Group by root cause** — same root cause gets one fix, not per-test patches
6. **Track build history** — record each iteration: build#, SHA, fail count, fix applied

## Stale Build Detection

**Critical**: Always verify the build ran your latest commit:
\`\`\`bash
LOCAL_SHA=$(git rev-parse HEAD)
BAMBOO_SHA=$(curl -s "...latest.json" | python3 -c "import sys,json; print(json.load(sys.stdin).get('vcsRevisionKey',''))")
if [ "$LOCAL_SHA" != "$BAMBOO_SHA" ]; then
  echo "WARNING: Bamboo built stale revision $BAMBOO_SHA, not current HEAD $LOCAL_SHA"
fi
\`\`\`
If stale: push a new commit or empty commit to force a new build.

## CI Green Loop Protocol

\`\`\`
LOOP:
  1. Push branch head to remote
  2. Wait for build to appear (poll latest.json every 30s, max 10min)
  3. Wait for build to complete (lifeCycleState = Finished)
  4. If state = Successful AND failedTestCount = 0 → EXIT LOOP (green!)
  5. If state = Failed:
     a. Fetch build log
     b. Classify all failures
     c. Fix each failure by root cause
     d. Commit fixes
     e. GOTO 1
  6. If build never appears after 10min:
     a. Try empty commit push
     b. If still no build → escalate (auth or webhook issue)
ABORT: Only if remote is unreachable after 5 retries with backoff
\`\`\`

## Checkpoint Protocol

When approaching token/context limits during a CI loop:
1. Commit all pending fixes
2. Push to remote
3. Write checkpoint to \`.sisyphus/evidence/ci-loop-checkpoint.md\`:
   - Local HEAD SHA
   - Remote HEAD SHA
   - Latest Bamboo build # and result
   - Current failure classification
   - What was fixed in this iteration
   - What remains to fix
4. Continue in next session from checkpoint

## Evidence Format

Save build analysis to \`.sisyphus/evidence/build-{N}-analysis.md\`:
\`\`\`markdown
# Build #{N} Analysis
- State: Failed/Successful
- Duration: {N}s
- Revision: {SHA}
- Tests: {pass} pass, {fail} fail

## Failures
| Test | Error Type | Root Cause | Fix |
|------|-----------|------------|-----|
| TestName | timeout | selector mismatch | Update selector |

## Next Steps
- [ ] Fix X
- [ ] Fix Y
\`\`\`
`,
}
