# src/shared/AGENTS.md

## Scope

This directory holds the fork-critical glue for naming, migration, auth bootstrap, and fallback classification.

## Files To Know

- `agent-display-names.ts`
- `migration/agent-names.ts`
- `codex-auth-bootstrap.ts`
- `model-error-classifier.ts`
- `connected-providers-cache.ts`
- `index.ts`

## Naming Rules

- `agent-display-names.ts` is the canonical map for user-visible names.
- Keep names in `Agent (Role)` form.
- If a legacy alias must still be recognized for migration, add it in migration code, not as another visible runtime name.

## Auth Rules

- `codex-auth-bootstrap.ts` is responsible for importing `Codex` OAuth into the OpenCode auth store.
- The bootstrap should be safe to run repeatedly.
- Do not require interactive login during install just to keep OpenAI models in config.
- Anthropic auth is intentionally not auto-fabricated here; it is added later through `opencode auth login -p anthropic`.

## Fallback Rules

- `model-error-classifier.ts` must keep treating transient network, TLS/certificate, free-period, and quota-style failures as retry/fallback candidates where appropriate.
- Do not collapse those cases into a generic hard failure unless the live verifier or runtime logs prove the retry path is unsafe.
