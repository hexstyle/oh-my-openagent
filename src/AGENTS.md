# src/AGENTS.md

## Scope

`src/` contains the plugin runtime. For this fork, the important behavior is not just feature code but how startup turns managed config into the exact live OpenCode runtime.

## Files To Touch First

- `index.ts`
- `plugin-config.ts`
- `plugin-interface.ts`
- `shared/agent-display-names.ts`
- `shared/codex-auth-bootstrap.ts`
- `plugin-handlers/agent-config-handler.ts`
- `plugin-handlers/agent-key-remapper.ts`

## Runtime Rules For This Fork

- Startup must tolerate the local-fork install shape where the host config points at `file://<repo-root>`.
- Startup should preserve canonical display names for all user-visible agents.
- Startup should keep Anthropic and OpenAI models configured even if one provider is not yet logged in.
- Startup may bootstrap `Codex` auth into OpenCode, but must not silently rewrite away the managed agent model picture.

## If You Change Agent Runtime Behavior

Check all of these together:

- `assets/custom-opencode/oh-my-opencode.json`
- `shared/agent-display-names.ts`
- `shared/migration/agent-names.ts`
- `plugin-handlers/agent-key-remapper.ts`
- `plugin-handlers/agent-config-handler.ts`
- `script/verify-local-opencode-install.ts`

The verifier is the final authority on whether the runtime matches the fork contract.
