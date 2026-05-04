# oh-my-openagent

This fork keeps the upstream package identity, but changes the local install and runtime contract for OpenCode.

Upstream reference at the last synced README:

- https://github.com/code-yeongyu/oh-my-openagent/blob/51194e943487a1783db7ca9524e514ae93472bf7/README.md

## What this fork changes

- the OpenCode host/plugin config is managed from this repo
- clean installs are pinned to this local checkout via `file://<repo-root>`
- `Codex` OAuth is imported into OpenCode automatically when `~/.codex/auth.json` exists
- `Claude` stays configured by default and can be authorized later with `opencode auth login -p anthropic`
- runtime agent names stay canonical and user-facing only, in the form `Agent (Role)`
- local model overrides live in `~/.config/opencode/oh-my-openagent.local.jsonc` instead of editing the managed base file
- the managed local baseline also installs:
  - `opencode-claude-auth`
  - `opencode-helicone-session`
  - a built-in non-interactive shell instruction set equivalent to `opencode-shell-strategy`

Primary model picture in this fork:

- planning/review/controller roles prefer `anthropic/claude-opus-4-7` (Prometheus, Metis, Momus)
- every non-`Explore` agent keeps Claude ahead of OpenAI/Codex in the paid chain
- execution/coding lanes default to `anthropic/claude-sonnet-4-6` (Sisyphus, Atlas, Hephaestus, Librarian, Multimodal Looker, Sisyphus Junior, Oracle)
- the main work categories also default to `anthropic/claude-sonnet-4-6`, except `ultrabrain`, which stays `anthropic/claude-opus-4-7`
- `Explore (Code Search)` is the only spark-primary lane and runs on `openai/gpt-5.3-codex-spark`
- `Sisyphus Junior (Focused Executor)` is the fast executor lane on `anthropic/claude-sonnet-4-6`, with `gpt-5.4` ahead of `spark`
- **every agent and category chain includes both Claude (Anthropic) and Codex/OpenAI paid models** — see cross-provider constraint below
- free models stay behind every remaining paid OpenAI/Codex and Claude fallback
- the managed free chain is `opencode/nemotron-3-super-free` -> `opencode/minimax-m2.5-free` -> `opencode/big-pickle`
- managed host context caps stay conservative:
  - `openai/gpt-5.4`, `anthropic/claude-opus-4-7`, `anthropic/claude-opus-4-6`, `anthropic/claude-sonnet-4-6` stay pinned at `200000`
  - `openai/gpt-5.3-codex-spark` is pinned at `128000`, because the refreshed runtime catalog currently caps it there

Primary agents and their visible fallback shape:

- `Prometheus`, `Metis`, `Momus` (planning/review): `anthropic/claude-opus-4-7` -> `anthropic/claude-sonnet-4-6` -> `openai/gpt-5.4` -> `openai/gpt-5.3-codex-spark` -> free models
- `Sisyphus` (ultrawork executor): `anthropic/claude-sonnet-4-6` -> `anthropic/claude-opus-4-7` -> `openai/gpt-5.4` -> `openai/gpt-5.3-codex-spark` -> free models
- `Oracle`: `anthropic/claude-sonnet-4-6` -> `anthropic/claude-opus-4-7` -> `openai/gpt-5.4` -> `openai/gpt-5.3-codex-spark` -> free models
- `Atlas` (orchestration): `anthropic/claude-sonnet-4-6` -> `anthropic/claude-opus-4-7` -> `openai/gpt-5.4` -> `openai/gpt-5.3-codex-spark` -> free models
- `Hephaestus` (deep executor): `anthropic/claude-sonnet-4-6` -> `anthropic/claude-opus-4-7` -> `openai/gpt-5.4` -> `openai/gpt-5.3-codex-spark` -> free models
- `Librarian`: `anthropic/claude-sonnet-4-6` -> `anthropic/claude-opus-4-7` -> `openai/gpt-5.4` -> `openai/gpt-5.3-codex-spark` -> free models
- `Multimodal Looker`: `anthropic/claude-sonnet-4-6` -> `anthropic/claude-opus-4-7` -> `openai/gpt-5.4` -> `openai/gpt-5.3-codex-spark` -> free models
- `Explore`: `openai/gpt-5.3-codex-spark` -> `anthropic/claude-sonnet-4-6` -> `anthropic/claude-opus-4-7` -> `openai/gpt-5.4` -> free models
- `Sisyphus Junior` (fast executor): `anthropic/claude-sonnet-4-6` -> `anthropic/claude-opus-4-7` -> `openai/gpt-5.4` -> `openai/gpt-5.3-codex-spark` -> free models

Managed source of truth for this table: `assets/custom-opencode/oh-my-opencode.json`.

## Cross-provider fallback constraint (IMMUTABLE)

**Every agent and category fallback chain MUST include BOTH Anthropic (Claude) AND OpenAI (Codex/GPT) paid models.** This is a hard architectural constraint enforced by code and tests. It cannot be overridden.

