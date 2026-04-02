# AGENTS.md

## Purpose

Compatibility-first fork of `code-yeongyu/oh-my-openagent`. Phase 1 keeps the upstream package and CLI identity stable while documenting and porting the local OpenCode config and plugin deltas into tracked fork assets.

## Key commands

```bash
bun test
bun run build
tsc --noEmit
bun run build:all
```

## Important directories

- `src/` - plugin, CLI, config, shared runtime code
- `docs/` - upstream docs; fork-specific notes belong under `docs/fork/`
- `assets/` - managed assets that later tasks will sync into an OpenCode config directory
- `script/` - build and support scripts
- `tests/` and `src/**/*.test.ts` - regression coverage
- `.sisyphus/` - local planning, evidence, and agent rules

## Validation commands

```bash
bun test
tsc --noEmit
bun run build
node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('package.json','utf8')); console.log(p.scripts.test, p.scripts.build, p.scripts.typecheck)"
```

## Gotchas

- Bun-only repo. Do not switch package managers.
- Preserve npm package and bin identity as `oh-my-opencode` in phase 1.
- Preserve preferred plugin identity as `oh-my-openagent`.
- Treat legacy `oh-my-opencode` basename and alias support as compatibility, not drift.
- Keep OpenCode host config (`opencode.json[c]`) separate from OhMyOpenCode plugin config.
- Require explicit plugin registration through the OpenCode `plugin` array.
- Do not rename the compatibility surface in phase 1 unless a verified blocker requires it.

## Local workflow rules

- Source of truth for managed OpenCode assets is `assets/custom-opencode/`.
- When changing agent or fallback configuration, update `assets/custom-opencode/oh-my-opencode.json` first, then sync the same content to live files:
  - `<opencode-config-dir>/oh-my-opencode.json`
  - `<opencode-config-dir>/oh-my-openagent.json`
- Keep host runtime registration in `<opencode-config-dir>/opencode.json` explicit and minimal:
  - `oh-my-openagent`
  - `@ex-machina/opencode-anthropic-auth`
- The live file `<opencode-config-dir>/plugins/oh-my-openagent.js` is a compat shim only. Do not use it as the primary plugin registration path.
- When plugin/runtime behavior conflicts with config expectations, compare in this order:
  1. `assets/custom-opencode/*`
  2. live files under `<opencode-config-dir>/*`
  3. latest OpenCode logs under `<opencode-data-dir>/log/`
- Required verification after changing fork assets or local runtime config:
  - `bun run build`
  - targeted `bun test` for touched runtime/plugin paths
  - `node bin/oh-my-opencode.js doctor --json`
  - `opencode debug config` from `E:/projects/datahub`
- Runtime checks for this fork should be done from `E:/projects/datahub`, because that is the repo where the local OpenCode workflow and failures were reproduced.
- Do not claim runtime fallback is fixed based only on unit tests. Confirm with a real OpenCode session/log when the scenario is reproducible.
