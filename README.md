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
  - `@nick-vi/opencode-type-inject`
  - a built-in non-interactive shell instruction set equivalent to `opencode-shell-strategy`

Primary model picture in this fork:

- planning/review/controller roles prefer `anthropic/claude-opus-4-6`
- deep execution roles prefer `openai/gpt-5.4`
- `Explore (Code Search)` is the spark-first speed lane on `openai/gpt-5.3-codex-spark`
- `Sisyphus Junior (Focused Executor)` is the fast coding lane on `openai/gpt-5.4`, with `anthropic/claude-sonnet-4-6` before `spark`
- free models stay behind every remaining paid OpenAI/Codex and Claude fallback
- the managed free chain is `opencode/nemotron-3-super-free` -> `opencode/minimax-m2.5-free` -> `opencode/big-pickle`
- managed host context caps stay conservative:
  - `openai/gpt-5.4`, `anthropic/claude-opus-4-6`, `anthropic/claude-sonnet-4-6` stay pinned at `200000`
  - `openai/gpt-5.3-codex-spark` is pinned at `128000`, because the refreshed runtime catalog currently caps it there

Primary agents and their visible fallback shape:

- `Prometheus`, `Sisyphus`, `Oracle`, `Metis`, `Momus`: `anthropic/claude-opus-4-6` -> `openai/gpt-5.4` -> `anthropic/claude-sonnet-4-6` -> `openai/gpt-5.3-codex-spark` -> free models
- `Hephaestus`, `Atlas`, `Librarian`, `Multimodal Looker`: `openai/gpt-5.4` -> paid alternates -> `openai/gpt-5.3-codex-spark` -> free models
- `Explore`: `openai/gpt-5.3-codex-spark` -> `openai/gpt-5.4` -> `anthropic/claude-sonnet-4-6` -> free models
- `Sisyphus Junior`: `openai/gpt-5.4` -> `anthropic/claude-sonnet-4-6` -> `openai/gpt-5.3-codex-spark` -> free models

Managed source of truth for this table: `assets/custom-opencode/oh-my-opencode.json`.

## Fallback behavior

- transient network/TLS/5xx/unknown failures, plus transient `403 Forbidden` / `Request not allowed`, retry on the same model first
- same-model transient retries stay alive for up to 15 minutes
- the retry interval grows over time and caps at 5 minutes between attempts
- quota/cooldown/payment/usage-limit failures exhaust the remaining paid OpenAI/Codex and Claude chain before any free model
- for `Explore`, `spark` is still the primary model, but quota fallback must continue through paid `gpt-5.4` and `claude-sonnet-4-6` before free models
- for `Sisyphus Junior`, `gpt-5.4` stays ahead of `claude-sonnet-4-6`, and `claude-sonnet-4-6` stays ahead of `spark`
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

## Notes

- live config is written to `~/.config/opencode`
- the live plugin entry is rewritten to `file:///absolute/path/to/this/repo`
- only the managed JSON config surface is synced into the live OpenCode config dir
- `opencode-helicone-session` is inert until you configure a Helicone-backed provider
- `@nick-vi/opencode-type-inject` is active after install and augments TypeScript/Svelte reads plus adds type lookup tools
- upstream feature docs still apply unless this fork says otherwise
