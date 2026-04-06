# oh-my-openagent

This fork is based on the upstream project and assumes the upstream feature set, docs, and concepts unless this repository says otherwise.

Upstream reference at the last synced README:

- https://github.com/code-yeongyu/oh-my-openagent/blob/51194e943487a1783db7ca9524e514ae93472bf7/README.md

What this fork changes:

- self-configures `Codex` and `Claude` for `OpenCode`
- installs from zero with one local script
- keeps `Codex` and `Claude` in the config by default, even before login
- imports `Codex` OAuth into `OpenCode` automatically when `~/.codex/auth.json` exists
- keeps `Claude` auth on-demand through `opencode auth login -p anthropic`
- caps configured large-model context windows at `200000`
- adds runtime retry and fallback behavior for flaky networking, TLS/certificate failures, free-tier interruptions, and model limit failures
- removes duplicated user-visible agent names from the runtime and keeps only canonical display names

## Fork Model Layout

Primary target picture in this fork:

| Agent | Primary model |
| --- | --- |
| `Sisyphus (Ultraworker)` | `anthropic/claude-opus-4-6` |
| `Hephaestus (Deep Agent)` | `openai/gpt-5.4` |
| `Prometheus (Plan Builder)` | `anthropic/claude-opus-4-6` |
| `Atlas (Plan Executor)` | `openai/gpt-5.4` |
| `Oracle (Strategic Advisor)` | `anthropic/claude-opus-4-6` |
| `Librarian (OSS Research)` | `openai/gpt-5.4` |
| `Explore (Code Search)` | `openai/gpt-5.4` |
| `Multimodal Looker (Document Vision)` | `openai/gpt-5.4` |
| `Metis (Plan Consultant)` | `anthropic/claude-opus-4-6` |
| `Momus (Plan Critic)` | `anthropic/claude-opus-4-6` |
| `Sisyphus Junior (Focused Executor)` | `openai/gpt-5.4` |

Fallback policy in this fork:

- `Opus` roles prefer `Claude Opus` first, then `GPT-5.4`
- `GPT-5.4` roles stay on `GPT-5.4` first
- `gpt-5.3-codex-spark` is the paid emergency fallback
- free `OpenCode` models remain behind `spark`
- fallback handlers classify transient network and quota-style failures and retry/fail over instead of leaving the session wedged

## Prerequisites

- macOS with `Homebrew`
- `git`
- network access
- optional but recommended: `Codex` already logged in locally so the script can import OpenAI OAuth automatically

Notes:

- `Claude` is included in the managed config by default, but login remains user-triggered. When needed, run `opencode auth login -p anthropic`.
- If `OpenAI` auth must be refreshed later, run `opencode auth login -p openai`.

## Installation

Clone the fork and run the installer:

```bash
git clone --branch dev https://github.com/hexstyle/oh-my-openagent.git
cd oh-my-openagent
./script/install-local-opencode-fork.sh --reset
```

If the repo is already cloned locally:

```bash
cd /path/to/oh-my-openagent
./script/install-local-opencode-fork.sh --reset
```

`--reset` is the intended clean path. It removes the existing `OpenCode` install and config, preserves the auth store, reinstalls `OpenCode`, builds this fork, writes the managed config, pins the runtime to the local fork via `file://...`, imports `Codex` OAuth, and runs a live verification pass.

## What The Script Verifies

The installer ends by running `script/verify-local-opencode-install.ts`. That verifier checks:

- live host config matches `assets/custom-opencode/opencode.json`, except for the expected local `file://` plugin pin
- live plugin config matches `assets/custom-opencode/oh-my-opencode.json`
- runtime package does not pull the published `oh-my-openagent`
- runtime is loading this local fork
- canonical agent names are the only user-visible names
- runtime agent modes and pinned primary models match the managed config
- `Codex` OAuth is bridged into `OpenCode` when available
- `Claude` and `OpenAI` smoke runs succeed when their auth entries exist

## Auth Behavior

`Codex`:

- the fork reads `~/.codex/auth.json`
- if present, it syncs the OpenAI OAuth entry into `~/.local/share/opencode/auth.json`
- this happens during install and during plugin startup

`Claude`:

- the Anthropic models are configured from day one
- if auth is missing or expired, add it on demand with:

```bash
opencode auth login -p anthropic
```

Show current runtime auth:

```bash
opencode auth list
```

## Managed Files

Source of truth inside this fork:

- `assets/custom-opencode/opencode.json`
- `assets/custom-opencode/oh-my-opencode.json`

Live files written by the installer:

- `~/.config/opencode/opencode.json`
- `~/.config/opencode/oh-my-openagent.json`

Important runtime detail:

- the committed asset uses `oh-my-openagent` as the plugin id
- the installer rewrites the live host config to `file:///absolute/path/to/this/repo`
- this is required so clean installs always run the local fork, not a published npm copy

## Canonical Agent Naming

User-visible agent names in this fork must stay canonical:

- `Agent (Role)`

Examples:

- `Sisyphus (Ultraworker)`
- `Prometheus (Plan Builder)`
- `Oracle (Strategic Advisor)`

Short aliases, plain names, and duplicate runtime labels are intentionally forbidden from user-visible runtime lists. The only allowed internal exception is the `explore` config key, which is preserved to avoid colliding with an OpenCode core agent key while still exposing the canonical display name `Explore (Code Search)`.

## Developer Notes

When changing this fork, start with:

- `AGENTS.md`
- `assets/custom-opencode/AGENTS.md`
- `script/AGENTS.md`
- `src/cli/config-manager/AGENTS.md`
- `src/plugin-handlers/AGENTS.md`
- `src/shared/AGENTS.md`

Those files explain where to edit:

- managed assets
- install-time config writing
- runtime agent remapping
- auth bootstrap
- live verification rules

## Manual Validation

Useful commands after editing the fork:

```bash
bun run build
bun run script/verify-local-opencode-install.ts
./script/install-local-opencode-fork.sh --reset
opencode auth list
opencode run --agent 'Prometheus (Plan Builder)' 'Reply with OK only.'
opencode run --agent 'Hephaestus (Deep Agent)' 'Reply with OK only.'
```