What CAN be changed:
- model order within the chain (which provider comes first)
- quality settings (`variant`, `reasoningEffort`, `textVerbosity`)
- fallback timing (`cooldown_seconds`, `timeout_seconds`, transient retry windows)

What CANNOT be changed:
- presence of both providers in every chain — removing all Claude or all OpenAI models from any chain is forbidden
- paid models must appear before free models in every chain

If one provider is temporarily broken (rate limits, Forbidden, TLS errors), reorder the chain so the working provider comes first. **Never remove the broken provider entirely** — it may recover, and provider-level redundancy is the safety net.

This constraint is enforced by:
- `collectFallbackPolicyViolations()` in `src/custom-opencode/model-config-validation.ts` — validates at build time
- the cross-provider invariant test in `src/cli/doctor/checks/custom-opencode-config.test.ts` — fails CI if any agent chain is missing a provider
- `bun run script/validate-effective-model-config.ts` — validates at install time

## Fallback behavior

- transient network/TLS/5xx/unknown failures retry on the same model first
- transient `403 Forbidden` / `Request not allowed` also retries on the same paid model first, but only for a bounded number of delayed attempts before advancing to the next paid fallback
- optional `runtime_fallback.manual_provider_clearance_*` overrides can pause tracked Claude/Codex `403` progression on the same paid model and raise a toast with a provider URL while you clear access issues manually
- same-model transient retries stay alive for up to 15 minutes
- the retry interval grows over time and caps at 5 minutes between attempts
- quota/cooldown/payment/usage-limit failures exhaust the remaining paid OpenAI/Codex and Claude chain before any free model
- for `Explore`, `gpt-5.3-codex-spark` is the primary model, with fallback through paid Claude and then paid `gpt-5.4` before free models
- for `Sisyphus Junior`, `claude-sonnet-4-6` is primary, with `gpt-5.4` ahead of `spark`
- when a session is pushed down to `spark` or free models, background recovery probes can move it back up to stronger models when they recover
- the fork only treats free models as valid when they resolve in the local runtime baseline; deprecated cache-only entries are ignored

`opencode-supermemory` is not enabled in the managed baseline. It overlaps with this fork's compaction/recovery stack and should be treated as an optional manual integration, not a default install.

## Install

Prerequisites:

- macOS with `Homebrew`
- `git`
- network access
- optional but recommended: existing `Codex` login on this machine

Clone and install:

```bash
git clone --branch dev https://github.com/hexstyle/oh-my-openagent.git
cd oh-my-openagent
./script/install-local-opencode-fork.sh --reset
```

If the repo is already cloned:

```bash
cd /path/to/oh-my-openagent
./script/install-local-opencode-fork.sh --reset
```

`--reset` is the supported clean path. It rebuilds the fork, syncs the managed config, pins OpenCode to this local checkout, installs the managed runtime plugins, imports `Codex` OAuth when present, and runs a live verification pass.

The installer also:

- creates `~/.config/opencode/oh-my-openagent.local.jsonc` if it does not exist
- preserves that local override file across reruns
- validates the effective model config against a refreshed OpenCode model catalog

## Use

Check current auth:

```bash
opencode auth list
```

If Anthropic auth is missing or expired:

```bash
opencode auth login -p anthropic
```

If OpenAI auth needs to be refreshed manually:

```bash
opencode auth login -p openai
```

After pulling new changes in this fork, rerun:

```bash
./script/install-local-opencode-fork.sh --reset
```

## Local model overrides

Do not edit `~/.config/opencode/oh-my-openagent.json` directly. That file is installer-managed.

Edit this instead:

```bash
~/.config/opencode/oh-my-openagent.local.jsonc
```

Use it to override:

- `agents.*.model`
- `agents.*.fallback_models`
- `categories.*.model`
- `categories.*.fallback_models`
- `runtime_fallback.manual_provider_clearance_enabled`
- `runtime_fallback.manual_provider_clearance_pause_window_seconds`
- `runtime_fallback.manual_provider_clearance_notify_on_pause`

After editing the local override file:

```bash
bun run script/validate-effective-model-config.ts
```

`validate-effective-model-config.ts` checks the repo-managed install assets plus your local override against a refreshed model catalog. To reapply the managed config into the live OpenCode runtime and verify the installed state, rerun:

```bash
./script/install-local-opencode-fork.sh --reset
bun run script/verify-local-opencode-install.ts
```

Then restart `opencode` so the running process picks up the new config.

## Built-in Skills

Skills are domain-specific knowledge packs that agents load on demand via `load_skills=[...]` in task delegation. Built-in skills ship with the plugin and are available in every project.

