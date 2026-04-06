# script/AGENTS.md

## Scope

This directory owns the reproducible local install and live verification flow for the fork.

## Primary Files

- `install-local-opencode-fork.sh`
- `verify-local-opencode-install.ts`
- `sync-custom-opencode-assets.ts`

## Install Contract

`install-local-opencode-fork.sh --reset` is the supported clean setup path. Keep it able to:

- uninstall `OpenCode`
- preserve auth state
- reinstall dependencies
- build the fork
- sync managed config
- pin the live plugin to `file://<repo-root>`
- import `Codex` OAuth
- run a live verifier

## Verifier Contract

`verify-local-opencode-install.ts` must fail if any of these drift:

- host config
- plugin config
- runtime package dependencies
- local plugin pin
- canonical agent names
- expected runtime modes
- expected pinned primary models

The verifier is also where the runtime alias ban is enforced.
