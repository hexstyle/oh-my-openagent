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
5. **Corporate TLS is not a terminal blocker** — if HTTPS API fetches fail with certificate verification errors but git/Bitbucket connectivity still works, retry the SAME read-only endpoint with \`curl --insecure\` and continue the loop

## TLS / Certificate Fallback

If Bamboo or Bitbucket REST reads fail with messages like \`unknown certificate verification error\`,
\`SSL certificate problem\`, or \`unable to get local issuer certificate\`:

1. First retry the exact same GET with normal TLS.
2. If it is still a certificate-chain error, retry the same READ-ONLY request with \`curl --insecure\`.
3. Keep the insecure fallback scoped to Bamboo/Bitbucket GET requests used for CI observation.
4. Do NOT classify this as NETWORK BLOCKED if \`git fetch\`, \`git push\`, or browser access already proves connectivity exists.
5. Do NOT stop after a successful push just because the post-push monitor needed \`--insecure\`.

Safe pattern:
\`\`\`bash
fetch() {
  local url="$1"
  curl --fail --silent --show-error "$url" 2>/tmp/curl.err \
    || {
      if grep -Eqi "certificate|issuer|SSL" /tmp/curl.err; then
        curl --insecure --fail --silent --show-error "$url"
      else
        cat /tmp/curl.err >&2
        return 1
      fi
    }
}
\`\`\`

Use the same pattern with headers when reading JSON:
\`\`\`bash
fetch_json() {
  local url="$1"
  curl --fail --silent --show-error -H "Accept: application/json" "$url" 2>/tmp/curl.err \
    || {
      if grep -Eqi "certificate|issuer|SSL" /tmp/curl.err; then
        curl --insecure --fail --silent --show-error -H "Accept: application/json" "$url"
      else
        cat /tmp/curl.err >&2
        return 1
      fi
    }
}
\`\`\`

## API Patterns — TOKEN BUDGET RULES

**CRITICAL: Bamboo API responses are HUGE. ALWAYS pipe through jq/python to extract ONLY what you need. NEVER dump raw JSON into context.**

### Fetch Latest Build Result (summary only — ~200 bytes)
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

### Fetch Failing Test NAMES Only (Step 1 — always do this first)

**CRITICAL: Test results are stored at the JOB level, not the plan level.** Use \`{PLAN_KEY}-JOB1-{N}\` (with JOB1 in the key) and \`-H "Accept: application/json"\` to get JSON instead of XML.

\`\`\`bash
# CORRECT — job-level endpoint with JSON header
curl -s -H "Accept: application/json" "https://{BAMBOO_HOST}/rest/api/latest/result/{PLAN_KEY}-JOB1-{N}.json?expand=testResults.failedTests.testResult" | python3 -c "
import sys, json
d = json.load(sys.stdin)
tests = d.get('testResults',{}).get('failedTests',{}).get('testResult',[])
print(f'Total failing: {len(tests)}')
for t in tests:
    err = (t.get('errors',{}).get('error',[{}])[0].get('message','') or '')[:150]
    print(f'{t[\"className\"].split(\".\")[-1]}.{t[\"methodName\"]} | {err}')
"

# WRONG — plan-level returns failedTestCount but empty testResults:
# curl -s "https://{BAMBOO_HOST}/rest/api/latest/result/{PLAN_KEY}-{N}.json?expand=testResults.failedTests" → testResults: {}
# WRONG — without Accept header, job-level returns XML not JSON:
# curl -s "https://{BAMBOO_HOST}/rest/api/latest/result/{PLAN_KEY}-JOB1-{N}.json" → <?xml ...>
\`\`\`
**This extracts ~100 bytes per test instead of ~5KB. For 15 failures = 1.5KB vs 75KB.**
**MUST verify: \`len(tests)\` equals \`failedTestCount\` from the summary endpoint. If 0 but failedTestCount > 0, you're using the wrong endpoint.**

### Fetch ONE Test's Full Error (Step 2 — only when diagnosing a specific test)
\`\`\`bash
curl -s -H "Accept: application/json" "https://{BAMBOO_HOST}/rest/api/latest/result/{PLAN_KEY}-JOB1-{N}.json?expand=testResults.failedTests.testResult" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for t in d.get('testResults',{}).get('failedTests',{}).get('testResult',[]):
    if '{TEST_METHOD}' in t.get('methodName',''):
        for e in t.get('errors',{}).get('error',[]):
            print(e.get('message','')[:500])
        break
"
\`\`\`

### Fetch Build Log — NEVER FULL LOG
\`\`\`bash
# Only deployment errors (before test phase):
curl -s "https://{BAMBOO_HOST}/download/{PLAN_KEY}-JOB1/build_logs/{PLAN_KEY}-JOB1-{N}.log" | grep -i "error :" | head -20
\`\`\`

### List Recent Builds (summary table — ~500 bytes for 5 builds)
\`\`\`bash
curl -s "https://{BAMBOO_HOST}/rest/api/latest/result/{PLAN_KEY}.json?max-result=5&expand=results.result" | python3 -c "
import sys, json
for r in json.load(sys.stdin).get('results',{}).get('result',[]):
    print(f'#{r[\"buildNumber\"]} {r[\"state\"]} {r.get(\"successfulTestCount\",0)}p/{r.get(\"failedTestCount\",0)}f {r.get(\"vcsRevisionKey\",\"\")[:8]}')
"
\`\`\`

### Queue a Build (requires auth)
\`\`\`bash
curl -X POST "https://{BAMBOO_HOST}/rest/api/latest/queue/{PLAN_KEY}.json" -u user:token
\`\`\`
If anonymous POST returns 401, do NOT ask for credentials immediately. Instead:
1. Push a new commit to trigger automatic webhook build
2. Add an empty commit if no code changes: \`git commit --allow-empty -m "ci: trigger build"\`
3. Only escalate auth if webhook trigger also fails

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

## Evidence Format — MAX 3KB per build file

Save build analysis to \`.sisyphus/evidence/build-{N}-analysis.md\`:
\`\`\`markdown
# Build #{N} — {State} — {pass}p/{fail}f — rev {SHA[:8]}
| Test | Error (≤100 chars) | Root Cause Group |
|------|-------------------|-----------------|
| TestName | Assert.Fail: expected X | group-selector |
Next: fix group-selector (affects 8/15 failures)
\`\`\`
**No stack traces. No full error messages. No narratives. Table + one "Next" line.**

### Iteration Ledger Coupling

Every Bamboo iteration must also update \`.sisyphus/evidence/repair-log.md\`:
- append one compact iteration block
- list build number + revision
- list every failure group covered in this iteration
- list exact source files changed
- record local verify result and push/queue result

If Bamboo data was fetched but \`repair-log.md\` was not updated, the iteration is incomplete.

### FORBIDDEN Evidence Actions (violation = wasted CI iteration)
- Saving raw Bamboo API JSON responses to ANY file in \`.sisyphus/evidence/\`
- Saving full build log output (even excerpts > 500 bytes) to evidence
- Creating evidence files > 3KB — if your file exceeds 3KB, you are including raw data. Rewrite as a structured table.
- Piping \`curl\` output directly to files: \`curl ... > .sisyphus/evidence/file\` is ALWAYS WRONG. Filter first: \`curl ... | python3 -c "..." > file\`
- After saving any evidence file, verify: \`wc -c .sisyphus/evidence/{file}\`. If > 3072 bytes, rewrite it shorter.
- Writing \`*.json\`, \`*.log\`, \`*.trx\`, \`*.xml\` to \`.sisyphus/evidence/\` — ci-green-loop STEP 0 auto-deletes these extensions every iteration. Use \`build-{N}-analysis.md\` format ONLY.
- Writing a free-form narrative without build number / revision / changed-files coverage into \`repair-log.md\`
`,
}