| Skill | Trigger | Purpose |
|-------|---------|---------|
| `playwright` | browser automation, Playwright | Browser automation via Playwright |
| `playwright-cli` | playwright CLI | Playwright CLI variant |
| `frontend-ui-ux` | UI, UX, design, spacing | Designer-turned-developer visual quality |
| `git-master` | git, branching, atomic commits | Git workflow and commit conventions |
| `dev-browser` | navigate website, screenshot, scrape | Persistent browser automation with AI snapshots |
| `bamboo-ci` | bamboo, build plan, CI build, build green | Bamboo CI monitoring, build analysis, iteration loops |
| `dotnet-playwright` | dotnet, MSBuild, csproj, TRX, E2E | .NET build + Playwright E2E testing expertise |
| `ci-green-loop` | CI green, make build green, fix CI | Iterative push-build-analyze-fix protocol |
| `merge-workflow` | merge develop, merge conflict, hotfix | Git merge workflow with two-phase pattern |
| `sql-dacpac-deploy` | sqlproj, DACPAC, SQL72014, SQL migration | SQL Server DACPAC deployment and SSDT expertise |
| `review-work` | review work, QA, verify implementation | 5-agent parallel post-implementation review orchestrator |
| `ai-slop-remover` | clean up AI code, remove slop | Removes AI-generated code smells per file |

### CI/CD Skills

Five skills for enterprise .NET CI/CD workflows:

**bamboo-ci** — Bamboo REST API patterns (anonymous-first), build result classification, stale revision detection, checkpoint protocol. Key: always verifies build revision matches branch HEAD before analyzing results.

**dotnet-playwright** — MSBuild error patterns, `dotnet test` filtering, Playwright failure taxonomy (TargetClosedException, selector timeout, visibility), evidence pipeline (screenshots + TRX), shard balancing rules. Key: `WaitForTimeoutAsync` is never the fix — find the right selector.

**ci-green-loop** — The iterative red-to-green protocol: monitor → classify → prioritize (build-error > crash > assertion > timeout) → fix → local verify → push → repeat. Includes checkpoint format for session handoff, forbidden actions list, and mandatory local test verification gate. **Planning Mode**: when loaded by Prometheus during plan creation, enforces 100% failure coverage — every CI fix plan must start with a comprehensive diagnosis task and create per-root-cause fix tasks covering all known failures.

**CI Workflow: Local-Verify-Before-Push Mandate**

The ci-green-loop skill enforces a mandatory local test verification gate between fixing code and pushing. After fixing failing tests, agents MUST run `dotnet test --filter` locally and confirm all targeted tests pass before pushing. This eliminates blind 32-minute CI cycles on locally-catchable regressions. Bypass only when local test infrastructure is genuinely unavailable, documented in the commit message.

**Evidence Management**

Evidence in `.sisyphus/evidence/` is capped: 3KB/file, 500KB total, 20 files max. Raw JSON, build logs, TRX, and screenshots are forbidden. Eviction runs at each CI loop iteration start and on session start. Only structured markdown analysis files survive.

**Anti-Plan-Churn**

Before regenerating a CI fix plan, agents check for existing plans (<24h old) covering current failures. If coverage >=80% with no new failure types, the executor continues the existing plan. Three regenerations without a push triggers automatic execute-as-is.

**merge-workflow** — Two-phase merge for hotfix branches (pre-fix merge + post-green merge), conflict resolution strategy by file type, post-merge validation. Key: application source prefers develop, test files prefer hotfix.

**sql-dacpac-deploy** ��� SQL Server DACPAC/SSDT project expertise: SQL72014 invalid column errors, EXISTS guard + `sp_executesql` deferred validation patterns, merge conflict resolution in migration scripts. Key: post-deploy scripts referencing columns added by schema diff need `sp_executesql` to defer validation.

### Review & Quality Skills

**review-work** — Post-implementation review orchestrator. Launches 5 parallel sub-agents: Goal Verifier (did we build what was asked?), QA Executor (hands-on testing), Code Reviewer (is code well-written?), Security Auditor (is it secure?), Context Miner (did we miss any context from GitHub/git/docs?). All 5 must pass for review to pass. Key: the reviewer must catch what the implementer missed, and re-evaluate approach if needed.

**ai-slop-remover** — Removes AI-generated code smells from a single file while preserving functionality. For multiple files, call in parallel per file.

### Using Skills in Plans

When generating Prometheus plans, reference skills in task definitions:

```markdown
- [ ] 4.2. **CI Green Loop**
  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: `["bamboo-ci", "ci-green-loop", "dotnet-playwright"]`
```

The atlas orchestrator passes skills to subagents via `load_skills` in task delegation.

### Adding Custom Skills

Create `SKILL.md` files with YAML frontmatter:

```
.opencode/skills/
└── my-skill/
    └── SKILL.md
```

```yaml
---
name: my-skill
description: "One-line description for agent discovery"
---

# My Skill

Skill content in markdown...
```

Skill scopes (highest priority wins):
- `opencode-project` (`.opencode/skills/` in project root)
- `project` (`.claude/skills/` or `.agents/skills/`)
- `user` (`~/.claude/skills/`)
- `builtin` (this plugin, always available)

## Notes

- live config is written to `~/.config/opencode`
- the live plugin entry is rewritten to `file:///absolute/path/to/this/repo`
- only the managed JSON config surface is synced into the live OpenCode config dir
- `opencode-helicone-session` is inert until you configure a Helicone-backed provider
- upstream feature docs still apply unless this fork says otherwise
