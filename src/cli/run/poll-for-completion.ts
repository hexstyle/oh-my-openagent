import pc from "picocolors"
import type { RunContext } from "./types"
import type { EventState } from "./events"
import { checkCompletionConditions } from "./completion"
import { normalizeSDKResponse } from "../../shared"
import { getRuntimeFallbackAction, isSameModelRetryAction } from "../../hooks/runtime-fallback/fallback-policy"
import { DEFAULT_CONFIG } from "../../hooks/runtime-fallback/constants"

const DEFAULT_POLL_INTERVAL_MS = 500
const DEFAULT_REQUIRED_CONSECUTIVE = 1
const ERROR_GRACE_CYCLES = 3
const MIN_STABILIZATION_MS = 1_000
const DEFAULT_EVENT_WATCHDOG_MS = 30_000 // 30 seconds
const DEFAULT_SECONDARY_MEANINGFUL_WORK_TIMEOUT_MS = 60_000 // 60 seconds
const DEFAULT_DELAYED_RETRY_ERROR_GRACE_MS =
  DEFAULT_CONFIG.transient_retry_window_seconds * 1000

function shouldUseDelayedRetryGrace(lastError: string | null | undefined): boolean {
  if (!lastError) {
    return false
  }

  if (/unknown certificate verification error/i.test(lastError)) {
    return true
  }

  const errorAction = getRuntimeFallbackAction(
    { message: lastError },
    DEFAULT_CONFIG.retry_on_errors,
  )

  return errorAction === "limit_fallback"
    || isSameModelRetryAction(errorAction)
}

export interface PollOptions {
  pollIntervalMs?: number
  requiredConsecutive?: number
  minStabilizationMs?: number
  eventWatchdogMs?: number
  secondaryMeaningfulWorkTimeoutMs?: number
  delayedRetryErrorGraceMs?: number
}

