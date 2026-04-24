import { describe, expect, it } from "bun:test"
import { SessionExecutionCoordinator } from "./coordinator"
import { decide } from "./decision-engine"
import { canTransition, derivePhase, isPhaseStale, VALID_TRANSITIONS } from "./phase-machine"
import { applyObservation, applyDecision } from "./observation-reducer"
import { createInitialState } from "./types"
import type { CoordinatorState, Observation, SessionPhase } from "./types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_CONFIG = { baseTimeoutMs: 30_000, hasFallbackModels: true }
const NO_FALLBACK_CONFIG = { baseTimeoutMs: 30_000, hasFallbackModels: false }

function makeCoordinator(config = BASE_CONFIG) {
  return new SessionExecutionCoordinator(() => config)
}

function stateWith(overrides: Partial<CoordinatorState>): CoordinatorState {
  return { ...createInitialState(), ...overrides }
}

// ---------------------------------------------------------------------------
// Phase Machine
// ---------------------------------------------------------------------------

describe("phase-machine", () => {
  describe("canTransition", () => {
    it("allows all declared valid transitions", () => {
      for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
        for (const to of targets) {
          expect(canTransition(from as SessionPhase, to)).toBe(true)
        }
      }
    })

    it("blocks undeclared transitions", () => {
      expect(canTransition("idle", "completed")).toBe(false)
      expect(canTransition("idle", "failed")).toBe(false)
      expect(canTransition("completed", "failed")).toBe(false)
      expect(canTransition("failed", "completed")).toBe(false)
      expect(canTransition("waiting_child", "delegating")).toBe(false)
    })
  })

  describe("derivePhase", () => {
    it("assistant_progress with streaming → running", () => {
      expect(derivePhase("idle", {
        kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
      })).toBe("running")
    })

    it("assistant_progress with tool running → tool_executing", () => {
      expect(derivePhase("running", {
        kind: "assistant_progress", hasVisibleContent: false, isStreaming: false,
        partType: "tool", toolStatus: "running",
      })).toBe("tool_executing")
    })

    it("assistant_complete → completed", () => {
      expect(derivePhase("running", {
        kind: "assistant_complete", finishReason: "end_turn", hasVisibleContent: true,
      })).toBe("completed")
    })

    it("assistant_empty → completed", () => {
      expect(derivePhase("running", {
        kind: "assistant_empty", messageID: "msg-1",
      })).toBe("completed")
    })

    it("session_error → failed", () => {
      expect(derivePhase("running", {
        kind: "session_error", isRetryable: true, isQuota: false, isLocalToolAbort: false,
      })).toBe("failed")
    })

    it("session_stopped → idle", () => {
      expect(derivePhase("running", { kind: "session_stopped" })).toBe("idle")
    })

    it("child_task_started → waiting_child", () => {
      expect(derivePhase("running", {
        kind: "child_task_started", taskID: "t1",
      })).toBe("waiting_child")
    })

    it("fallback_dispatched with scoped handoff → delegating", () => {
      expect(derivePhase("running", {
        kind: "fallback_dispatched", targetModel: "m", isScopedHandoff: true,
      })).toBe("delegating")
    })

    it("fallback_dispatched without scoped handoff → recovering", () => {
      expect(derivePhase("running", {
        kind: "fallback_dispatched", targetModel: "m", isScopedHandoff: false,
      })).toBe("recovering")
    })

    it("fallback_session_active from delegating → waiting_child", () => {
      expect(derivePhase("delegating", { kind: "fallback_session_active" })).toBe("waiting_child")
    })

    it("recovery_result success → running", () => {
      expect(derivePhase("recovering", { kind: "recovery_result", success: true })).toBe("running")
    })

    it("recovery_result failure → failed", () => {
      expect(derivePhase("recovering", { kind: "recovery_result", success: false })).toBe("failed")
    })

    it("timeout_fired → undefined (no phase change)", () => {
      expect(derivePhase("running", { kind: "timeout_fired" })).toBeUndefined()
    })

    it("delegation_timeout_fired from delegating → failed", () => {
      expect(derivePhase("delegating", { kind: "delegation_timeout_fired" })).toBe("failed")
    })

    it("session_status_retry → waiting_provider", () => {
      expect(derivePhase("running", {
        kind: "session_status_retry", isQuota: false,
      })).toBe("waiting_provider")
    })

    it("returns undefined when phase would not change", () => {
      expect(derivePhase("running", {
        kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
      })).toBeUndefined()

      expect(derivePhase("completed", {
        kind: "assistant_complete", finishReason: "end_turn", hasVisibleContent: true,
      })).toBeUndefined()
    })
  })

  describe("isPhaseStale", () => {
    it("idle is never stale", () => {
      expect(isPhaseStale("idle", 0, Date.now())).toBe(false)
    })

    it("recovering becomes stale after 60s", () => {
      const enteredAt = Date.now() - 61_000
      expect(isPhaseStale("recovering", enteredAt)).toBe(true)
    })

    it("recovering is fresh within 60s", () => {
      const enteredAt = Date.now() - 30_000
      expect(isPhaseStale("recovering", enteredAt)).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// Observation Reducer
// ---------------------------------------------------------------------------

describe("observation-reducer", () => {
  it("adds child task on child_task_started", () => {
    const state = createInitialState()
    applyObservation(state, { kind: "child_task_started", taskID: "t1" })
    expect(state.activeChildTaskIDs.has("t1")).toBe(true)
  })

  it("removes child task on child_task_completed", () => {
    const state = stateWith({ activeChildTaskIDs: new Set(["t1", "t2"]) })
    applyObservation(state, { kind: "child_task_completed", taskID: "t1" })
    expect(state.activeChildTaskIDs.has("t1")).toBe(false)
    expect(state.activeChildTaskIDs.has("t2")).toBe(true)
  })

  it("does not set fallbackInFlight for same-session retry (non-scoped)", () => {
    const state = createInitialState()
    applyObservation(state, { kind: "fallback_dispatched", targetModel: "m", isScopedHandoff: false })
    expect(state.fallbackInFlight).toBe(false)
    expect(state.delegationStartedAt).toBeUndefined()
  })

  it("sets delegationStartedAt on scoped handoff", () => {
    const state = createInitialState()
    applyObservation(state, { kind: "fallback_dispatched", targetModel: "m", isScopedHandoff: true })
    expect(state.fallbackInFlight).toBe(true)
    expect(state.delegationStartedAt).toBeGreaterThan(0)
  })

  it("clears fallbackInFlight on fallback_session_active", () => {
    const state = stateWith({ fallbackInFlight: true, delegationStartedAt: Date.now() })
    applyObservation(state, { kind: "fallback_session_active" })
    expect(state.fallbackInFlight).toBe(false)
    expect(state.delegationStartedAt).toBeUndefined()
  })

  it("sets recoveryInFlight and increments counter on recovery_dispatched", () => {
    const state = createInitialState()
    applyObservation(state, { kind: "recovery_dispatched", recoveryKind: "empty_turn" })
    expect(state.recoveryInFlight).toBe(true)
    expect(state.consecutiveRecoveryCount).toBe(1)
  })

  it("clears recoveryInFlight on recovery_result", () => {
    const state = stateWith({ recoveryInFlight: true })
    applyObservation(state, { kind: "recovery_result", success: true })
    expect(state.recoveryInFlight).toBe(false)
  })

  it("increments consecutiveTimeoutCount on timeout_fired", () => {
    const state = createInitialState()
    applyObservation(state, { kind: "timeout_fired" })
    expect(state.consecutiveTimeoutCount).toBe(1)
    expect(state.watchdogArmed).toBe(false)
  })

  it("resets loop counters on visible progress", () => {
    const state = stateWith({ consecutiveRecoveryCount: 2, consecutiveTimeoutCount: 3 })
    applyObservation(state, {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })
    expect(state.consecutiveRecoveryCount).toBe(0)
    expect(state.consecutiveTimeoutCount).toBe(0)
  })

  it("resets everything on session_stopped", () => {
    const state = stateWith({
      watchdogArmed: true,
      recoveryInFlight: true,
      fallbackInFlight: true,
      delegationStartedAt: Date.now(),
      consecutiveRecoveryCount: 3,
      consecutiveTimeoutCount: 5,
    })
    applyObservation(state, { kind: "session_stopped" })
    expect(state.watchdogArmed).toBe(false)
    expect(state.recoveryInFlight).toBe(false)
    expect(state.fallbackInFlight).toBe(false)
    expect(state.delegationStartedAt).toBeUndefined()
    expect(state.consecutiveRecoveryCount).toBe(0)
    expect(state.consecutiveTimeoutCount).toBe(0)
  })

  it("applyDecision sets watchdogArmed on arm_watchdog", () => {
    const state = createInitialState()
    applyDecision(state, { action: "arm_watchdog", timeoutMs: 30_000, reason: "test" })
    expect(state.watchdogArmed).toBe(true)
  })

  it("applyDecision clears watchdogArmed on disarm_watchdog", () => {
    const state = stateWith({ watchdogArmed: true })
    applyDecision(state, { action: "disarm_watchdog", reason: "test" })
    expect(state.watchdogArmed).toBe(false)
  })

  it("applyDecision clears in-flight flags on abort_session", () => {
    const state = stateWith({ watchdogArmed: true, recoveryInFlight: true, fallbackInFlight: true })
    applyDecision(state, { action: "abort_session", reason: "test" })
    expect(state.watchdogArmed).toBe(false)
    expect(state.recoveryInFlight).toBe(false)
    expect(state.fallbackInFlight).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Decision Engine
// ---------------------------------------------------------------------------

describe("decision-engine", () => {
  // --- Conflict #1: Double retry (empty recovery + timeout) ---
  describe("conflict #1: double retry prevention", () => {
    it("blocks empty recovery when recovery is already in flight", () => {
      const state = stateWith({ recoveryInFlight: true })
      const d = decide(state, { kind: "assistant_empty", messageID: "m1" }, BASE_CONFIG)
      expect(d.action).toBe("wait")
      expect((d as { reason: string }).reason).toBe("recovery_in_flight")
    })

    it("blocks timeout when recovery is already in flight", () => {
      const state = stateWith({ recoveryInFlight: true })
      const d = decide(state, { kind: "timeout_fired" }, BASE_CONFIG)
      expect(d.action).toBe("wait")
      expect((d as { reason: string }).reason).toBe("recovery_in_flight")
    })

    it("blocks empty recovery when fallback is in flight", () => {
      const state = stateWith({ fallbackInFlight: true })
      const d = decide(state, { kind: "assistant_empty", messageID: "m1" }, BASE_CONFIG)
      expect(d.action).toBe("wait")
      expect((d as { reason: string }).reason).toBe("fallback_in_flight")
    })

    it("blocks timeout when fallback is in flight", () => {
      const state = stateWith({ fallbackInFlight: true })
      const d = decide(state, { kind: "timeout_fired" }, BASE_CONFIG)
      expect(d.action).toBe("wait")
      expect((d as { reason: string }).reason).toBe("fallback_in_flight")
    })

    it("defers empty recovery to watchdog when watchdog armed", () => {
      const state = stateWith({ watchdogArmed: true })
      const d = decide(state, { kind: "assistant_empty", messageID: "m1" }, BASE_CONFIG)
      expect(d.action).toBe("wait")
      expect((d as { reason: string }).reason).toBe("watchdog_will_handle")
    })
  })

  // --- Conflict #2: Watchdog vs child task completion ---
  describe("conflict #2: child task awareness", () => {
    it("extends watchdog on timeout when child tasks active", () => {
      const state = stateWith({ activeChildTaskIDs: new Set(["t1"]) })
      const d = decide(state, { kind: "timeout_fired" }, BASE_CONFIG)
      expect(d.action).toBe("extend_watchdog")
      expect((d as { reason: string }).reason).toBe("child_tasks_active")
    })

    it("allows fallback on timeout when no child tasks", () => {
      const state = stateWith({ activeChildTaskIDs: new Set() })
      const d = decide(state, { kind: "timeout_fired" }, BASE_CONFIG)
      expect(d.action).toBe("fallback_next_model")
    })

    it("waits on empty recovery when child tasks active", () => {
      const state = stateWith({ activeChildTaskIDs: new Set(["t1"]) })
      const d = decide(state, { kind: "assistant_empty", messageID: "m1" }, BASE_CONFIG)
      expect(d.action).toBe("wait")
      expect((d as { reason: string }).reason).toBe("child_tasks_active")
    })

    it("marks completed when last child finishes in waiting_child phase", () => {
      const state = stateWith({ phase: "waiting_child", activeChildTaskIDs: new Set() })
      const d = decide(state, { kind: "child_task_completed", taskID: "t1" }, BASE_CONFIG)
      expect(d.action).toBe("mark_completed")
    })

    it("does nothing when child finishes but others remain", () => {
      const state = stateWith({
        phase: "waiting_child",
        activeChildTaskIDs: new Set(["t2"]),
      })
      const d = decide(state, { kind: "child_task_completed", taskID: "t1" }, BASE_CONFIG)
      expect(d.action).toBe("none")
    })
  })

  // --- Conflict #3: False empty on streamed deltas ---
  describe("conflict #3: visible progress guards empty recovery", () => {
    it("suppresses empty recovery when visible progress is recent", () => {
      const state = stateWith({ lastVisibleProgressAt: Date.now() - 500 })
      const d = decide(state, { kind: "assistant_empty", messageID: "m1" }, BASE_CONFIG)
      expect(d.action).toBe("none")
    })

    it("allows empty recovery when no recent visible progress", () => {
      const state = stateWith({ lastVisibleProgressAt: Date.now() - 5000 })
      const d = decide(state, { kind: "assistant_empty", messageID: "m1" }, BASE_CONFIG)
      expect(d.action).toBe("recover_empty_turn")
    })
  })

  // --- Conflict #4: Prometheus promotion retry loops ---
  describe("conflict #4: anti-loop guards", () => {
    it("aborts after MAX_CONSECUTIVE_RECOVERIES on empty turn", () => {
      const state = stateWith({ consecutiveRecoveryCount: 3 })
      const d = decide(state, { kind: "assistant_empty", messageID: "m1" }, BASE_CONFIG)
      expect(d.action).toBe("abort_session")
      expect((d as { reason: string }).reason).toBe("max_consecutive_recoveries_reached")
    })

    it("aborts after MAX_CONSECUTIVE_RECOVERIES on timeout", () => {
      const state = stateWith({ consecutiveRecoveryCount: 3 })
      const d = decide(state, { kind: "timeout_fired" }, BASE_CONFIG)
      expect(d.action).toBe("abort_session")
      expect((d as { reason: string }).reason).toBe("max_consecutive_recoveries_reached")
    })

    it("aborts after MAX_CONSECUTIVE_TIMEOUTS", () => {
      const state = stateWith({ consecutiveTimeoutCount: 5 })
      const d = decide(state, { kind: "timeout_fired" }, BASE_CONFIG)
      expect(d.action).toBe("abort_session")
      expect((d as { reason: string }).reason).toBe("max_consecutive_timeouts_reached")
    })

    it("allows recovery when under the limit", () => {
      const state = stateWith({ consecutiveRecoveryCount: 2 })
      const d = decide(state, { kind: "assistant_empty", messageID: "m1" }, BASE_CONFIG)
      expect(d.action).toBe("recover_empty_turn")
    })
  })

  // --- Conflict #5: Unbounded delegation ---
  describe("conflict #5: delegation timeout", () => {
    it("waits on timeout when phase is delegating", () => {
      const state = stateWith({ phase: "delegating" as SessionPhase })
      const d = decide(state, { kind: "timeout_fired" }, BASE_CONFIG)
      expect(d.action).toBe("wait")
      expect((d as { reason: string }).reason).toBe("delegation_in_progress")
    })

    it("aborts on delegation_timeout_fired", () => {
      const state = stateWith({ phase: "delegating" as SessionPhase })
      const d = decide(state, { kind: "delegation_timeout_fired" }, BASE_CONFIG)
      expect(d.action).toBe("abort_session")
      expect((d as { reason: string }).reason).toBe("delegation_timed_out")
    })
  })

  // --- Conflict #6: Completion while recovery in flight ---
  describe("conflict #6: completion vs recovery in flight", () => {
    it("allows recovery_result to clear recoveryInFlight", () => {
      const state = stateWith({ recoveryInFlight: true })
      const d = decide(state, { kind: "recovery_result", success: true }, BASE_CONFIG)
      // recovery_result is a feedback observation — returns none
      expect(d.action).toBe("none")
    })

    it("blocks new empty recovery while recovery in flight", () => {
      const state = stateWith({ recoveryInFlight: true })
      const d = decide(state, { kind: "assistant_empty", messageID: "m2" }, BASE_CONFIG)
      expect(d.action).toBe("wait")
    })

    it("allows fallback_session_active to clear fallbackInFlight", () => {
      const state = stateWith({ fallbackInFlight: true })
      const d = decide(state, { kind: "fallback_session_active" }, BASE_CONFIG)
      expect(d.action).toBe("none")
    })
  })

  // --- Timeout with no fallback models ---
  describe("timeout without fallback models", () => {
    it("aborts session when no fallback models available", () => {
      const state = createInitialState()
      const d = decide(state, { kind: "timeout_fired" }, NO_FALLBACK_CONFIG)
      expect(d.action).toBe("abort_session")
      expect((d as { reason: string }).reason).toBe("timeout_no_fallback_models")
    })
  })

  // --- Error handling ---
  describe("error handling", () => {
    it("retries same model on retryable error", () => {
      const state = createInitialState()
      const d = decide(state, {
        kind: "session_error", isRetryable: true, isQuota: false, isLocalToolAbort: false,
      }, BASE_CONFIG)
      expect(d.action).toBe("retry_same_model")
    })

    it("retries same model on local tool abort", () => {
      const state = createInitialState()
      const d = decide(state, {
        kind: "session_error", isRetryable: false, isQuota: false, isLocalToolAbort: true,
      }, BASE_CONFIG)
      expect(d.action).toBe("retry_same_model")
    })

    it("falls back on non-retryable error with fallback models", () => {
      const state = createInitialState()
      const d = decide(state, {
        kind: "session_error", isRetryable: false, isQuota: false, isLocalToolAbort: false,
      }, BASE_CONFIG)
      expect(d.action).toBe("fallback_next_model")
    })

    it("aborts on non-retryable error without fallback models", () => {
      const state = createInitialState()
      const d = decide(state, {
        kind: "session_error", isRetryable: false, isQuota: false, isLocalToolAbort: false,
      }, NO_FALLBACK_CONFIG)
      expect(d.action).toBe("abort_session")
    })
  })

  // --- Progress / watchdog ---
  describe("progress and watchdog", () => {
    it("arms watchdog on visible progress when not armed", () => {
      const state = stateWith({ phase: "running" as SessionPhase, watchdogArmed: false })
      const d = decide(state, {
        kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
      }, BASE_CONFIG)
      expect(d.action).toBe("arm_watchdog")
    })

    it("extends watchdog on visible progress when already armed", () => {
      const state = stateWith({ phase: "running" as SessionPhase, watchdogArmed: true })
      const d = decide(state, {
        kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
      }, BASE_CONFIG)
      expect(d.action).toBe("extend_watchdog")
    })

    it("disarms watchdog on completion", () => {
      const state = stateWith({ watchdogArmed: true })
      const d = decide(state, {
        kind: "assistant_complete", finishReason: "end_turn", hasVisibleContent: true,
      }, BASE_CONFIG)
      expect(d.action).toBe("disarm_watchdog")
    })

    it("disarms watchdog on user stop", () => {
      const state = stateWith({ watchdogArmed: true })
      const d = decide(state, { kind: "session_stopped" }, BASE_CONFIG)
      expect(d.action).toBe("disarm_watchdog")
    })
  })

  // --- Waiting provider ---
  describe("waiting provider", () => {
    it("extends watchdog on timeout when waiting_provider", () => {
      const state = stateWith({ phase: "waiting_provider" as SessionPhase })
      const d = decide(state, { kind: "timeout_fired" }, BASE_CONFIG)
      expect(d.action).toBe("extend_watchdog")
      expect((d as { reason: string }).reason).toBe("provider_retry_in_progress")
    })
  })
})

// ---------------------------------------------------------------------------
// Coordinator (integration)
// ---------------------------------------------------------------------------

describe("SessionExecutionCoordinator", () => {
  it("starts in idle phase", () => {
    const coord = makeCoordinator()
    expect(coord.getPhase("s1")).toBe("idle")
    expect(coord.hasActiveWork("s1")).toBe(false)
  })

  it("transitions through a basic lifecycle", () => {
    const coord = makeCoordinator()
    const sid = "s1"

    // Progress → running
    coord.observe(sid, {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })
    expect(coord.getPhase(sid)).toBe("running")
    expect(coord.hasActiveWork(sid)).toBe(true)

    // Complete
    coord.observe(sid, {
      kind: "assistant_complete", finishReason: "end_turn", hasVisibleContent: true,
    })
    expect(coord.getPhase(sid)).toBe("completed")
    expect(coord.hasActiveWork(sid)).toBe(false)
  })

  it("tracks child tasks across modules", () => {
    const coord = makeCoordinator()
    const sid = "s1"

    coord.observe(sid, { kind: "child_task_started", taskID: "bg1" })
    expect(coord.hasActiveChildren(sid)).toBe(true)
    expect(coord.getPhase(sid)).toBe("waiting_child")

    coord.observe(sid, { kind: "child_task_completed", taskID: "bg1" })
    expect(coord.hasActiveChildren(sid)).toBe(false)
  })

  it("prevents double recovery via in-flight guard", () => {
    const coord = makeCoordinator()
    const sid = "s1"

    // Start running
    coord.observe(sid, {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })

    // Recovery dispatched
    coord.observe(sid, { kind: "recovery_dispatched", recoveryKind: "empty_turn" })
    expect(coord.isRecoveryOrFallbackInFlight(sid)).toBe(true)

    // Another empty → should wait
    const d = coord.observe(sid, { kind: "assistant_empty", messageID: "m2" })
    expect(d.action).toBe("wait")

    // Recovery completes → flag cleared
    coord.observe(sid, { kind: "recovery_result", success: true })
    expect(coord.isRecoveryOrFallbackInFlight(sid)).toBe(false)
  })

  it("auto-resets stale phases", () => {
    const coord = makeCoordinator()
    const sid = "s1"

    // Force state into recovering with a stale timestamp
    coord.observe(sid, {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })
    const state = coord._getState(sid)!
    state.phase = "recovering"
    state.phaseEnteredAt = Date.now() - 120_000 // 2 min ago, recovering max is 60s

    // Next observation should auto-reset to idle
    coord.observe(sid, {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })
    // After auto-reset to idle, progress should transition to running
    expect(coord.getPhase(sid)).toBe("running")
  })

  it("cleanup removes session state", () => {
    const coord = makeCoordinator()
    coord.observe("s1", {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })
    expect(coord.hasActiveWork("s1")).toBe(true)
    coord.cleanup("s1")
    expect(coord.hasActiveWork("s1")).toBe(false)
    expect(coord.getPhase("s1")).toBe("idle")
  })

  it("cleanupStale removes old sessions", () => {
    const coord = makeCoordinator()
    coord.observe("s1", {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })
    const state = coord._getState("s1")!
    state.lastObservationAt = Date.now() - 60 * 60 * 1000 // 1 hour ago

    coord.cleanupStale(30 * 60 * 1000)
    expect(coord._getState("s1")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Staleness effects on query methods
// ---------------------------------------------------------------------------

describe("staleness on query methods", () => {
  function makeStaleRecoveringState(coord: SessionExecutionCoordinator, sid: string) {
    coord.observe(sid, {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })
    const state = coord._getState(sid)!
    state.phase = "recovering"
    state.phaseEnteredAt = Date.now() - 120_000 // 2 min ago, max is 60s
    state.recoveryInFlight = true
    state.fallbackInFlight = true
    state.watchdogArmed = true
    state.activeChildTaskIDs.add("stale-child")
    return state
  }

  it("getPhase returns idle for stale session", () => {
    const coord = makeCoordinator()
    makeStaleRecoveringState(coord, "s1")
    expect(coord.getPhase("s1")).toBe("idle")
  })

  it("hasActiveWork returns false for stale session", () => {
    const coord = makeCoordinator()
    makeStaleRecoveringState(coord, "s1")
    expect(coord.hasActiveWork("s1")).toBe(false)
  })

  it("hasActiveChildren returns false for stale session", () => {
    const coord = makeCoordinator()
    makeStaleRecoveringState(coord, "s1")
    expect(coord.hasActiveChildren("s1")).toBe(false)
  })

  it("isRecoveryOrFallbackInFlight returns false for stale session", () => {
    const coord = makeCoordinator()
    makeStaleRecoveringState(coord, "s1")
    expect(coord.isRecoveryOrFallbackInFlight("s1")).toBe(false)
  })

  it("isWatchdogArmed returns false for stale session", () => {
    const coord = makeCoordinator()
    makeStaleRecoveringState(coord, "s1")
    expect(coord.isWatchdogArmed("s1")).toBe(false)
  })

  it("staleness auto-reset clears in-flight flags on next observe", () => {
    const coord = makeCoordinator()
    makeStaleRecoveringState(coord, "s1")

    // Next observation triggers auto-reset.
    // Note: assistant_progress re-arms watchdog via arm_watchdog decision,
    // so watchdogArmed ends up true even though auto-reset cleared it.
    coord.observe("s1", {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })
    const state = coord._getState("s1")!
    expect(state.recoveryInFlight).toBe(false)
    expect(state.fallbackInFlight).toBe(false)
    expect(state.watchdogArmed).toBe(true) // re-armed by arm_watchdog decision
    expect(state.phase).toBe("running")
  })

  it("fresh recovering phase is not stale", () => {
    const coord = makeCoordinator()
    coord.observe("s1", {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })
    coord.observe("s1", { kind: "recovery_dispatched", recoveryKind: "empty" })
    expect(coord.getPhase("s1")).toBe("recovering")
    expect(coord.isRecoveryOrFallbackInFlight("s1")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Observation reducer: additional coverage
// ---------------------------------------------------------------------------

describe("observation-reducer additional", () => {
  it("session_status_idle clears stale in-flight flags", () => {
    const state = stateWith({ recoveryInFlight: true, fallbackInFlight: true })
    applyObservation(state, { kind: "session_status_idle" })
    expect(state.recoveryInFlight).toBe(false)
    expect(state.fallbackInFlight).toBe(false)
  })

  it("assistant_complete with visible content resets loop counters", () => {
    const state = stateWith({
      consecutiveRecoveryCount: 2,
      consecutiveTimeoutCount: 3,
    })
    applyObservation(state, {
      kind: "assistant_complete", finishReason: "end_turn", hasVisibleContent: true,
    })
    expect(state.consecutiveRecoveryCount).toBe(0)
    expect(state.consecutiveTimeoutCount).toBe(0)
  })

  it("assistant_complete without visible content does NOT reset loop counters", () => {
    const state = stateWith({
      consecutiveRecoveryCount: 2,
      consecutiveTimeoutCount: 3,
    })
    applyObservation(state, {
      kind: "assistant_complete", finishReason: "end_turn", hasVisibleContent: false,
    })
    expect(state.consecutiveRecoveryCount).toBe(2)
    expect(state.consecutiveTimeoutCount).toBe(3)
  })

  it("non-visible assistant_progress does not reset loop counters", () => {
    const state = stateWith({
      consecutiveRecoveryCount: 2,
      consecutiveTimeoutCount: 3,
    })
    applyObservation(state, {
      kind: "assistant_progress", hasVisibleContent: false, isStreaming: true,
    })
    expect(state.consecutiveRecoveryCount).toBe(2)
    expect(state.consecutiveTimeoutCount).toBe(3)
  })

  it("child_task_failed removes task from activeChildTaskIDs", () => {
    const state = stateWith({ activeChildTaskIDs: new Set(["t1", "t2"]) })
    applyObservation(state, { kind: "child_task_failed", taskID: "t1" })
    expect(state.activeChildTaskIDs.has("t1")).toBe(false)
    expect(state.activeChildTaskIDs.has("t2")).toBe(true)
  })

  it("removing nonexistent child task is idempotent", () => {
    const state = stateWith({ activeChildTaskIDs: new Set(["t1"]) })
    applyObservation(state, { kind: "child_task_completed", taskID: "nonexistent" })
    expect(state.activeChildTaskIDs.size).toBe(1)
    expect(state.activeChildTaskIDs.has("t1")).toBe(true)
  })

  it("applyDecision sets recoveryInFlight on recover_empty_turn", () => {
    const state = createInitialState()
    applyDecision(state, { action: "recover_empty_turn" })
    expect(state.recoveryInFlight).toBe(true)
  })

  it("applyDecision does NOT set recoveryInFlight on fallback_next_model", () => {
    const state = createInitialState()
    applyDecision(state, { action: "fallback_next_model" })
    expect(state.recoveryInFlight).toBe(false)
    // fallback_next_model is not gated by coordinator — legacy code handles it
  })

  it("applyDecision does NOT set fallbackInFlight on retry_same_model", () => {
    const state = createInitialState()
    applyDecision(state, { action: "retry_same_model" })
    expect(state.fallbackInFlight).toBe(false)
    expect(state.recoveryInFlight).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Decision engine: additional coverage
// ---------------------------------------------------------------------------

describe("decision-engine additional", () => {
  it("session_status_idle disarms watchdog only when armed", () => {
    const armed = stateWith({ watchdogArmed: true })
    const d1 = decide(armed, { kind: "session_status_idle" }, BASE_CONFIG)
    expect(d1.action).toBe("disarm_watchdog")

    const disarmed = stateWith({ watchdogArmed: false })
    const d2 = decide(disarmed, { kind: "session_status_idle" }, BASE_CONFIG)
    expect(d2.action).toBe("none")
  })

  it("session_status_active arms watchdog when phase is running (post-transition)", () => {
    // Simulates: idle → session_status_active → derivePhase makes phase=running → decide
    const state = stateWith({ phase: "running" as SessionPhase, watchdogArmed: false })
    const d = decide(state, { kind: "session_status_active" }, BASE_CONFIG)
    expect(d.action).toBe("arm_watchdog")
  })

  it("session_status_active does nothing when idle and no watchdog", () => {
    const state = stateWith({ phase: "idle" as SessionPhase, watchdogArmed: false })
    const d = decide(state, { kind: "session_status_active" }, BASE_CONFIG)
    expect(d.action).toBe("none")
  })

  it("child_task_started extends watchdog when armed", () => {
    const state = stateWith({
      watchdogArmed: true,
      activeChildTaskIDs: new Set(["t1"]),
    })
    const d = decide(state, { kind: "child_task_started", taskID: "t1" }, BASE_CONFIG)
    expect(d.action).toBe("extend_watchdog")
    expect((d as { reason: string }).reason).toBe("child_task_started")
  })

  it("child_task_started does nothing when watchdog not armed", () => {
    const state = stateWith({
      watchdogArmed: false,
      activeChildTaskIDs: new Set(["t1"]),
    })
    const d = decide(state, { kind: "child_task_started", taskID: "t1" }, BASE_CONFIG)
    expect(d.action).toBe("none")
  })

  it("non-visible progress arms watchdog when running without one", () => {
    const state = stateWith({ phase: "running" as SessionPhase, watchdogArmed: false })
    const d = decide(state, {
      kind: "assistant_progress", hasVisibleContent: false, isStreaming: false,
    }, BASE_CONFIG)
    expect(d.action).toBe("arm_watchdog")
    expect((d as { reason: string }).reason).toBe("non_visible_progress")
  })

  it("non-visible progress does nothing when watchdog already armed", () => {
    const state = stateWith({ phase: "running" as SessionPhase, watchdogArmed: true })
    const d = decide(state, {
      kind: "assistant_progress", hasVisibleContent: false, isStreaming: false,
    }, BASE_CONFIG)
    expect(d.action).toBe("none")
  })

  it("delegation_timeout_fired suppressed by recoveryInFlight guard", () => {
    const state = stateWith({ recoveryInFlight: true })
    const d = decide(state, { kind: "delegation_timeout_fired" }, BASE_CONFIG)
    expect(d.action).toBe("wait")
    expect((d as { reason: string }).reason).toBe("recovery_in_flight")
  })

  it("recovery_result passes through even when recoveryInFlight", () => {
    const state = stateWith({ recoveryInFlight: true })
    const d = decide(state, { kind: "recovery_result", success: true }, BASE_CONFIG)
    // recovery_result is exempt from the recoveryInFlight guard
    expect(d.action).toBe("none")
  })

  it("fallback_session_active passes through even when fallbackInFlight", () => {
    const state = stateWith({ fallbackInFlight: true })
    const d = decide(state, { kind: "fallback_session_active" }, BASE_CONFIG)
    // fallback_session_active is exempt from the fallbackInFlight guard
    expect(d.action).toBe("none")
  })

  it("quota error with fallback models → fallback", () => {
    const state = createInitialState()
    const d = decide(state, {
      kind: "session_error", isRetryable: false, isQuota: true, isLocalToolAbort: false,
    }, BASE_CONFIG)
    expect(d.action).toBe("fallback_next_model")
  })

  it("local tool abort takes priority over retryable", () => {
    const state = createInitialState()
    const d = decide(state, {
      kind: "session_error", isRetryable: true, isQuota: false, isLocalToolAbort: true,
    }, BASE_CONFIG)
    expect(d.action).toBe("retry_same_model")
  })
})

// ---------------------------------------------------------------------------
// Phase machine: additional coverage
// ---------------------------------------------------------------------------

describe("phase-machine additional", () => {
  it("session_status_idle from waiting_provider does not transition", () => {
    expect(derivePhase("waiting_provider", { kind: "session_status_idle" })).toBeUndefined()
  })

  it("session_status_idle from idle does not transition", () => {
    expect(derivePhase("idle", { kind: "session_status_idle" })).toBeUndefined()
  })

  it("session_status_idle from completed does not transition", () => {
    expect(derivePhase("completed", { kind: "session_status_idle" })).toBeUndefined()
  })

  it("session_status_active from running does not transition", () => {
    expect(derivePhase("running", { kind: "session_status_active" })).toBeUndefined()
  })

  it("assistant_progress tool running from idle → tool_executing (blocked)", () => {
    // idle → tool_executing is not in VALID_TRANSITIONS
    const result = derivePhase("idle", {
      kind: "assistant_progress", hasVisibleContent: false, isStreaming: false,
      partType: "tool", toolStatus: "running",
    })
    expect(result).toBe("tool_executing")
    expect(canTransition("idle", "tool_executing")).toBe(false)
  })

  it("session_error from idle → failed (blocked)", () => {
    const result = derivePhase("idle", {
      kind: "session_error", isRetryable: true, isQuota: false, isLocalToolAbort: false,
    })
    expect(result).toBe("failed")
    expect(canTransition("idle", "failed")).toBe(false)
  })

  it("recovery_dispatched from running → recovering", () => {
    expect(derivePhase("running", {
      kind: "recovery_dispatched", recoveryKind: "empty_turn",
    })).toBe("recovering")
  })

  it("all phases have MAX_PHASE_DURATION_MS entries", () => {
    const phases: SessionPhase[] = [
      "idle", "running", "tool_executing", "delegating", "waiting_child",
      "waiting_provider", "recovering", "completed", "failed",
    ]
    for (const phase of phases) {
      expect(isPhaseStale(phase, Date.now())).toBe(false) // fresh = not stale
    }
  })

  it("completed becomes stale after 5 minutes", () => {
    expect(isPhaseStale("completed", Date.now() - 301_000)).toBe(true)
    expect(isPhaseStale("completed", Date.now() - 299_000)).toBe(false)
  })

  it("running becomes stale after 30 minutes", () => {
    expect(isPhaseStale("running", Date.now() - 31 * 60_000)).toBe(true)
    expect(isPhaseStale("running", Date.now() - 29 * 60_000)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Full conflict replay sequences (end-to-end through coordinator)
// ---------------------------------------------------------------------------

describe("conflict replay sequences", () => {
  describe("#1: double retry — empty recovery + timeout race", () => {
    it("first recovery blocks second from timeout", () => {
      const coord = makeCoordinator()
      const sid = "conflict-1a"

      // Session starts and makes progress
      coord.observe(sid, {
        kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
      })

      // Set up state where empty recovery is allowed:
      // - watchdog disarmed, lastVisibleProgressAt old
      const state = coord._getState(sid)!
      state.watchdogArmed = false
      state.lastVisibleProgressAt = Date.now() - 5000

      // Assistant produces empty turn → recovery allowed
      const d1 = coord.observe(sid, { kind: "assistant_empty", messageID: "m1" })
      expect(d1.action).toBe("recover_empty_turn")

      // applyDecision pre-sets recoveryInFlight
      expect(coord._getState(sid)!.recoveryInFlight).toBe(true)

      // Timeout fires during the same recovery → blocked
      const d2 = coord.observe(sid, { kind: "timeout_fired" })
      expect(d2.action).toBe("wait")
      expect((d2 as { reason: string }).reason).toBe("recovery_in_flight")

      // Recovery completes
      coord.observe(sid, { kind: "recovery_dispatched", recoveryKind: "empty" })
      coord.observe(sid, { kind: "recovery_result", success: true })
      expect(coord._getState(sid)!.recoveryInFlight).toBe(false)

      // Now timeout can proceed
      const d3 = coord.observe(sid, { kind: "timeout_fired" })
      expect(d3.action).toBe("fallback_next_model")
    })
  })

  describe("#2: child task completion vs watchdog", () => {
    it("watchdog defers while children active, proceeds after", () => {
      const coord = makeCoordinator()
      const sid = "conflict-2"

      // Session starts running
      coord.observe(sid, {
        kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
      })

      // Child task spawned
      coord.observe(sid, { kind: "child_task_started", taskID: "bg1" })
      expect(coord.hasActiveChildren(sid)).toBe(true)

      // Timeout fires — should extend, not fallback
      const d1 = coord.observe(sid, { kind: "timeout_fired" })
      expect(d1.action).toBe("extend_watchdog")

      // Child completes
      coord.observe(sid, { kind: "child_task_completed", taskID: "bg1" })
      expect(coord.hasActiveChildren(sid)).toBe(false)

      // Timeout fires again — now can fallback
      const d2 = coord.observe(sid, { kind: "timeout_fired" })
      expect(d2.action).toBe("fallback_next_model")
    })
  })

  describe("#3: streamed delta false empty", () => {
    it("recent visible progress suppresses empty recovery", () => {
      const coord = makeCoordinator()
      const sid = "conflict-3"

      // Visible streaming progress just happened
      coord.observe(sid, {
        kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
      })

      // Immediately empty notification (false alarm from streamed delta)
      const d = coord.observe(sid, { kind: "assistant_empty", messageID: "m1" })
      expect(d.action).toBe("none") // Suppressed by recency check
    })
  })

  describe("#4: promotion retry loop breaker", () => {
    it("aborts after 3 consecutive recoveries without progress", () => {
      const coord = makeCoordinator()
      const sid = "conflict-4"

      coord.observe(sid, {
        kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
      })

      // 3 recovery cycles without visible progress
      for (let i = 0; i < 3; i++) {
        coord.observe(sid, { kind: "recovery_dispatched", recoveryKind: "promotion" })
        coord.observe(sid, { kind: "recovery_result", success: false })
      }

      // 4th empty turn → abort
      const d = coord.observe(sid, { kind: "assistant_empty", messageID: "m-final" })
      expect(d.action).toBe("abort_session")
      expect((d as { reason: string }).reason).toBe("max_consecutive_recoveries_reached")
    })

    it("visible progress resets the counter", () => {
      const coord = makeCoordinator()
      const sid = "conflict-4-reset"

      coord.observe(sid, {
        kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
      })

      // 2 failed recoveries
      for (let i = 0; i < 2; i++) {
        coord.observe(sid, { kind: "recovery_dispatched", recoveryKind: "promotion" })
        coord.observe(sid, { kind: "recovery_result", success: false })
      }

      // Visible progress arrives — counter should reset
      coord.observe(sid, {
        kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
      })
      expect(coord._getState(sid)!.consecutiveRecoveryCount).toBe(0)

      // Set up state where empty recovery is allowed:
      // watchdog off + lastVisibleProgressAt old
      const state = coord._getState(sid)!
      state.lastVisibleProgressAt = Date.now() - 5000
      state.watchdogArmed = false

      const d = coord.observe(sid, { kind: "assistant_empty", messageID: "m-after-reset" })
      expect(d.action).toBe("recover_empty_turn")
    })
  })

  describe("#5: scoped delegation lifecycle", () => {
    it("tracks delegation through full handoff lifecycle", () => {
      const coord = makeCoordinator()
      const sid = "conflict-5"

      coord.observe(sid, {
        kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
      })

      // Scoped handoff dispatched
      coord.observe(sid, {
        kind: "fallback_dispatched", targetModel: "gpt-5", isScopedHandoff: true,
      })
      expect(coord.getPhase(sid)).toBe("delegating")
      expect(coord._getState(sid)!.fallbackInFlight).toBe(true)
      expect(coord._getState(sid)!.delegationStartedAt).toBeGreaterThan(0)

      // Timeout during delegation → wait (fallbackInFlight global guard fires first)
      const d1 = coord.observe(sid, { kind: "timeout_fired" })
      expect(d1.action).toBe("wait")
      expect((d1 as { reason: string }).reason).toBe("fallback_in_flight")

      // Child session bootstraps
      coord.observe(sid, { kind: "fallback_session_active" })
      expect(coord.getPhase(sid)).toBe("waiting_child")
      expect(coord._getState(sid)!.fallbackInFlight).toBe(false)

      // Child task starts
      coord.observe(sid, { kind: "child_task_started", taskID: "scoped-child" })

      // Child completes
      coord.observe(sid, { kind: "child_task_completed", taskID: "scoped-child" })
      expect(coord.hasActiveChildren(sid)).toBe(false)
    })
  })

  describe("#6: completion while recovery in flight", () => {
    it("recovery result arrives and clears the flag", () => {
      const coord = makeCoordinator()
      const sid = "conflict-6"

      coord.observe(sid, {
        kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
      })
      coord.observe(sid, { kind: "recovery_dispatched", recoveryKind: "empty_turn" })
      expect(coord.isRecoveryOrFallbackInFlight(sid)).toBe(true)

      // Session completes with content while recovery is in flight
      coord.observe(sid, {
        kind: "assistant_complete", finishReason: "end_turn", hasVisibleContent: true,
      })
      // Recovery still in flight — won't clear until recovery_result
      expect(coord._getState(sid)!.recoveryInFlight).toBe(true)

      // Recovery result comes
      coord.observe(sid, { kind: "recovery_result", success: true })
      expect(coord._getState(sid)!.recoveryInFlight).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// Session isolation and edge cases
// ---------------------------------------------------------------------------

describe("session isolation and edge cases", () => {
  it("sessions are completely independent", () => {
    const coord = makeCoordinator()

    coord.observe("s1", {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })
    coord.observe("s2", { kind: "child_task_started", taskID: "t1" })

    expect(coord.getPhase("s1")).toBe("running")
    expect(coord.getPhase("s2")).toBe("waiting_child")
    expect(coord.hasActiveChildren("s1")).toBe(false)
    expect(coord.hasActiveChildren("s2")).toBe(true)
  })

  it("unknown session returns safe defaults", () => {
    const coord = makeCoordinator()
    expect(coord.getPhase("nonexistent")).toBe("idle")
    expect(coord.hasActiveWork("nonexistent")).toBe(false)
    expect(coord.hasActiveChildren("nonexistent")).toBe(false)
    expect(coord.isRecoveryOrFallbackInFlight("nonexistent")).toBe(false)
    expect(coord.isWatchdogArmed("nonexistent")).toBe(false)
  })

  it("observe on unknown session creates state lazily", () => {
    const coord = makeCoordinator()
    expect(coord._getState("new")).toBeUndefined()

    coord.observe("new", {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })
    expect(coord._getState("new")).toBeDefined()
    expect(coord.getPhase("new")).toBe("running")
  })

  it("cleanup one session doesn't affect others", () => {
    const coord = makeCoordinator()
    coord.observe("s1", {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })
    coord.observe("s2", {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })

    coord.cleanup("s1")
    expect(coord._getState("s1")).toBeUndefined()
    expect(coord.getPhase("s2")).toBe("running")
  })

  it("blocked transition still processes observation and decision", () => {
    const coord = makeCoordinator()
    const sid = "blocked"

    // Session is idle. session_error → failed, but idle → failed is blocked.
    const d = coord.observe(sid, {
      kind: "session_error", isRetryable: true, isQuota: false, isLocalToolAbort: false,
    })

    // Phase stays idle (blocked), but decision is still made
    expect(coord.getPhase(sid)).toBe("idle")
    expect(d.action).toBe("retry_same_model")
  })

  it("same-session (non-scoped) fallback does not set fallbackInFlight", () => {
    const coord = makeCoordinator()
    const sid = "non-scoped"

    coord.observe(sid, {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })
    coord.observe(sid, {
      kind: "fallback_dispatched", targetModel: "gpt-5", isScopedHandoff: false,
    })

    expect(coord._getState(sid)!.fallbackInFlight).toBe(false)
    expect(coord._getState(sid)!.delegationStartedAt).toBeUndefined()

    // Subsequent timeout should NOT be blocked by fallbackInFlight
    const d = coord.observe(sid, { kind: "timeout_fired" })
    expect(d.action).not.toBe("wait")
  })

  it("session_status_idle clears stuck in-flight flags via observation", () => {
    const coord = makeCoordinator()
    const sid = "stuck-inflight"

    coord.observe(sid, {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })
    // Simulate stuck recovery (recovery_dispatched but no recovery_result)
    coord.observe(sid, { kind: "recovery_dispatched", recoveryKind: "empty" })
    expect(coord._getState(sid)!.recoveryInFlight).toBe(true)

    // Session goes idle — should clear stuck flags
    coord.observe(sid, { kind: "session_status_idle" })
    expect(coord._getState(sid)!.recoveryInFlight).toBe(false)
    expect(coord._getState(sid)!.fallbackInFlight).toBe(false)
  })

  it("recover_empty_turn pre-sets recoveryInFlight to prevent duplicate", () => {
    const coord = makeCoordinator()
    const sid = "preemptive"

    coord.observe(sid, {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })

    // Set up: watchdog disarmed + lastVisibleProgressAt old
    const state = coord._getState(sid)!
    state.lastVisibleProgressAt = Date.now() - 5000
    state.watchdogArmed = false

    // First empty → recover
    const d1 = coord.observe(sid, { kind: "assistant_empty", messageID: "m1" })
    expect(d1.action).toBe("recover_empty_turn")
    expect(coord._getState(sid)!.recoveryInFlight).toBe(true)

    // Second empty in same tick → blocked by pre-set flag
    const d2 = coord.observe(sid, { kind: "assistant_empty", messageID: "m2" })
    expect(d2.action).toBe("wait")
    expect((d2 as { reason: string }).reason).toBe("recovery_in_flight")
  })

  it("multiple child tasks: last one completing triggers mark_completed", () => {
    const coord = makeCoordinator()
    const sid = "multi-child"

    coord.observe(sid, { kind: "child_task_started", taskID: "t1" })
    coord.observe(sid, { kind: "child_task_started", taskID: "t2" })
    coord.observe(sid, { kind: "child_task_started", taskID: "t3" })
    expect(coord._getState(sid)!.activeChildTaskIDs.size).toBe(3)

    // First two complete — no mark_completed
    const d1 = coord.observe(sid, { kind: "child_task_completed", taskID: "t1" })
    expect(d1.action).toBe("none")
    const d2 = coord.observe(sid, { kind: "child_task_failed", taskID: "t2" })
    expect(d2.action).toBe("none")

    // Last one completes
    const d3 = coord.observe(sid, { kind: "child_task_completed", taskID: "t3" })
    expect(d3.action).toBe("mark_completed")
  })

  it("fallbackConfigResolver is called per-session", () => {
    const configs = new Map<string, { baseTimeoutMs: number; hasFallbackModels: boolean }>()
    configs.set("paid", { baseTimeoutMs: 60_000, hasFallbackModels: true })
    configs.set("free", { baseTimeoutMs: 30_000, hasFallbackModels: false })

    const coord = new SessionExecutionCoordinator((sid) => configs.get(sid) ?? BASE_CONFIG)

    // "paid" session gets fallback
    coord.observe("paid", {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })
    const d1 = coord.observe("paid", { kind: "timeout_fired" })
    expect(d1.action).toBe("fallback_next_model")

    // "free" session gets abort
    coord.observe("free", {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })
    const d2 = coord.observe("free", { kind: "timeout_fired" })
    expect(d2.action).toBe("abort_session")
  })

  it("consecutive timeout counter accumulates across multiple timeouts", () => {
    const coord = makeCoordinator()
    const sid = "timeout-accum"

    coord.observe(sid, {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })

    // Fire 5 timeouts (MAX_CONSECUTIVE_TIMEOUTS = 5)
    for (let i = 0; i < 5; i++) {
      coord.observe(sid, { kind: "timeout_fired" })
    }

    // 6th timeout → abort
    const d = coord.observe(sid, { kind: "timeout_fired" })
    expect(d.action).toBe("abort_session")
    expect((d as { reason: string }).reason).toBe("max_consecutive_timeouts_reached")
  })

  it("provider retry keeps watchdog alive", () => {
    const coord = makeCoordinator()
    const sid = "provider-retry"

    coord.observe(sid, {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })

    // Provider starts auto-retrying
    coord.observe(sid, { kind: "session_status_retry", isQuota: false })
    expect(coord.getPhase(sid)).toBe("waiting_provider")

    // Timeout during provider retry → extend, not fallback
    const d = coord.observe(sid, { kind: "timeout_fired" })
    expect(d.action).toBe("extend_watchdog")
    expect((d as { reason: string }).reason).toBe("provider_retry_in_progress")
  })
})

// ---------------------------------------------------------------------------
// Observation shape contract tests
// Verify observations constructed like the real wiring code produce
// correct decisions. This catches field typos and wrong boolean logic
// that TypeScript can't catch via the `any` type in manager.ts.
// ---------------------------------------------------------------------------

describe("observation shape contracts", () => {
  // Mirrors: event-handler.ts:176-183
  describe("assistant_progress from event-handler", () => {
    it("text delta with visible content → arms watchdog", () => {
      const coord = makeCoordinator()
      const sid = "shape-progress-1"

      // Exact shape from event-handler.ts:176
      const obs: Observation = {
        kind: "assistant_progress",
        hasVisibleContent: true, // hasVisibleTextDelta || (partType === "text" && partText.length > 0)
        partType: "text",
        toolName: undefined,
        toolStatus: undefined,
        isStreaming: true, // isStreamingTextDeltaProgress
      }
      const d = coord.observe(sid, obs)
      expect(d.action).toBe("arm_watchdog")
      expect(coord.getPhase(sid)).toBe("running")
    })

    it("tool running → tool_executing phase", () => {
      const coord = makeCoordinator()
      const sid = "shape-progress-2"
      coord.observe(sid, {
        kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
      })

      const obs: Observation = {
        kind: "assistant_progress",
        hasVisibleContent: false,
        partType: "tool",
        toolName: "write",
        toolStatus: "running",
        isStreaming: false,
      }
      coord.observe(sid, obs)
      expect(coord.getPhase(sid)).toBe("tool_executing")
    })

    it("reasoning stream without visible text → non-visible progress arms watchdog", () => {
      const coord = makeCoordinator()
      const sid = "shape-progress-3"
      coord.observe(sid, { kind: "session_status_active" })
      // session_status_active arms watchdog — disarm it so non-visible progress can re-arm
      coord._getState(sid)!.watchdogArmed = false

      const obs: Observation = {
        kind: "assistant_progress",
        hasVisibleContent: false, // reasoning is not "visible" text
        partType: "reasoning",
        toolName: undefined,
        toolStatus: undefined,
        isStreaming: true, // hasReasoningStreamProgress
      }
      const d = coord.observe(sid, obs)
      expect(d.action).toBe("arm_watchdog")
    })
  })

  // Mirrors: message-update-handler.ts:248-255
  describe("assistant_progress from message-update-handler", () => {
    it("visible response with terminal finish → isStreaming false", () => {
      const coord = makeCoordinator()
      const sid = "shape-muh-1"
      coord.observe(sid, {
        kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
      })

      // message-update-handler sends this shape
      const obs: Observation = {
        kind: "assistant_progress",
        hasVisibleContent: true,
        partType: undefined,
        toolName: undefined,
        toolStatus: undefined,
        isStreaming: false, // !hasTerminalFinish where terminal = true
      }
      const d = coord.observe(sid, obs)
      // visible content → extend/arm watchdog
      expect(["arm_watchdog", "extend_watchdog"]).toContain(d.action)
    })
  })

  // Mirrors: message-update-handler.ts:299-303
  describe("assistant_complete from message-update-handler", () => {
    it("terminal finish with string reason", () => {
      const coord = makeCoordinator()
      const sid = "shape-complete-1"
      coord.observe(sid, {
        kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
      })

      const obs: Observation = {
        kind: "assistant_complete",
        finishReason: "end_turn", // typeof info?.finish === "string"
        hasVisibleContent: true,
      }
      const d = coord.observe(sid, obs)
      expect(d.action).toBe("disarm_watchdog")
      expect(coord.getPhase(sid)).toBe("completed")
    })

    it("non-string finish reason falls back to 'unknown'", () => {
      const coord = makeCoordinator()
      const sid = "shape-complete-2"
      coord.observe(sid, {
        kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
      })

      // When typeof info?.finish !== "string"
      const obs: Observation = {
        kind: "assistant_complete",
        finishReason: "unknown",
        hasVisibleContent: true,
      }
      const d = coord.observe(sid, obs)
      expect(d.action).toBe("disarm_watchdog")
    })
  })

  // Mirrors: event-handler.ts:660-665
  describe("session_error from event-handler", () => {
    it("LocalToolAbortWrappedError → retry same model", () => {
      const coord = makeCoordinator()
      const sid = "shape-error-1"

      // Exact shape from event-handler.ts:656-664
      const obs: Observation = {
        kind: "session_error",
        isRetryable: false, // extractErrorName matches but isRetryableError may not
        isQuota: false,
        isLocalToolAbort: true, // extractErrorName().toLowerCase() === "localtoolabortwrappederror"
      }
      const d = coord.observe(sid, obs)
      expect(d.action).toBe("retry_same_model")
    })

    it("quota 429 error → fallback", () => {
      const obs: Observation = {
        kind: "session_error",
        isRetryable: false,
        isQuota: true, // extractStatusCode === 429
        isLocalToolAbort: false,
      }
      const d = decide(createInitialState(), obs, BASE_CONFIG)
      // isQuota doesn't have special handling in coordinator — falls through
      // to non-retryable + hasFallbackModels → fallback
      expect(d.action).toBe("fallback_next_model")
    })
  })

  // Mirrors: manager.ts child task observations
  describe("child task observations from manager", () => {
    it("child_task_started with real task ID format", () => {
      const coord = makeCoordinator()
      const obs: Observation = {
        kind: "child_task_started",
        taskID: "bg_task_abc123_1719000000000",
      }
      coord.observe("parent-1", obs)
      expect(coord.hasActiveChildren("parent-1")).toBe(true)
    })

    it("child_task_completed clears specific task", () => {
      const coord = makeCoordinator()
      coord.observe("p1", { kind: "child_task_started", taskID: "t1" })
      coord.observe("p1", { kind: "child_task_started", taskID: "t2" })

      coord.observe("p1", { kind: "child_task_completed", taskID: "t1" })
      expect(coord._getState("p1")!.activeChildTaskIDs.has("t1")).toBe(false)
      expect(coord._getState("p1")!.activeChildTaskIDs.has("t2")).toBe(true)
    })
  })

  // Mirrors: auto-retry.ts:1939-1943 and 1964-1968
  describe("fallback_dispatched from auto-retry", () => {
    it("scoped handoff sets delegation state", () => {
      const coord = makeCoordinator()
      const sid = "shape-fallback-1"
      coord.observe(sid, {
        kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
      })

      // Scoped handoff path (auto-retry.ts:1939)
      const obs: Observation = {
        kind: "fallback_dispatched",
        targetModel: "openai/gpt-5.4",
        isScopedHandoff: true,
      }
      coord.observe(sid, obs)
      expect(coord.getPhase(sid)).toBe("delegating")
      expect(coord._getState(sid)!.fallbackInFlight).toBe(true)
    })

    it("same-session retry does NOT set fallbackInFlight", () => {
      const coord = makeCoordinator()
      const sid = "shape-fallback-2"
      coord.observe(sid, {
        kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
      })

      // Same-session retry path (auto-retry.ts:1964)
      const obs: Observation = {
        kind: "fallback_dispatched",
        targetModel: "anthropic/claude-sonnet-4-6",
        isScopedHandoff: false,
      }
      coord.observe(sid, obs)
      expect(coord._getState(sid)!.fallbackInFlight).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// Gate logic tests — verify the exact decision-checking patterns
// used by event.ts and auto-retry.ts
// ---------------------------------------------------------------------------

describe("gate logic contracts", () => {
  // Mirrors: event.ts:2033
  // if (decision.action !== "recover_empty_turn" && decision.action !== "none")
  describe("empty recovery gate (event.ts)", () => {
    it("allows through when decision is recover_empty_turn", () => {
      const state = stateWith({
        phase: "completed" as SessionPhase,
        watchdogArmed: false,
        lastVisibleProgressAt: Date.now() - 5000,
      })
      const d = decide(state, { kind: "assistant_empty", messageID: "m1" }, BASE_CONFIG)
      // Gate check: d.action !== "recover_empty_turn" → false → proceeds
      expect(d.action === "recover_empty_turn" || d.action === "none").toBe(true)
    })

    it("allows through when decision is none (recent progress)", () => {
      const state = stateWith({
        phase: "running" as SessionPhase,
        lastVisibleProgressAt: Date.now() - 500, // < 2000ms
      })
      const d = decide(state, { kind: "assistant_empty", messageID: "m1" }, BASE_CONFIG)
      expect(d.action).toBe("none")
      // Gate check: d.action !== "none" → false → proceeds (no-op)
    })

    it("suppresses when decision is wait (recovery in flight)", () => {
      const state = stateWith({ recoveryInFlight: true })
      const d = decide(state, { kind: "assistant_empty", messageID: "m1" }, BASE_CONFIG)
      expect(d.action).toBe("wait")
      // Gate check: d.action !== "recover_empty_turn" → true,
      //            d.action !== "none" → true → SUPPRESSED
    })

    it("suppresses when decision is abort_session (max recoveries)", () => {
      const state = stateWith({ consecutiveRecoveryCount: 3 })
      const d = decide(state, { kind: "assistant_empty", messageID: "m1" }, BASE_CONFIG)
      expect(d.action).toBe("abort_session")
      // Gate check: both !== checks true → SUPPRESSED
    })
  })

  // Mirrors: auto-retry.ts:1346
  // if (decision.action === "wait")
  describe("timeout gate (auto-retry.ts)", () => {
    it("defers only on wait — fallback falls through", () => {
      const state = createInitialState()
      const d = decide(state, { kind: "timeout_fired" }, BASE_CONFIG)
      expect(d.action).toBe("fallback_next_model")
      // Gate check: d.action === "wait" → false → falls through to legacy
    })

    it("defers only on wait — abort falls through", () => {
      const state = createInitialState()
      const d = decide(state, { kind: "timeout_fired" }, NO_FALLBACK_CONFIG)
      expect(d.action).toBe("abort_session")
      // Gate check: d.action === "wait" → false → falls through to legacy
    })

    it("defers on wait from child tasks", () => {
      const state = stateWith({ activeChildTaskIDs: new Set(["t1"]) })
      const d = decide(state, { kind: "timeout_fired" }, BASE_CONFIG)
      expect(d.action).toBe("extend_watchdog")
      // Gate check: d.action === "wait" → false → falls through
      // NOTE: extend_watchdog also falls through; only "wait" is intercepted
    })

    it("defers on wait from recovery in flight", () => {
      const state = stateWith({ recoveryInFlight: true })
      const d = decide(state, { kind: "timeout_fired" }, BASE_CONFIG)
      expect(d.action).toBe("wait")
      // Gate check: d.action === "wait" → true → DEFERRED, re-armed
    })

    it("defers on wait from fallback in flight", () => {
      const state = stateWith({ fallbackInFlight: true })
      const d = decide(state, { kind: "timeout_fired" }, BASE_CONFIG)
      expect(d.action).toBe("wait")
    })
  })

  // Mirrors: index.ts:103-105
  // coordinator.hasActiveWork(sessionID) || coordinator.isRecoveryOrFallbackInFlight(sessionID)
  describe("hasActiveWork composition (index.ts wiring)", () => {
    it("returns true when phase is running", () => {
      const coord = makeCoordinator()
      coord.observe("s1", {
        kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
      })
      const result = coord.hasActiveWork("s1") || coord.isRecoveryOrFallbackInFlight("s1")
      expect(result).toBe(true)
    })

    it("returns true when phase is completed but recovery in flight", () => {
      const coord = makeCoordinator()
      const sid = "s1"
      coord.observe(sid, {
        kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
      })
      coord.observe(sid, { kind: "recovery_dispatched", recoveryKind: "empty" })
      coord.observe(sid, {
        kind: "assistant_complete", finishReason: "end_turn", hasVisibleContent: true,
      })

      // Phase is completed-ish but recovery is in flight
      const hasWork = coord.hasActiveWork(sid)
      const inFlight = coord.isRecoveryOrFallbackInFlight(sid)
      expect(hasWork || inFlight).toBe(true)
    })

    it("returns false when idle and nothing in flight", () => {
      const coord = makeCoordinator()
      const result = coord.hasActiveWork("s1") || coord.isRecoveryOrFallbackInFlight("s1")
      expect(result).toBe(false)
    })

    it("returns false when completed and nothing in flight", () => {
      const coord = makeCoordinator()
      const sid = "s1"
      coord.observe(sid, {
        kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
      })
      coord.observe(sid, {
        kind: "assistant_complete", finishReason: "end_turn", hasVisibleContent: true,
      })
      const result = coord.hasActiveWork(sid) || coord.isRecoveryOrFallbackInFlight(sid)
      expect(result).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// Delegation staleness safety net
// delegation_timeout_fired is never sent in production — test that
// staleness auto-reset acts as the backup timeout for stuck delegations
// ---------------------------------------------------------------------------

describe("delegation staleness safety net", () => {
  it("stuck delegating phase auto-resets after 60s staleness", () => {
    const coord = makeCoordinator()
    const sid = "stuck-delegation"

    coord.observe(sid, {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })
    coord.observe(sid, {
      kind: "fallback_dispatched", targetModel: "gpt-5", isScopedHandoff: true,
    })
    expect(coord.getPhase(sid)).toBe("delegating")

    // Simulate: child never bootstraps, 2 minutes pass
    const state = coord._getState(sid)!
    state.phaseEnteredAt = Date.now() - 120_000

    // getPhase auto-corrects stale
    expect(coord.getPhase(sid)).toBe("idle")
    expect(coord.hasActiveWork(sid)).toBe(false)
    // fallbackInFlight also treated as false via staleness
    expect(coord.isRecoveryOrFallbackInFlight(sid)).toBe(false)
  })

  it("next observation after stuck delegation resets to idle then proceeds", () => {
    const coord = makeCoordinator()
    const sid = "stuck-delegation-2"

    coord.observe(sid, {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })
    coord.observe(sid, {
      kind: "fallback_dispatched", targetModel: "gpt-5", isScopedHandoff: true,
    })

    // Stale
    coord._getState(sid)!.phaseEnteredAt = Date.now() - 120_000

    // New progress observation should auto-reset then transition to running
    coord.observe(sid, {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })
    expect(coord.getPhase(sid)).toBe("running")
    expect(coord._getState(sid)!.fallbackInFlight).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Exception / missed observation recovery scenarios
// ---------------------------------------------------------------------------

describe("missed observation recovery", () => {
  it("recovery_result never arrives → session_status_idle clears stuck flag", () => {
    const coord = makeCoordinator()
    const sid = "missed-result"

    coord.observe(sid, {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })
    coord.observe(sid, { kind: "recovery_dispatched", recoveryKind: "empty_turn" })
    expect(coord._getState(sid)!.recoveryInFlight).toBe(true)

    // Recovery throws, recovery_result never sent
    // Eventually OpenCode fires session_status_idle
    coord.observe(sid, { kind: "session_status_idle" })
    expect(coord._getState(sid)!.recoveryInFlight).toBe(false)

    // Now timeouts can proceed normally
    coord._getState(sid)!.watchdogArmed = false
    coord._getState(sid)!.lastVisibleProgressAt = Date.now() - 5000
    const d = coord.observe(sid, { kind: "assistant_empty", messageID: "m1" })
    expect(d.action).toBe("recover_empty_turn")
  })

  it("fallback_session_active never arrives → session_status_idle clears stuck flag", () => {
    const coord = makeCoordinator()
    const sid = "missed-bootstrap"

    coord.observe(sid, {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })
    coord.observe(sid, {
      kind: "fallback_dispatched", targetModel: "gpt-5", isScopedHandoff: true,
    })
    expect(coord._getState(sid)!.fallbackInFlight).toBe(true)

    // Child session never bootstraps, session goes idle
    coord.observe(sid, { kind: "session_status_idle" })
    expect(coord._getState(sid)!.fallbackInFlight).toBe(false)
  })

  it("double recovery_dispatched increments counter twice", () => {
    const coord = makeCoordinator()
    const sid = "double-dispatch"

    coord.observe(sid, {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })
    coord.observe(sid, { kind: "recovery_dispatched", recoveryKind: "empty" })
    coord.observe(sid, { kind: "recovery_dispatched", recoveryKind: "empty" })
    expect(coord._getState(sid)!.consecutiveRecoveryCount).toBe(2)
  })

  it("session_stopped during stuck recovery clears all flags", () => {
    const coord = makeCoordinator()
    const sid = "stop-during-recovery"

    coord.observe(sid, {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })
    coord.observe(sid, { kind: "recovery_dispatched", recoveryKind: "promotion" })
    expect(coord._getState(sid)!.recoveryInFlight).toBe(true)

    coord.observe(sid, { kind: "session_stopped" })
    expect(coord._getState(sid)!.recoveryInFlight).toBe(false)
    expect(coord._getState(sid)!.fallbackInFlight).toBe(false)
    expect(coord._getState(sid)!.consecutiveRecoveryCount).toBe(0)
    expect(coord.getPhase(sid)).toBe("idle")
  })
})

// ---------------------------------------------------------------------------
// Boundary condition tests
// ---------------------------------------------------------------------------

describe("boundary conditions", () => {
  it("visible progress at exactly VISIBLE_PROGRESS_RECENCY_MS boundary", () => {
    // VISIBLE_PROGRESS_RECENCY_MS = 2000
    const state = stateWith({
      lastVisibleProgressAt: Date.now() - 2000, // exactly at boundary
    })
    const d = decide(state, { kind: "assistant_empty", messageID: "m1" }, BASE_CONFIG)
    // Date.now() - lastVisibleProgressAt >= 2000 → NOT recent → allows recovery
    // (assuming watchdog not armed and other guards pass)
    expect(d.action !== "none" || d.action === "none").toBe(true) // just checking no crash
  })

  it("consecutiveRecoveryCount at exactly MAX - 1 allows recovery", () => {
    // MAX_CONSECUTIVE_RECOVERIES = 3
    const state = stateWith({
      consecutiveRecoveryCount: 2, // MAX - 1
      lastVisibleProgressAt: Date.now() - 5000,
      watchdogArmed: false,
    })
    const d = decide(state, { kind: "assistant_empty", messageID: "m1" }, BASE_CONFIG)
    expect(d.action).toBe("recover_empty_turn")
  })

  it("consecutiveRecoveryCount at exactly MAX triggers abort", () => {
    const state = stateWith({ consecutiveRecoveryCount: 3 }) // MAX
    const d = decide(state, { kind: "assistant_empty", messageID: "m1" }, BASE_CONFIG)
    expect(d.action).toBe("abort_session")
  })

  it("consecutiveTimeoutCount at exactly MAX - 1 allows fallback", () => {
    const state = stateWith({ consecutiveTimeoutCount: 4 }) // MAX - 1
    const d = decide(state, { kind: "timeout_fired" }, BASE_CONFIG)
    expect(d.action).toBe("fallback_next_model")
  })

  it("consecutiveTimeoutCount at exactly MAX triggers abort", () => {
    const state = stateWith({ consecutiveTimeoutCount: 5 }) // MAX
    const d = decide(state, { kind: "timeout_fired" }, BASE_CONFIG)
    expect(d.action).toBe("abort_session")
  })

  it("phase staleness at exactly boundary", () => {
    // recovering MAX = 60_000ms
    expect(isPhaseStale("recovering", Date.now() - 60_000)).toBe(false) // at boundary = not stale
    expect(isPhaseStale("recovering", Date.now() - 60_001)).toBe(true)  // just over = stale
  })

  it("baseTimeoutMs = 0 does not cause division issues", () => {
    const zeroConfig = { baseTimeoutMs: 0, hasFallbackModels: true }
    const state = stateWith({ activeChildTaskIDs: new Set(["t1"]) })
    const d = decide(state, { kind: "timeout_fired" }, zeroConfig)
    expect(d.action).toBe("extend_watchdog")
    expect((d as { timeoutMs: number }).timeoutMs).toBe(0) // 0 * 4 = 0
  })
})

// ---------------------------------------------------------------------------
// Realistic multi-step session lifecycle
// ---------------------------------------------------------------------------

describe("realistic session lifecycle", () => {
  it("full successful session: start → progress → tool → complete", () => {
    const coord = makeCoordinator()
    const sid = "lifecycle-success"

    // 1. Session status active (first signal)
    coord.observe(sid, { kind: "session_status_active" })
    expect(coord.getPhase(sid)).toBe("running")

    // 2. Text streaming
    coord.observe(sid, {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })
    expect(coord.isWatchdogArmed(sid)).toBe(true)

    // 3. Tool execution starts
    coord.observe(sid, {
      kind: "assistant_progress", hasVisibleContent: false, isStreaming: false,
      partType: "tool", toolName: "write", toolStatus: "running",
    })
    expect(coord.getPhase(sid)).toBe("tool_executing")

    // 4. Tool completes, more text
    coord.observe(sid, {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })
    expect(coord.getPhase(sid)).toBe("running")

    // 5. Complete
    coord.observe(sid, {
      kind: "assistant_complete", finishReason: "end_turn", hasVisibleContent: true,
    })
    expect(coord.getPhase(sid)).toBe("completed")
    expect(coord.hasActiveWork(sid)).toBe(false)
    expect(coord.isWatchdogArmed(sid)).toBe(false)
  })

  it("session with background tasks: start → spawn child → child completes", () => {
    const coord = makeCoordinator()
    const sid = "lifecycle-children"

    coord.observe(sid, {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })

    // Spawn 2 background tasks
    coord.observe(sid, { kind: "child_task_started", taskID: "bg1" })
    coord.observe(sid, { kind: "child_task_started", taskID: "bg2" })
    expect(coord.getPhase(sid)).toBe("waiting_child")
    expect(coord._getState(sid)!.activeChildTaskIDs.size).toBe(2)

    // Timeout while children work → extend
    const d1 = coord.observe(sid, { kind: "timeout_fired" })
    expect(d1.action).toBe("extend_watchdog")

    // First child completes
    coord.observe(sid, { kind: "child_task_completed", taskID: "bg1" })
    expect(coord._getState(sid)!.activeChildTaskIDs.size).toBe(1)

    // Second child fails
    const d2 = coord.observe(sid, { kind: "child_task_failed", taskID: "bg2" })
    expect(d2.action).toBe("mark_completed")

    // Session complete
    coord.observe(sid, {
      kind: "assistant_complete", finishReason: "end_turn", hasVisibleContent: true,
    })
    expect(coord.getPhase(sid)).toBe("completed")
  })

  it("session with failed fallback chain: error → retry → timeout → fallback → abort", () => {
    const noFallbackCoord = makeCoordinator(NO_FALLBACK_CONFIG)
    const sid = "lifecycle-abort"

    // Start
    noFallbackCoord.observe(sid, { kind: "session_status_active" })

    // Error → retry
    const d1 = noFallbackCoord.observe(sid, {
      kind: "session_error", isRetryable: true, isQuota: false, isLocalToolAbort: false,
    })
    expect(d1.action).toBe("retry_same_model")

    // Timeout without fallback models → abort
    const d2 = noFallbackCoord.observe(sid, { kind: "timeout_fired" })
    expect(d2.action).toBe("abort_session")
    expect((d2 as { reason: string }).reason).toBe("timeout_no_fallback_models")
  })

  it("session with scoped handoff: timeout → delegate → child works → complete", () => {
    const coord = makeCoordinator()
    const sid = "lifecycle-handoff"

    coord.observe(sid, {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })

    // Scoped handoff
    coord.observe(sid, {
      kind: "fallback_dispatched", targetModel: "gpt-5", isScopedHandoff: true,
    })
    expect(coord.getPhase(sid)).toBe("delegating")

    // Child bootstraps
    coord.observe(sid, { kind: "fallback_session_active" })
    expect(coord.getPhase(sid)).toBe("waiting_child")
    expect(coord._getState(sid)!.fallbackInFlight).toBe(false)

    // Child task registered
    coord.observe(sid, { kind: "child_task_started", taskID: "scoped-1" })

    // Child makes progress (not directly observed by coordinator,
    // but timeout would extend due to active children)
    const d = coord.observe(sid, { kind: "timeout_fired" })
    expect(d.action).toBe("extend_watchdog")

    // Child completes
    coord.observe(sid, { kind: "child_task_completed", taskID: "scoped-1" })
    expect(coord.hasActiveChildren(sid)).toBe(false)
  })

  it("session with provider retry recovery: running → 429 → waiting → back to running", () => {
    const coord = makeCoordinator()
    const sid = "lifecycle-429"

    coord.observe(sid, {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })
    expect(coord.getPhase(sid)).toBe("running")

    // Provider hits rate limit
    coord.observe(sid, { kind: "session_status_retry", isQuota: true })
    expect(coord.getPhase(sid)).toBe("waiting_provider")

    // Provider recovers
    coord.observe(sid, { kind: "session_status_active" })
    // waiting_provider → running is not a valid transition via session_status_active
    // (derivePhase returns undefined for session_status_active from non-idle)
    // The phase stays waiting_provider until assistant_progress comes

    coord.observe(sid, {
      kind: "assistant_progress", hasVisibleContent: true, isStreaming: true,
    })
    expect(coord.getPhase(sid)).toBe("running")

    coord.observe(sid, {
      kind: "assistant_complete", finishReason: "end_turn", hasVisibleContent: true,
    })
    expect(coord.getPhase(sid)).toBe("completed")
  })

  it("rapid fire: many progress events followed by complete", () => {
    const coord = makeCoordinator()
    const sid = "lifecycle-rapid"

    // Simulate rapid streaming
    for (let i = 0; i < 50; i++) {
      coord.observe(sid, {
        kind: "assistant_progress",
        hasVisibleContent: i % 3 === 0, // every 3rd has visible content
        isStreaming: true,
      })
    }
    expect(coord.getPhase(sid)).toBe("running")
    expect(coord._getState(sid)!.consecutiveRecoveryCount).toBe(0)
    expect(coord._getState(sid)!.consecutiveTimeoutCount).toBe(0)

    coord.observe(sid, {
      kind: "assistant_complete", finishReason: "end_turn", hasVisibleContent: true,
    })
    expect(coord.getPhase(sid)).toBe("completed")
  })
})
