---
name: agent-model-selection
description: Use when changing agent models, fallback chains, model context limits, or install-time model validation for this fork. Covers how to choose models by agent role, validate live model IDs, use the local override config, and keep runtime/install/docs/test expectations consistent.
---

# Agent Model Selection

Use this skill whenever work touches:

- `assets/custom-opencode/opencode.json`
- `assets/custom-opencode/oh-my-opencode.json`
- `script/install-local-opencode-fork.sh`
- `script/validate-effective-model-config.ts`
- `script/verify-local-opencode-install.ts`
- `README.md`
- `AGENTS.md`

## Role Taxonomy

- Planner, reviewer, critic, advisor, controller:
  prefer strongest reasoning models first; mistakes here multiply downstream.
- Deep executor, coding agent:
  prefer strong coding models first; keep a paid coding-capable fallback before `spark`.
- Explore / code search:
  speed-first and read-only; `spark` can be primary if output quality remains acceptable.
- Research / docs / multimodal:
  optimize for source fidelity, context, and modality support before raw speed.

## Selection Workflow

1. Read current managed config and any user override:
   - `~/.config/opencode/oh-my-openagent.json`
   - `~/.config/opencode/oh-my-openagent.local.jsonc`
2. Check official docs first:
   - OpenCode CLI / Zen docs for provider/model IDs
   - official provider docs for model role fit and context limits
3. Refresh local model catalogs before trusting IDs:
   - `opencode models --refresh`
   - `opencode models opencode --refresh`
4. Treat live refreshed catalog as stronger evidence than stale cache or old docs for free OpenCode models.
5. Reject deprecated, removed, or disabled models from fallback chains.
6. Validate the final effective config:
   - `bun run script/validate-effective-model-config.ts`
   - `bun run script/verify-local-opencode-install.ts`

## Fork Policy

- Managed base config lives in `assets/custom-opencode/oh-my-opencode.json`.
- User-specific model and fallback changes belong in `oh-my-openagent.local.jsonc`, not in the managed base file.
- Managed `oh-my-openagent.json` is installer-owned and may be overwritten on reinstall.
- Do not reintroduce duplicate live plugin config files such as `oh-my-openagent.jsonc` or `oh-my-opencode.json`.
- In this fork's managed base policy, keep Claude ahead of OpenAI/Codex for every non-`explore` agent unless the user explicitly asks for a different lane order.
- `explore` remains the only spark-primary speed lane.
- Free fallbacks must be checked against refreshed availability and should not rely on deprecated cache-only entries.

## Consistency Checklist

- Update config assets.
- Update install or verifier logic if model-selection rules changed.
- Update tests that pin model policy.
- Update `README.md` for user-facing install/override instructions.
- Update `AGENTS.md` for maintainer rules and validation requirements.
