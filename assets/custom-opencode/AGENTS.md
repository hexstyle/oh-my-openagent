# assets/custom-opencode/AGENTS.md

## Scope

These JSON files are the managed source of truth for the fork's live OpenCode configuration.

## Files

- `opencode.json` - host config, provider limits, plugin ids, default agent
- `oh-my-opencode.json` - agent/category config, model chains, retry/fallback behavior

## Edit Rules

- Change the target model picture here first.
- Keep large-model context limits capped at `200000`.
- Keep `Codex` and `Claude` models present by default.
- Do not remove a provider from config just because auth is currently absent on one machine.
- Remember that the installer rewrites only the live plugin entry in `opencode.json` from `oh-my-openagent` to `file://<repo-root>`.

## Related Code

After editing these assets, inspect:

- `script/install-local-opencode-fork.sh`
- `script/verify-local-opencode-install.ts`
- `src/plugin-handlers/agent-config-handler.ts`
- `src/plugin-handlers/plan-model-inheritance.ts`
- `src/shared/model-error-classifier.ts`
