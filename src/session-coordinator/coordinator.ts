/**
 * Session Execution Coordinator
 *
 * Thin orchestration layer that is the single source of truth for session
 * lifecycle decisions. Modules report observations; the coordinator returns
 * decisions. Modules execute the decisions.
 *
 * The coordinator does NOT replace runtime-fallback's FallbackState (model
 * chain, cooldowns, transient backoff). It tracks only cross-module state
 * that no single module can see on its own.
 */

import type {
  CoordinatorState,
  Decision,
  FallbackConfigResolver,
  Observation,
  SessionPhase,
} from "./types"
import { createInitialState } from "./types"
import { canTransition, derivePhase, isPhaseStale } from "./phase-machine"
import { applyDecision, applyObservation } from "./observation-reducer"
import { decide } from "./decision-engine"
import { log } from "../shared/logger"

const COORDINATOR_LOG_PREFIX = "session-coordinator"

export class SessionExecutionCoordinator {
  private sessions = new Map<string, CoordinatorState>()
  private fallbackConfigResolver: FallbackConfigResolver

  constructor(fallbackConfigResolver: FallbackConfigResolver) {
    this.fallbackConfigResolver = fallbackConfigResolver
  }

  /**
   * Single entry point for all observations.
   * Returns a Decision that the caller MUST execute.
   */
  observe(sessionID: string, observation: Observation): Decision {
    const state = this.ensureState(sessionID)
    const now = Date.now()

    // Auto-reset stale phases
    if (isPhaseStale(state.phase, state.phaseEnteredAt, now)) {
      log(`[${COORDINATOR_LOG_PREFIX}] Auto-reset stale phase ${state.phase} → idle`, {
        sessionID,
        phaseAge: now - state.phaseEnteredAt,
      })
      state.previousPhase = state.phase
      state.phase = "idle"
      state.phaseEnteredAt = now
      state.recoveryInFlight = false
      state.fallbackInFlight = false
      state.watchdogArmed = false
    }

    // 1. Phase transition
    const newPhase = derivePhase(state.phase, observation)
    if (newPhase !== undefined && newPhase !== state.phase) {
      if (canTransition(state.phase, newPhase)) {
        state.previousPhase = state.phase
        state.phase = newPhase
        state.phaseEnteredAt = now
      } else {
        log(`[${COORDINATOR_LOG_PREFIX}] BLOCKED transition ${state.phase} → ${newPhase}`, {
          sessionID,
          observation: observation.kind,
        })
        // Don't return early — still update state and make a decision
      }
    }

    // 2. Apply observation to state
    applyObservation(state, observation)

    // 3. Make decision
    const config = this.fallbackConfigResolver(sessionID)
    const decision = decide(state, observation, config)

    // 4. Record decision in state (prevent duplicates)
    applyDecision(state, decision)

    // 5. Log non-trivial decisions
    if (decision.action !== "none") {
      log(`[${COORDINATOR_LOG_PREFIX}] ${observation.kind} → ${decision.action}`, {
        sessionID,
        phase: state.phase,
        activeChildren: state.activeChildTaskIDs.size,
        recoveryInFlight: state.recoveryInFlight,
        fallbackInFlight: state.fallbackInFlight,
        watchdogArmed: state.watchdogArmed,
        ...("reason" in decision ? { reason: decision.reason } : {}),
      })
    }

    return decision
  }

  // -----------------------------------------------------------------------
  // Read-only queries for modules
  // -----------------------------------------------------------------------

  getPhase(sessionID: string): SessionPhase {
    const state = this.sessions.get(sessionID)
    if (!state) return "idle"

    // Auto-correct stale phases on read
    if (isPhaseStale(state.phase, state.phaseEnteredAt)) {
      return "idle"
    }
    return state.phase
  }

  hasActiveWork(sessionID: string): boolean {
    const phase = this.getPhase(sessionID)
    return (
      phase !== "idle" &&
      phase !== "completed" &&
      phase !== "failed"
    )
  }

  hasActiveChildren(sessionID: string): boolean {
    const state = this.sessions.get(sessionID)
    if (!state) return false
    if (isPhaseStale(state.phase, state.phaseEnteredAt)) return false
    return state.activeChildTaskIDs.size > 0
  }

  isRecoveryOrFallbackInFlight(sessionID: string): boolean {
    const state = this.sessions.get(sessionID)
    if (!state) return false
    // If the phase is stale, in-flight flags are unreliable — treat as cleared
    if (isPhaseStale(state.phase, state.phaseEnteredAt)) return false
    return state.recoveryInFlight || state.fallbackInFlight
  }

  isWatchdogArmed(sessionID: string): boolean {
    const state = this.sessions.get(sessionID)
    if (!state) return false
    if (isPhaseStale(state.phase, state.phaseEnteredAt)) return false
    return state.watchdogArmed
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  cleanup(sessionID: string): void {
    this.sessions.delete(sessionID)
  }

  cleanupStale(maxIdleMs: number = 30 * 60 * 1000): void {
    const now = Date.now()
    for (const [sessionID, state] of this.sessions) {
      if (now - state.lastObservationAt > maxIdleMs) {
        this.sessions.delete(sessionID)
      }
    }
  }

  /** Exposed for testing only */
  _getState(sessionID: string): CoordinatorState | undefined {
    return this.sessions.get(sessionID)
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private ensureState(sessionID: string): CoordinatorState {
    let state = this.sessions.get(sessionID)
    if (!state) {
      state = createInitialState()
      this.sessions.set(sessionID, state)
    }
    return state
  }
}