export async function pollForCompletion(
  ctx: RunContext,
  eventState: EventState,
  abortController: AbortController,
  options: PollOptions = {}
): Promise<number> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const requiredConsecutive =
    options.requiredConsecutive ?? DEFAULT_REQUIRED_CONSECUTIVE
  const rawMinStabilizationMs =
    options.minStabilizationMs ?? MIN_STABILIZATION_MS
  const minStabilizationMs =
    rawMinStabilizationMs > 0 ? rawMinStabilizationMs : MIN_STABILIZATION_MS
  const eventWatchdogMs =
    options.eventWatchdogMs ?? DEFAULT_EVENT_WATCHDOG_MS
  const secondaryMeaningfulWorkTimeoutMs =
    options.secondaryMeaningfulWorkTimeoutMs ??
    DEFAULT_SECONDARY_MEANINGFUL_WORK_TIMEOUT_MS
  const delayedRetryErrorGraceMs =
    options.delayedRetryErrorGraceMs ?? DEFAULT_DELAYED_RETRY_ERROR_GRACE_MS
  let consecutiveCompleteChecks = 0
  let errorCycleCount = 0
  let errorGraceStartedAt: number | null = null
  let errorGraceSequence = -1
  let firstWorkTimestamp: number | null = null
  let secondaryTimeoutChecked = false
  const pollStartTimestamp = Date.now()

  while (!abortController.signal.aborted) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))

    if (abortController.signal.aborted) {
      return 130
    }

    let mainSessionStatus: "idle" | "busy" | "retry" | null = null
    const shouldProbeStatusForErrorRecovery = eventState.mainSessionError

    // Watchdog: if no events received for N seconds, verify session status via API
    if (
      !shouldProbeStatusForErrorRecovery &&
      eventState.lastEventTimestamp !== null
    ) {
      const timeSinceLastEvent = Date.now() - eventState.lastEventTimestamp
      if (timeSinceLastEvent > eventWatchdogMs) {
        // Events stopped coming - verify actual session state
        console.log(
          pc.yellow(
            `\n  No events for ${Math.round(
              timeSinceLastEvent / 1000
            )}s, verifying session status...`
          )
        )

        // Force check session status directly
        mainSessionStatus = await getMainSessionStatus(ctx)
        if (mainSessionStatus === "idle") {
          eventState.mainSessionIdle = true
        } else if (mainSessionStatus === "busy" || mainSessionStatus === "retry") {
          eventState.mainSessionIdle = false
        }

        // Reset timestamp to avoid repeated checks
        eventState.lastEventTimestamp = Date.now()
      }
    }

    // Only call getMainSessionStatus if watchdog didn't already check.
    // Errors are special: verify actual status immediately so transient
    // abort/retry handoffs do not fail the run prematurely.
    if (mainSessionStatus === null) {
      mainSessionStatus = await getMainSessionStatus(ctx)
    }

    if (eventState.mainSessionError) {
      if (eventState.errorSequence !== errorGraceSequence) {
        errorGraceSequence = eventState.errorSequence
        errorGraceStartedAt = eventState.lastErrorTimestamp ?? Date.now()
        errorCycleCount = 0
      }

      if (mainSessionStatus === "busy" || mainSessionStatus === "retry") {
        eventState.mainSessionError = false
        errorCycleCount = 0
        errorGraceStartedAt = null
        errorGraceSequence = -1
      } else {
        const usesRetryGrace = shouldUseDelayedRetryGrace(eventState.lastError)
        if (usesRetryGrace) {
          if (errorGraceStartedAt === null) {
            errorGraceStartedAt = Date.now()
          }

          if (Date.now() - errorGraceStartedAt < delayedRetryErrorGraceMs) {
            continue
          }
        }

        errorCycleCount++
        if (errorCycleCount >= ERROR_GRACE_CYCLES) {
          console.error(
            pc.red(`\n\nSession ended with error: ${eventState.lastError}`)
          )
          console.error(
            pc.yellow("Check if todos were completed before the error.")
          )
          return 1
        }
        // Continue polling during grace period to allow recovery
        continue
      }
    } else {
      // Reset error counter when error clears (recovery succeeded)
      errorCycleCount = 0
      errorGraceStartedAt = null
      errorGraceSequence = -1
    }

    if (mainSessionStatus === "busy" || mainSessionStatus === "retry") {
      eventState.pendingSameModelRecovery = false
      eventState.pendingSameModelRecoverySequence = -1
      eventState.pendingSameModelRecoveryStartedAt = null
      eventState.mainSessionIdle = false
    } else if (mainSessionStatus === "idle") {
      eventState.mainSessionIdle = true
    }

    if (eventState.pendingSameModelRecovery) {
      const pendingStartedAt =
        eventState.pendingSameModelRecoveryStartedAt
        ?? eventState.lastErrorTimestamp
        ?? Date.now()
      const hasObservedPostErrorProgress =
        eventState.lastMeaningfulWorkTimestamp !== null
        && eventState.lastErrorTimestamp !== null
        && eventState.lastMeaningfulWorkTimestamp > eventState.lastErrorTimestamp

      if (hasObservedPostErrorProgress) {
        eventState.pendingSameModelRecovery = false
        eventState.pendingSameModelRecoverySequence = -1
        eventState.pendingSameModelRecoveryStartedAt = null
      } else if (Date.now() - pendingStartedAt < delayedRetryErrorGraceMs) {
        const sessionStillSettled = await checkCompletionConditions(ctx)
        if (sessionStillSettled) {
          consecutiveCompleteChecks = 0
          continue
        }

        eventState.pendingSameModelRecovery = false
        eventState.pendingSameModelRecoverySequence = -1
        eventState.pendingSameModelRecoveryStartedAt = null
        consecutiveCompleteChecks = 0
        continue
      } else {
        eventState.pendingSameModelRecovery = false
        eventState.pendingSameModelRecoverySequence = -1
        eventState.pendingSameModelRecoveryStartedAt = null
      }
    }

    if (!eventState.mainSessionIdle) {
      consecutiveCompleteChecks = 0
      continue
    }

    if (eventState.currentTool !== null) {
      consecutiveCompleteChecks = 0
      continue
    }

    if (!eventState.hasReceivedMeaningfulWork) {
      if (Date.now() - pollStartTimestamp < minStabilizationMs) {
        consecutiveCompleteChecks = 0
        continue
      }

      // Secondary timeout: if we've been polling for reasonable time but haven't
      // received meaningful work via events, check if there's active work via API
      // Only check once to avoid unnecessary API calls every poll cycle
      if (
        Date.now() - pollStartTimestamp > secondaryMeaningfulWorkTimeoutMs &&
        !secondaryTimeoutChecked
      ) {
        secondaryTimeoutChecked = true
        // Check if session actually has pending work (children, todos, etc.)
        const childrenRes = await ctx.client.session.children({
          path: { id: ctx.sessionID },
          query: { directory: ctx.directory },
        })
        const children = normalizeSDKResponse(childrenRes, [] as unknown[])
        const todosRes = await ctx.client.session.todo({
          path: { id: ctx.sessionID },
          query: { directory: ctx.directory },
        })
        const todos = normalizeSDKResponse(todosRes, [] as unknown[])

        const hasActiveChildren =
          Array.isArray(children) && children.length > 0
        const hasActiveTodos =
          Array.isArray(todos) &&
          todos.some(
            (t: unknown) =>
              (t as { status?: string })?.status !== "completed" &&
              (t as { status?: string })?.status !== "cancelled"
          )
        const hasActiveWork = hasActiveChildren || hasActiveTodos

        if (hasActiveWork) {
          // Assume meaningful work is happening even without events
          eventState.hasReceivedMeaningfulWork = true
          console.log(
            pc.yellow(
              `\n  No meaningful work events for ${Math.round(
                secondaryMeaningfulWorkTimeoutMs / 1000
              )}s but session has active work - assuming in progress`
            )
          )
        }
      }
    } else {
      // Track when first meaningful work was received
      if (firstWorkTimestamp === null) {
        firstWorkTimestamp = Date.now()
      }

      // Don't check completion during stabilization period
      if (Date.now() - firstWorkTimestamp < minStabilizationMs) {
        consecutiveCompleteChecks = 0
        continue
      }
    }

    const shouldExit = await checkCompletionConditions(ctx)
    if (shouldExit) {
      if (abortController.signal.aborted) {
        return 130
      }

      consecutiveCompleteChecks++
      if (consecutiveCompleteChecks >= requiredConsecutive) {
        console.log(pc.green("\n\nAll tasks completed."))
        return 0
      }
    } else {
      consecutiveCompleteChecks = 0
    }
  }

  return 130
}

async function getMainSessionStatus(
  ctx: RunContext
): Promise<"idle" | "busy" | "retry" | null> {
  try {
    const statusesRes = await ctx.client.session.status({
      query: { directory: ctx.directory },
    })
    const statuses = normalizeSDKResponse(
      statusesRes,
      {} as Record<string, { type?: string }>
    )
    const status = statuses[ctx.sessionID]?.type
    if (status === "idle" || status === "busy" || status === "retry") {
      return status
    }
    return null
  } catch {
    return null
  }
}
