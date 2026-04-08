# src/cli/config-manager/AGENTS.md

## Scope

This directory owns install-time config writing. In this fork, install-time config is not generic wizard output. It is a managed projection of committed assets into the live OpenCode config directory.

## Files That Matter

- `add-plugin-to-opencode-config.ts`
- `config-context.ts`
- `write-omo-config.ts`
- `plugin-detection.test.ts`
- `write-omo-config.test.ts`

## Fork Rules

- Host config source of truth is `assets/custom-opencode/opencode.json`.
- Plugin config source of truth is `assets/custom-opencode/oh-my-opencode.json`.
- Live host config must end with the local plugin pin:
  - `file://<repo-root>`
  - `opencode-claude-auth`
  - `opencode-helicone-session`
  - `@nick-vi/opencode-type-inject`
- The managed host config may also reference repo-owned instruction files through `./node_modules/oh-my-openagent/...`.
- Live plugin config basename must be `oh-my-openagent.json`.
- Legacy live plugin basenames like `oh-my-opencode.json` should be removed during managed install.
- Do not let install-time helpers emit duplicate plugin entries or drift from committed assets.

## Edit Checklist

When changing how config is written, verify:

- managed assets still round-trip cleanly
- live config preserves provider limits and default agent
- no published `oh-my-openagent` dependency is introduced into `~/.cache/opencode/package.json`
- the local fork remains the active plugin after install

## Related Runtime Dependencies

Install-time config work is coupled to:

- `script/install-local-opencode-fork.sh`
- `script/verify-local-opencode-install.ts`
- `src/shared/codex-auth-bootstrap.ts`

If one changes, inspect the others.
