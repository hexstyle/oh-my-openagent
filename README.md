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
- the managed local baseline also installs:
  - `opencode-claude-auth`
  - `opencode-helicone-session`
  - `@nick-vi/opencode-type-inject`
  - a built-in non-interactive shell instruction set equivalent to `opencode-shell-strategy`

Primary model picture in this fork:

- planning/review/controller roles prefer `anthropic/claude-opus-4-6`
- deep execution roles prefer `openai/gpt-5.4`
- `Explore (Code Search)` and `Sisyphus Junior (Focused Executor)` are speed-first lanes on `openai/gpt-5.3-codex-spark`
- free models stay behind `spark`
- configured large-model context limits stay capped at `200000`

Primary agents and their visible fallback shape:

- `Prometheus`, `Sisyphus`, `Oracle`, `Metis`, `Momus`: `anthropic/claude-opus-4-6` -> `openai/gpt-5.4` -> `anthropic/claude-sonnet-4-6` -> `openai/gpt-5.3-codex-spark` -> free models
- `Hephaestus`, `Atlas`, `Librarian`, `Multimodal Looker`: `openai/gpt-5.4` -> paid alternates -> `openai/gpt-5.3-codex-spark` -> free models
- `Explore`, `Sisyphus Junior`: `openai/gpt-5.3-codex-spark` -> free models

Managed source of truth for this table: `assets/custom-opencode/oh-my-opencode.json`.

## Fallback behavior

- transient network/TLS/5xx/unknown failures retry on the same model first
- same-model transient retries stay alive for up to 4 hours
- the retry interval grows over time and caps at 5 minutes between attempts
- quota/cooldown/payment/usage-limit failures fall back to `gpt-5.3-codex-spark`, then to free models
- for `Explore` and `Sisyphus Junior`, `spark` is already the primary model, so their limit/fallback path is `spark` -> free models
- when a session is pushed down to `spark` or free models, background recovery probes can move it back up to stronger models when they recover

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

## Notes

- live config is written to `~/.config/opencode`
- the live plugin entry is rewritten to `file:///absolute/path/to/this/repo`
- only the managed JSON config surface is synced into the live OpenCode config dir
- `opencode-helicone-session` is inert until you configure a Helicone-backed provider
- `@nick-vi/opencode-type-inject` is active after install and augments TypeScript/Svelte reads plus adds type lookup tools
- upstream feature docs still apply unless this fork says otherwise
