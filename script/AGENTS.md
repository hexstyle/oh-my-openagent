# script/AGENTS.md

## Scope

This directory owns the reproducible local install and live verification flow for the fork.

## Primary Files

- `install-local-opencode-fork.sh`
- `verify-local-opencode-install.ts`
- `sync-custom-opencode-assets.ts`

`sync-custom-opencode-assets.ts` should copy only the managed host/plugin config surface:

- `opencode.json`
- generated live plugin config `oh-my-openagent.json` from repo source `assets/custom-opencode/oh-my-opencode.json`

The managed host config may still reference repo-owned instruction files through the `oh-my-openagent` symlink under `~/.config/opencode/node_modules/`.

## Install Contract

`install-local-opencode-fork.sh --reset` is the supported clean setup path. Keep it able to:

- uninstall `OpenCode`
- preserve auth state
- reinstall dependencies
- build the fork
- sync managed config
- pin the live plugin to `file://<repo-root>`
- install the managed runtime package set in `~/.cache/opencode`
- import `Codex` OAuth
- run a live verifier

## Verifier Contract

`verify-local-opencode-install.ts` must fail if any of these drift:

- host config
- plugin config
- runtime package dependencies
- local plugin pin
- managed instruction paths
- canonical agent names
- expected runtime modes
- expected pinned primary models

The verifier is also where the runtime alias ban is enforced.
