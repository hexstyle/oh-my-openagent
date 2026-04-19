# src/hooks/runtime-fallback/ — Runtime Model Fallback

**Generated:** 2026-04-10

## OVERVIEW

40+ files. Session Tier hook that auto-switches models when API providers return errors. Classifies errors into transient (retry same model) vs limit/quota (fall to next in chain). Manages per-session fallback state, auto-retry with backoff, optional manual provider-clearance pauses, and background recovery probes.

## ERROR CLASSIFICATION

`error-classifier.ts` maps API responses to action types:

| Error Class | Examples | Action |
|-------------|----------|--------|
| **Transient** | Network/TLS, 5xx, timeout, unknown | Retry same model (backoff) |
| **Limit** | Quota, cooldown, payment, usage-limit, free-period | Skip to next model |
| **Fatal** | Auth invalid, model not found | No retry |

## FALLBACK POLICY

`fallback-policy.ts` implements the fork's model priority:

- Transient: retry same model within 15-minute window, increasing delay, cap at 5min intervals
- Limit: exhaust every remaining paid fallback before free fallback chain
- `Explore`: spark-primary, then paid `gpt-5.4`, then paid `claude-sonnet-4-6`, then free models
- `Sisyphus Junior`: `gpt-5.4` then `claude-sonnet-4-6` then `spark` then free models
- Optional `manual_provider_clearance_*`: tracked Claude/Codex `403` blocks can pause the chain on the same paid model, show a toast with provider-clearance instructions, and only resume normal fallback after the pause window expires
- Recovery probes: when on degraded model, periodically test if higher-priority model recovered

## KEY FILES

| File | Purpose |
|------|---------|
| `index.ts` | Barrel export + hook registration |
| `hook.ts` | `createRuntimeFallbackHook()` — composes all subsystems |
| `error-classifier.ts` | `classifyError(error)` → `ErrorClass` |
| `fallback-policy.ts` | `decideFallbackAction(errorClass, state)` → retry / fallback / abort |
| `fallback-state.ts` | `FallbackState` — per-session model tracking, retry counts |
| `fallback-models.ts` | `buildFallbackChain(agent)` → ordered model list |
| `event-handler.ts` | Routes session errors through classify → decide → act |
| `event-model.ts` | Event type definitions for fallback lifecycle |
| `message-update-handler.ts` | Patch assistant messages when switching models mid-stream |
| `chat-message-handler.ts` | Handle chat-level message routing during fallback |
| `auto-retry.ts` | Transient retry engine: backoff, window management, recovery probes |
| `agent-resolver.ts` | Resolve which agent owns a session → get its fallback chain |
| `session-status-handler.ts` | Track session health: model switches, error counts |
| `session-messages.ts` | Read session messages for retry context |
| `fallback-bootstrap-model.ts` | Initial model selection on session start |
| `fallback-retry-dispatcher.ts` | Dispatch retry attempts with correct model payload |
| `retry-model-payload.ts` | Build model-specific request payload for retry |
| `last-user-retry-parts.ts` | Extract last user message parts for retry |
| `recent-completion-guard.ts` | Prevent duplicate completions during model switch |
| `visible-assistant-response.ts` | Track whether user has seen a response |
| `constants.ts` | Timing: retry window (4h), backoff base, max interval (5min) |
| `types.ts` | `ErrorClass`, `FallbackAction`, `FallbackState`, `RetryConfig` |

## TEST COVERAGE (14 test files)

| Test File | Covers |
|-----------|--------|
| `error-classifier.test.ts` | Error classification for all provider error shapes |
| `fallback-policy.test.ts` | Policy decisions: retry vs fallback vs abort |
| `fallback-state.test.ts` | State transitions, model tracking, reset behavior |
| `fallback-models.test.ts` | Chain building from agent config |
| `auto-retry.recovery-probe.test.ts` | Background recovery probe lifecycle |
| `auto-retry.transient-backoff.test.ts` | Backoff timing, window expiry |
| `auto-retry.watchdog.test.ts` | Initial hang detection |
| `event-handler.test.ts` | End-to-end error → classify → decide → act |
| `index.test.ts` | Integration: full hook lifecycle (3083 LOC) |
| `session-status-handler.test.ts` | Session health tracking |
| `message-update-handler.test.ts` | Message patching on model switch |
| `limit-fallback.test.ts` | Quota/limit immediate fallback path |
| `agent-resolver.test.ts` | Agent to fallback chain resolution |
| `dispose.test.ts` + others | Cleanup and edge cases |

## REGRESSION TEST COMMAND

```bash
bun test src/hooks/runtime-fallback/error-classifier.test.ts src/hooks/runtime-fallback/fallback-policy.test.ts src/hooks/runtime-fallback/fallback-state.test.ts src/hooks/runtime-fallback/auto-retry.recovery-probe.test.ts src/hooks/runtime-fallback/auto-retry.transient-backoff.test.ts src/hooks/runtime-fallback/index.test.ts src/hooks/runtime-fallback/session-status-handler.test.ts --bail
```

## RELATIONSHIP TO OTHER HOOKS

- `model-fallback` (Session Tier): Provider-level fallback in `chat.params` — complements this hook
- `session-recovery` (Session Tier): Handles structural errors (thinking blocks, empty content) — distinct from API errors
- `anthropic-context-window-limit-recovery`: Handles token limit errors — distinct from provider errors
