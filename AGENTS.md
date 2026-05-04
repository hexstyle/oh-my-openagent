# AGENTS.md

**Updated:** 2026-04-14
**Commit:** current `dev` HEAD
**Branch:** dev

## Overview

OpenCode plugin fork (`oh-my-opencode` v3.15.2). Managed config, canonical agent naming, multi-model orchestration with runtime fallback, 48 hooks, 26 tools, 11 agents, 19 feature modules. Bun + TypeScript (ESNext, bundler resolution).

## Structure

```text
oh-my-openagent/
├── assets/custom-opencode/       # Managed config source of truth
│   ├── opencode.json             # Host config (providers, limits, plugins)
│   ├── oh-my-opencode.json       # Agent/model/category config
│   ├── oh-my-openagent.local.template.jsonc  # User override template
│   └── instructions/             # Non-interactive shell strategy
├── script/                       # Install + verify + validate
│   ├── install-local-opencode-fork.sh  # Zero-to-working installer
│   ├── verify-local-opencode-install.ts  # Live drift detector
│   ├── validate-effective-model-config.ts  # Model config validator
│   └── prepare-local-opencode-model-config.ts
├── src/
│   ├── index.ts                  # Plugin entry point
│   ├── plugin/                   # Hook composition + tool registry (20 files)
│   ├── plugin-handlers/          # Config → runtime agent/tool/MCP mapping (25 files)
│   ├── agents/                   # 11 agent definitions (24 files)
│   ├── hooks/                    # 48 lifecycle hooks across 5 tiers
│   │   ├── runtime-fallback/     # Model fallback on API errors (40 files) ★
│   │   ├── atlas/                # Boulder session orchestrator (33 files)
│   │   ├── anthropic-context-window-limit-recovery/ # (34 files)
│   │   ├── todo-continuation-enforcer/  # Boulder mechanism (26 files)
│   │   ├── ralph-loop/           # Self-referential dev loop (25 files)
│   │   └── ... (20+ more hook dirs)
│   ├── tools/                    # 26 tools across 15 dirs
│   │   ├── delegate-task/        # task() delegation engine (54 files)
│   │   ├── lsp/                  # Full LSP client stack (36 files)
│   │   ├── hashline-edit/        # Hash-anchored editing (29 files)
│   │   └── call-omo-agent/       # Direct agent invocation (23 files)
│   ├── features/                 # 19 standalone modules
│   │   ├── background-agent/     # Core task engine (50 files, 10k LOC)
│   │   ├── tmux-subagent/        # Tmux pane management (35 files)
│   │   ├── opencode-skill-loader/ # 4-scope skill discovery (31 files)
│   │   └── mcp-oauth/            # OAuth 2.0 + PKCE + DCR (18 files)
│   ├── shared/                   # Naming, auth, migration, utils (155 files)
│   ├── config/                   # Zod v4 schema (24 schema files)
│   ├── mcp/                      # 3 built-in remote MCPs
│   └── cli/                      # CLI: install, run, doctor, mcp-oauth
├── .opencode/                    # Plugin config + project skills
└── bin/                          # CLI binary entry
```

## Where To Look

| Task | Start Here | Then Check |
|------|-----------|------------|
| Change agent models/fallback | `assets/custom-opencode/oh-my-opencode.json` | `script/validate-effective-model-config.ts` |
| Add/rename an agent | `src/agents/`, `src/shared/agent-display-names.ts` | `src/plugin-handlers/agent-key-remapper.ts`, verifier |
| Add a new hook | `src/hooks/{name}/index.ts` | `src/plugin/hooks/create-{tier}-hooks.ts`, `src/config/schema/hooks.ts` |
| Add a new tool | `src/tools/{name}/` | `src/plugin/tool-registry.ts` |
| Debug runtime fallback | `src/hooks/runtime-fallback/error-classifier.ts` | `fallback-policy.ts`, `fallback-state.ts`, `auto-retry.ts` |
| Fix install flow | `script/install-local-opencode-fork.sh` | `script/verify-local-opencode-install.ts` |
| Add config option | `src/config/schema/{name}.ts` | `src/config/schema/oh-my-opencode-config.ts` |
| Debug background tasks | `src/features/background-agent/manager.ts` | `src/tools/delegate-task/` |
| Change skill loading | `src/features/opencode-skill-loader/loader.ts` | 4-scope priority: project > opencode > user > global |
| Add CLI command | `src/cli/cli-program.ts` | Commander.js, follow existing pattern |


