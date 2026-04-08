# Local vs upstream delta review

## Supported delta

This fork is no longer treated as a broad local parity playground. The supported delta is intentionally small and centered on the install/runtime contract that is required for the local OpenCode workflow.

## Managed config and install

- `assets/custom-opencode/opencode.json` and `assets/custom-opencode/oh-my-opencode.json` are the repo-owned source of truth for the live OpenCode config.
- `script/install-local-opencode-fork.sh --reset` is the supported clean-install path. It builds the fork, syncs the managed config, rewrites the live host plugin entry to `file://<repo-root>`, imports `Codex` OAuth, and finishes with `script/verify-local-opencode-install.ts`.
- `script/sync-custom-opencode-assets.ts` now syncs only the managed JSON config surface:
  - `opencode.json`
  - generated compatibility alias `oh-my-openagent.json`
- The managed config keeps the fork model policy explicit:
  - controller/review roles stay `anthropic/claude-opus-4-6` first
  - execution/search roles stay `openai/gpt-5.4` first
  - configured large-model context limits remain capped at `200000`

## Runtime behavior retained

- `src/shared/codex-auth-bootstrap.ts` bridges `~/.codex/auth.json` into the OpenCode auth store so local installs can reuse existing `Codex` OAuth.
- `src/shared/agent-display-names.ts` and `src/plugin-handlers/agent-key-remapper.ts` enforce canonical user-visible names in the form `Agent (Role)`. `explore` remains the only internal runtime-key exception and still displays as `Explore (Code Search)`.
- `src/hooks/runtime-fallback/*` is the single retained resilience path. It is wired in through `src/plugin/hooks/create-session-hooks.ts` and controlled by the managed `runtime_fallback` config.

## Deliberately removed baggage

- There is no second synced JS plugin layer for heartbeat, TLS retry, or wrapper loading anymore.
- Managed asset sync no longer copies `plugins/*.js`, wrapper loaders, or refresh scripts into the live OpenCode config directory.
- Runtime fallback ownership is intentionally singular now: the in-process TypeScript hook is the only supported fallback implementation in the local fork contract.

## Intended extension points

- `src/plugin-config.ts` keeps user config as the base and project config as the override, with deep merges for `agents` and `categories` plus unions for `disabled_*` arrays.
- `src/cli/config-manager/add-plugin-to-opencode-config.ts` keeps plugin loading explicit in the OpenCode host config, preferring `oh-my-openagent` while preserving legacy `oh-my-opencode` compatibility.
- `src/shared/jsonc-parser.ts` and migration helpers continue to support the legacy `oh-my-opencode` basename and alias, while preferring the canonical `oh-my-openagent` filename when both exist.
- `assets/oh-my-opencode.schema.json` remains the compatibility boundary for supported config overrides and runtime knobs.

## Suspicious runtime drift

No currently-accepted suspicious runtime drift remains in the supported fork contract. If a future change requires extra live assets, duplicate fallback layers, or implicit plugin loading, it should be treated as new fork surface and justified explicitly.
