# src/plugin-handlers/AGENTS.md

## Scope

This directory turns parsed config into the runtime agent/tool/MCP/command map that OpenCode actually sees.

## Fork-Specific Runtime Constraints

- Runtime must not expose duplicate agent identities.
- User-visible agent names must be canonical display names only.
- Internal alias keys must not leak back into `app.agents()`.
- The managed model picture from `assets/custom-opencode/oh-my-opencode.json` must survive handler processing.

## Files To Inspect For Agent Issues

- `agent-config-handler.ts`
- `agent-key-remapper.ts`
- `plan-model-inheritance.ts`
- `agent-override-protection.ts`
- `agent-config-handler.test.ts`
- `agent-key-remapper.test.ts`

## Canonical Naming Rule

Canonical names come from `src/shared/agent-display-names.ts`.

Do not reintroduce:

- alias keys as display names
- lowercase config ids as display names
- multiple visible variants for one agent

Only one internal exception is allowed:

- config key `explore` stays internal because OpenCode core treats that key specially
- the runtime payload name must still be `Explore (Code Search)`

If you touch remapping logic, re-run the live verifier. Unit tests alone are not enough.

## Model Integrity Rule

These handlers must not opportunistically replace the fork's target models with fallback/free models just because auth is missing at startup. Missing auth is a runtime/login concern, not a config rewrite signal.