## Purpose

This fork keeps the upstream package identity but changes the local install and runtime story:

- managed OpenCode config is committed in this repo
- clean installs must pin OpenCode to this local fork with `file://...`
- `Codex` OAuth is auto-bridged into OpenCode when available
- `Claude` stays configured by default and can be authorized later on demand
- user-facing runtime surfaces must expose canonical agent display names

## Host-Agent Boundary Rule

When this repo is being used to drive CI or code-fix work in a separate target repository
(for example `eurochemeopt`, `data_catalog`, or another external worktree/repo), the outer
host agent working in `oh-my-openagent` must NOT manually edit files in that target repo.

High-priority rule:

- the outer host agent may inspect the target repo, run `opencode`, monitor CI, inspect logs,
  adjust `oh-my-openagent` prompts/skills/hooks/config, and validate runtime behavior
- but target-repo code/content edits must be performed only by the in-runtime `opencode`
  executor session that the host agent launched or supervised
- if the host agent notices itself preparing to patch a target repo directly, that is a workflow
  violation and it must stop, revert to orchestration, and push the fix through `opencode`
  instead

This rule takes priority over convenience while working cross-repo CI loops from this fork.

## Source Of Truth

Start here when changing models, agent names, or local install behavior:

- `assets/custom-opencode/opencode.json`
- `assets/custom-opencode/instructions/non-interactive-shell.md`
- `assets/custom-opencode/oh-my-opencode.json`
- `assets/custom-opencode/oh-my-openagent.local.template.jsonc`
- `README.md`
- `.opencode/skills/agent-model-selection/SKILL.md`
- `script/install-local-opencode-fork.sh`
- `script/prepare-local-opencode-model-config.ts`
- `script/validate-effective-model-config.ts`
- `script/verify-local-opencode-install.ts`
- `src/shared/agent-display-names.ts`
- `src/shared/managed-opencode-runtime.ts`
- `src/plugin-handlers/agent-key-remapper.ts`
- `src/shared/codex-auth-bootstrap.ts`
- `src/hooks/runtime-fallback/*`

Keep `README.md` user-facing. Maintainer details, architectural tradeoffs, test lists, and runtime invariants belong here in `AGENTS.md`.

## Clean Install Contract

The supported zero-to-working flow is:

```bash
./script/install-local-opencode-fork.sh --reset
```

That command must remain able to:

- remove an existing OpenCode install and config while preserving auth state and the local model override file
- install `bun` and `opencode` with Homebrew when missing
- build this fork
- sync managed config into `~/.config/opencode`
- create or preserve `~/.config/opencode/oh-my-openagent.local.jsonc`
- rewrite live host config to load the plugin from `file://<repo-root>`
- install the managed runtime package set into `~/.cache/opencode`:
  - `opencode-claude-auth`
  - `opencode-helicone-session`
- keep the built-in shell-strategy equivalent wired through the managed `instructions` path in `opencode.json`
- sync `Codex` OAuth into the OpenCode auth store when `~/.codex/auth.json` exists
- validate the effective model config against a refreshed model catalog
- run a live verifier and fail hard on drift

Do not add `opencode-supermemory` to the managed baseline. It overlaps with the fork compaction stack and is an explicit opt-in integration only.

Do not weaken the verifier just to make the installer pass.

## Canonical Agent Naming

User-visible names must stay in the form:

- `Agent (Role)`

Do not reintroduce:

- plain aliases like `Sisyphus`
- duplicate keys for the same agent
- extra display variants such as `Sisyphus-Junior`

Canonical display names live in `src/shared/agent-display-names.ts`.

