# AGENTS.md

## Purpose

This fork keeps the upstream package identity but changes the local install and runtime story:

- managed OpenCode config is committed in this repo
- clean installs must pin OpenCode to this local fork with `file://...`
- `Codex` OAuth is auto-bridged into OpenCode when available
- `Claude` stays configured by default and can be authorized later on demand
- user-facing runtime surfaces must expose canonical agent display names

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
  - `@nick-vi/opencode-type-inject`
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

- Architect, reviewer, critic, planner, and controller-style roles prefer `anthropic/claude-opus-4-6` first.
- Deep execution roles like `Hephaestus` and `Atlas`, plus `Librarian` and `Multimodal Looker`, prefer `openai/gpt-5.4`.
- `Explore` is the only spark-primary speed lane.
- `Sisyphus Junior` is the fast coding lane and must keep `openai/gpt-5.4` ahead of `openai/gpt-5.3-codex-spark`.
- Do not move planner/review/controller roles onto `spark` primary.
- Managed host context caps must stay within live model metadata:
  - keep `openai/gpt-5.4`, `anthropic/claude-opus-4-6`, and `anthropic/claude-sonnet-4-6` at or below `200000`
  - keep `openai/gpt-5.3-codex-spark` at or below its refreshed live limit, currently `128000`
- Free-model fallbacks remain behind the paid chain and must survive transient failures cleanly.
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
- transient same-model retries must:
  - open a retry window of 15 minutes by default
  - start with a 10-second retry delay
  - increase delay between attempts over time
  - never become less frequent than once every 5 minutes
  - fall back only after that retry window expires
- quota, cooldown, payment, usage-limit, and free-period failures skip directly to the limit path:
  - first `gpt-5.3-codex-spark`
  - then free fallback models
- `Explore` stays `spark`-primary:
  - keep its fallback path as `spark` -> free models
- `Sisyphus Junior` is not `spark`-primary:
  - keep `gpt-5.4` ahead of `spark`
  - keep `spark` ahead of free models
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
bun test src/hooks/runtime-fallback/error-classifier.test.ts src/hooks/runtime-fallback/fallback-policy.test.ts src/hooks/runtime-fallback/fallback-state.test.ts src/hooks/runtime-fallback/auto-retry.recovery-probe.test.ts src/hooks/runtime-fallback/auto-retry.transient-backoff.test.ts src/hooks/runtime-fallback/index.test.ts src/hooks/runtime-fallback/session-status-handler.test.ts --bail
```

## External Plugin Policy

- Safe managed baseline additions in this fork currently include:
  - `opencode-helicone-session`
  - `@nick-vi/opencode-type-inject`
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
