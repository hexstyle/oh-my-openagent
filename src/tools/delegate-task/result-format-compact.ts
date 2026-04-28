/**
 * Compact result formatters for delegate-task tool results.
 *
 * Design principles:
 * - Minimize context tokens consumed by the parent LLM
 * - The caller already knows: agent name, category, model (it dispatched the task)
 * - Only include what the parent LLM needs: textContent + session_id (for continuation)
 * - Metadata for TUI/hooks goes through storeToolMetadata, NOT through result text
 * - Keep <task_metadata> block parseable by existing extractors (atlas, background-output)
 *   but only include essential fields (session_id, task_id)
 */

export interface SyncResultInput {
  textContent: string
  sessionID: string
  duration: string
}

export interface BackgroundLaunchInput {
  taskId: string
  sessionID: string
}

export interface BackgroundResultInput {
  textContent: string
  taskId: string
  sessionID: string
  duration: string
}

export interface FailedResultInput {
  status: string
  sessionID: string
  duration: string
  error?: string
}

export interface TimeoutResultInput {
  sessionID: string
  duration: string
}

/**
 * Format sync task completion result.
 * Compact: content first, then minimal metadata footer.
 * No agent/category/model — caller already knows these.
 */
export function formatSyncResult(input: SyncResultInput): string {
  const content = input.textContent || "(No output)"
  return `${content}\n<task_metadata>session_id: ${input.sessionID}</task_metadata>`
}

/**
 * Format background task launch acknowledgment.
 * Compact: one instruction line + metadata block for session linkage.
 * session_id is ALWAYS included — it's the root linkage for the entire activity chain.
 */
export function formatBackgroundLaunch(input: BackgroundLaunchInput): string {
  return `Launched ${input.taskId}. background_output task_id="${input.taskId}"\n<task_metadata>\nsession_id: ${input.sessionID}\ntask_id: ${input.taskId}\nbackground_task_id: ${input.taskId}\n</task_metadata>`
}

/**
 * Format background task result.
 * Compact: content first, then minimal metadata footer.
 */
export function formatBackgroundResult(input: BackgroundResultInput): string {
  const content = input.textContent || "(No output)"
  return `${content}\n<task_metadata>session_id: ${input.sessionID}\ntask_id: ${input.taskId}</task_metadata>`
}

/**
 * Format failed/interrupted task result.
 */
export function formatFailedResult(input: FailedResultInput): string {
  const errorPart = input.error ? ` — ${input.error}` : ""
  return `FAILED (${input.status}, ${input.duration}) session_id: ${input.sessionID}${errorPart}`
}

/**
 * Format timeout result.
 */
export function formatTimeoutResult(input: TimeoutResultInput): string {
  return `TIMEOUT (${input.duration}) session_id: ${input.sessionID}`
}