`explore` is the only special case:

- the runtime config key stays `explore`
- runtime-facing registry/name fields must also stay `explore`
- user-facing display surfaces must still render `Explore (Code Search)`
- this avoids a collision with OpenCode core runtime behavior

If you add or rename an agent, update:

- `src/shared/agent-display-names.ts`
- `src/shared/migration/agent-names.ts`
- `src/plugin-handlers/agent-key-remapper.ts`
- `script/verify-local-opencode-install.ts`

## Model Policy In This Fork

- Planner, reviewer, critic, advisor, and controller-style roles prefer `anthropic/claude-opus-4-7` first.
- Every non-`explore` managed agent must keep a Claude model ahead of any OpenAI/Codex model in its paid chain.
- Execution, coding, orchestration, librarian, and multimodal lanes default to `anthropic/claude-sonnet-4-6` primary unless a stronger Claude lane is explicitly warranted.
- `Explore` is the only spark-primary speed lane.
- `Sisyphus Junior` remains a fast executor lane, but it must keep `anthropic/claude-sonnet-4-6` ahead of `openai/gpt-5.4`, and `openai/gpt-5.4` ahead of `openai/gpt-5.3-codex-spark`.
- Do not move planner/review/controller roles onto `spark` primary.
- Managed host context caps must stay within live model metadata:
  - keep `openai/gpt-5.4`, `anthropic/claude-opus-4-6`, and `anthropic/claude-sonnet-4-6` at or below `200000`
  - keep `openai/gpt-5.3-codex-spark` at or below its refreshed live limit, currently `128000`
- Free-model fallbacks remain behind the full paid OpenAI/Codex + Claude chain and must survive transient failures cleanly.
- The managed free fallback chain is `opencode/nemotron-3-super-free` -> `opencode/minimax-m2.5-free` -> `opencode/big-pickle`.
- Do not rely on deprecated `models.json` entries alone when choosing OpenCode free fallbacks; live provider refresh wins over stale cache.

## Model Selection Protocol

When changing any model or fallback chain:

- use `.opencode/skills/agent-model-selection/SKILL.md`
- check official provider docs and OpenCode docs for exact model IDs and context limits
- refresh the local catalog before trusting a candidate:
  - `opencode models --refresh`
  - `opencode models opencode --refresh`
- prefer live refreshed availability over stale cache or historical docs for OpenCode free models
- validate both:
  - model ID resolves in the refreshed catalog
  - configured context caps do not exceed available model context
- update the whole scheme, not just one file:
  - managed config
  - local override template
  - installer/validator/verifier
  - tests
  - `README.md`
  - this `AGENTS.md`

Remember that users may want a different per-agent model or fallback policy. Support that through `~/.config/opencode/oh-my-openagent.local.jsonc`, not by editing the installer-managed base file.

## Runtime Fallback Policy

The live fallback implementation is the in-process TypeScript hook under `src/hooks/runtime-fallback/*`.

Do not reintroduce a second synced JS plugin layer for fallback/retry behavior.

Current policy:

- transient network/TLS/5xx/unknown failures stay on the current model first
- optional manual provider-clearance mode is available through `runtime_fallback.manual_provider_clearance_*`:
  - keep it disabled in the managed base config
  - use it only as a local opt-in override
  - when enabled, tracked Claude/Codex `403` provider blocks pause the chain on the same paid model, raise a toast with provider-clearance instructions, and only resume normal fallback after the pause window expires
- transient same-model retries must:
  - open a retry window of 15 minutes by default
  - start with a 10-second retry delay
  - increase delay between attempts over time
  - never become less frequent than once every 5 minutes
  - fall back only after that retry window expires
- transient `403 Request not allowed` / gateway-blocked `403 Forbidden` must still retry the same paid model first, but stay bounded to a small attempt cap before advancing to the next paid model
- quota, cooldown, payment, usage-limit, and free-period failures skip directly to the limit path:
  - exhaust every remaining paid OpenAI/Codex and Claude fallback in configured order
  - only then descend to free fallback models
