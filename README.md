# oh-my-openagent

This fork keeps the upstream package identity, but changes the local install/runtime contract for OpenCode.

Upstream reference at the last synced README:

- https://github.com/code-yeongyu/oh-my-openagent/blob/51194e943487a1783db7ca9524e514ae93472bf7/README.md

## What changes in this fork

- the OpenCode host/plugin config is managed from this repo
- clean installs are pinned to this local checkout via `file://<repo-root>`
- `Codex` OAuth is imported into OpenCode automatically when `~/.codex/auth.json` exists
- `Claude` stays configured by default and can be authorized later with `opencode auth login -p anthropic`
- runtime agent names are canonical user-facing names only, in the form `Agent (Role)`
- runtime fallback is policy-driven:
  - transient network/unknown failures retry once on the current model
  - quota/cooldown/limit failures fall back to `gpt-5.3-codex-spark`, then to free models
  - when a session is pushed down to spark/free, background recovery probes higher-priority models and can move the session back up when they become available again

Primary model picture in this fork:

- planning/review/controller roles prefer `anthropic/claude-opus-4-6`
- execution/search roles prefer `openai/gpt-5.4`
- `gpt-5.3-codex-spark` is the paid emergency fallback
- free models stay behind `spark`
- configured large-model context limits stay capped at `200000`

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

`--reset` is the supported clean path. It rebuilds the fork, syncs the managed config, pins OpenCode to this local checkout, imports `Codex` OAuth when present, and runs a live verification pass.

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
- upstream feature docs still apply unless this fork says otherwise