- `Explore` stays `spark`-primary:
  - keep its limit-fallback path as `spark` -> paid `claude-sonnet-4-6` -> paid `claude-opus-4-7` -> paid `gpt-5.4` -> free models
- `Sisyphus Junior` is not `spark`-primary:
  - keep `claude-sonnet-4-6` ahead of `gpt-5.4`
  - keep `gpt-5.4` ahead of `spark`
  - keep `spark` ahead of free models
- active `session.status` events (`busy`, `running`) must refresh the watchdog with the extended long-running timeout window
- meaningful `message.part.updated` progress (`tool`, `tool_use`, `tool_result`, `compaction`, visible `text`, visible `reasoning`) must refresh the watchdog instead of clearing it
- `tool.execute.before` / `tool.execute.after` must also refresh the watchdog for long-running local tools like `read`, `write`, and `apply_patch`, because live runtimes do not always emit reliable `message.part.updated` progress for those waves
- raw or quoted watchdog continuation prompts are internal control messages and must never be treated as the last real user retry payload
- when a session is running on `spark` or a free model, background recovery probes may restore a higher-priority model
- if a stalled session is still awaiting a fallback result when recovery succeeds, the hook may auto-resume the task on the recovered model

When changing this area, inspect together:

- `src/hooks/runtime-fallback/error-classifier.ts`
- `src/hooks/runtime-fallback/fallback-policy.ts`
- `src/hooks/runtime-fallback/fallback-state.ts`
- `src/hooks/runtime-fallback/auto-retry.ts`
- `src/hooks/runtime-fallback/event-handler.ts`
- `src/hooks/runtime-fallback/message-update-handler.ts`

Minimum regression coverage for fallback changes:

```bash
bun test src/hooks/runtime-fallback/error-classifier.test.ts src/hooks/runtime-fallback/fallback-policy.test.ts src/hooks/runtime-fallback/fallback-state.test.ts src/hooks/runtime-fallback/auto-retry.recovery-probe.test.ts src/hooks/runtime-fallback/auto-retry.transient-backoff.test.ts src/hooks/runtime-fallback/event-handler.test.ts src/hooks/runtime-fallback/initial-hang-watchdog.test.ts src/hooks/runtime-fallback/index.test.ts src/hooks/runtime-fallback/session-status-handler.test.ts --bail
```

## External Plugin Policy

- Safe managed baseline additions in this fork currently include:
  - `opencode-helicone-session`
- `opencode-shell-strategy` is not a normal runtime npm plugin. Keep its behavior vendored as repo-managed instructions instead of adding a git-clone side path to the installer.
- `opencode-supermemory` must remain out of the managed baseline unless the compaction stack is intentionally redesigned around it.
- `src/shared/external-plugin-detector.ts` is where warnings for overlapping external plugins belong.

## Auth Policy

- `Codex` auth bootstrap lives in `src/shared/codex-auth-bootstrap.ts`.
- The installer and plugin startup should both be able to import OpenAI OAuth from `~/.codex/auth.json`.
- Anthropic models must remain configured even when Anthropic auth is absent.
- Missing Anthropic auth is handled later by the user with `opencode auth login -p anthropic`.
- Do not remove providers from the managed config just because auth is currently missing on one machine.

## Required Validation

Minimum checks after touching config, runtime remapping, or install flow:

```bash
bun run build
bun test src/plugin-handlers/agent-key-remapper.test.ts src/cli/doctor/checks/custom-opencode-config.test.ts --bail
bun run script/validate-effective-model-config.ts
./script/install-local-opencode-fork.sh --reset
bun run script/verify-local-opencode-install.ts
```

The live runtime is not considered fixed until the clean install path passes.

## Completion Protocol

After successful changes and green validation, finish the work end-to-end:

- create a normal commit for the completed changes
- push the branch updates to the remote
- apply the fork locally with `./script/install-local-opencode-fork.sh --reset`
- verify the live local install with `bun run script/verify-local-opencode-install.ts`

Do not stop at a green test run when the task expects a usable local runtime.
