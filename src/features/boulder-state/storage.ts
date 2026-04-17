/**
 * Boulder State Storage
 *
 * Handles reading/writing boulder.json for active plan tracking.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs"
import { dirname, join, basename, resolve } from "node:path"
import type { BoulderState, PlanProgress, TaskSessionState } from "./types"
import { BOULDER_DIR, BOULDER_FILE, PROMETHEUS_PLANS_DIR } from "./constants"

const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"])
const TODO_HEADING_PATTERN = /^##\s+TODOs\b/i
const FINAL_VERIFICATION_HEADING_PATTERN = /^##\s+Final Verification Wave\b/i
const SECOND_LEVEL_HEADING_PATTERN = /^##\s+/
const CHECKBOX_PATTERN = /^(\s*)[-*]\s*\[([xX\s])\]\s+.+$/

type PlanSection = "todo" | "final-wave" | "other"
type ParsedPlanTask = {
  checked: boolean
  evidenceRefs: string[]
}

const EVIDENCE_REF_PATTERN = /\.sisyphus\/evidence\/[^\s`")]+\/?/g

function inferPlanRoot(planPath: string): string {
  const marker = `${join(".sisyphus", "")}`.replace(/\\/g, "/")
  const normalizedPlanPath = planPath.replace(/\\/g, "/")
  const markerIndex = normalizedPlanPath.lastIndexOf(`/${marker}/`)
  if (markerIndex === -1) {
    return dirname(planPath)
  }

  return normalizedPlanPath.slice(0, markerIndex)
}

function extractEvidenceRefs(line: string): string[] {
  return [...line.matchAll(EVIDENCE_REF_PATTERN)]
    .map((match) => match[0]?.replace(/[),.;:]+$/g, "") ?? "")
    .filter((value) => value.length > 0)
}

function hasRequiredEvidence(planRoot: string, task: ParsedPlanTask): boolean {
  if (task.evidenceRefs.length === 0) {
    return true
  }

  return [...new Set(task.evidenceRefs)].every((ref) => {
    const absolutePath = resolve(planRoot, ref)
    if (!existsSync(absolutePath)) {
      return false
    }

    if (ref.endsWith("/")) {
      try {
        return readdirSync(absolutePath).length > 0
      } catch {
        return false
      }
    }

    return true
  })
}

function parsePlanTasks(planPath: string): {
  structuredTasks: ParsedPlanTask[]
  fallbackTasks: ParsedPlanTask[]
} {
  const content = readFileSync(planPath, "utf-8")
  const lines = content.split(/\r?\n/)
  let section: PlanSection = "other"
  const structuredTasks: ParsedPlanTask[] = []
  const fallbackTasks: ParsedPlanTask[] = []
  let currentStructuredTask: ParsedPlanTask | null = null
  let currentFallbackTask: ParsedPlanTask | null = null

  for (const line of lines) {
    if (SECOND_LEVEL_HEADING_PATTERN.test(line)) {
      section = TODO_HEADING_PATTERN.test(line)
        ? "todo"
        : FINAL_VERIFICATION_HEADING_PATTERN.test(line)
          ? "final-wave"
          : "other"
      currentStructuredTask = null
      currentFallbackTask = null
    }

    const checkboxMatch = line.match(CHECKBOX_PATTERN)
    if (checkboxMatch) {
      const indent = checkboxMatch[1].length
      const checked = checkboxMatch[2].trim().toLowerCase() === "x"

      if (indent === 0) {
        currentFallbackTask = { checked, evidenceRefs: [] }
        fallbackTasks.push(currentFallbackTask)

        if (section === "todo" || section === "final-wave") {
          currentStructuredTask = { checked, evidenceRefs: [] }
          structuredTasks.push(currentStructuredTask)
        } else {
          currentStructuredTask = null
        }
      }
    }

    const refs = extractEvidenceRefs(line)
    if (refs.length === 0) {
      continue
    }

    if (currentStructuredTask) {
      currentStructuredTask.evidenceRefs.push(...refs)
    }

    if (currentFallbackTask && currentFallbackTask !== currentStructuredTask) {
      currentFallbackTask.evidenceRefs.push(...refs)
    }
  }

  return { structuredTasks, fallbackTasks }
}

export function getBoulderFilePath(directory: string): string {
  return join(directory, BOULDER_DIR, BOULDER_FILE)
}

function normalizeWorktreePath(worktreePath: unknown): string | undefined {
  if (typeof worktreePath !== "string") {
    return undefined
  }

  const trimmedWorktreePath = worktreePath.trim()
  if (!trimmedWorktreePath) {
    return undefined
  }

  if (!existsSync(trimmedWorktreePath)) {
    return undefined
  }

  return trimmedWorktreePath
}

function normalizeBoulderState(parsed: Record<string, unknown>): BoulderState {
  const activePlan = typeof parsed.active_plan === "string" ? parsed.active_plan : ""
  const normalizedPlanName = activePlan ? getPlanName(activePlan) : ""
  const storedPlanName = typeof parsed.plan_name === "string" ? parsed.plan_name : ""
  const hadPlanMismatch =
    Boolean(activePlan)
    && Boolean(storedPlanName)
    && storedPlanName !== normalizedPlanName

  return {
    ...parsed,
    session_ids: Array.isArray(parsed.session_ids) ? parsed.session_ids : [],
    task_sessions:
      hadPlanMismatch || !parsed.task_sessions || typeof parsed.task_sessions !== "object" || Array.isArray(parsed.task_sessions)
        ? {}
        : parsed.task_sessions as Record<string, TaskSessionState>,
    plan_name: normalizedPlanName || storedPlanName,
  } as BoulderState
}

export function readBoulderState(directory: string | undefined): BoulderState | null {
  if (!directory) {
    return null
  }

  const filePath = getBoulderFilePath(directory)

  if (!existsSync(filePath)) {
    return null
  }

  try {
    const content = readFileSync(filePath, "utf-8")
    const parsed = JSON.parse(content)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null
    }

    return normalizeBoulderState(parsed as Record<string, unknown>)
  } catch {
    return null
  }
}

export function writeBoulderState(directory: string, state: BoulderState): boolean {
  const filePath = getBoulderFilePath(directory)

  try {
    const dir = dirname(filePath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    const normalizedState = normalizeBoulderState(state as unknown as Record<string, unknown>)
    writeFileSync(filePath, JSON.stringify(normalizedState, null, 2), "utf-8")
    return true
  } catch {
    return false
  }
}

export function appendSessionId(directory: string, sessionId: string): BoulderState | null {
  const state = readBoulderState(directory)
  if (!state) return null

  if (!state.session_ids?.includes(sessionId)) {
    if (!Array.isArray(state.session_ids)) {
      state.session_ids = []
    }
    const originalSessionIds = [...state.session_ids]
    state.session_ids.push(sessionId)
    if (writeBoulderState(directory, state)) {
      return state
    }
    state.session_ids = originalSessionIds
    return null
  }

  return state
}

export function clearBoulderState(directory: string): boolean {
  const filePath = getBoulderFilePath(directory)

  try {
    if (existsSync(filePath)) {
      const { unlinkSync } = require("node:fs")
      unlinkSync(filePath)
    }
    return true
  } catch {
    return false
  }
}

export function getTaskSessionState(directory: string, taskKey: string): TaskSessionState | null {
  const state = readBoulderState(directory)
  if (!state?.task_sessions) {
    return null
  }

  return state.task_sessions[taskKey] ?? null
}

export function upsertTaskSessionState(
  directory: string,
  input: {
    taskKey: string
    taskLabel: string
    taskTitle: string
    sessionId: string
    agent?: string
    category?: string
  },
): BoulderState | null {
  const state = readBoulderState(directory)
  if (!state) {
    return null
  }

  if (RESERVED_KEYS.has(input.taskKey)) {
    return null
  }

  const taskSessions = state.task_sessions ?? {}
  taskSessions[input.taskKey] = {
    task_key: input.taskKey,
    task_label: input.taskLabel,
    task_title: input.taskTitle,
    session_id: input.sessionId,
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
    ...(input.category !== undefined ? { category: input.category } : {}),
    updated_at: new Date().toISOString(),
  }

  state.task_sessions = taskSessions
  if (writeBoulderState(directory, state)) {
    return state
  }

  return null
}

export function clearTaskSessionState(directory: string, taskKey: string): BoulderState | null {
  const state = readBoulderState(directory)
  if (!state?.task_sessions || RESERVED_KEYS.has(taskKey) || !(taskKey in state.task_sessions)) {
    return state
  }

  const taskSessions = { ...state.task_sessions }
  delete taskSessions[taskKey]
  state.task_sessions = taskSessions

  if (writeBoulderState(directory, state)) {
    return state
  }

  return null
}

export function getBoulderWorktreePath(directory: string | undefined): string | undefined {
  return normalizeWorktreePath(readBoulderState(directory)?.worktree_path)
}

export function resolveBoulderExecutionDirectory(directory: string | undefined, fallbackDirectory: string | undefined): string {
  return getBoulderWorktreePath(directory) ?? fallbackDirectory ?? directory ?? process.cwd()
}

/**
 * Find Prometheus plan files for this project.
 * Prometheus stores plans at: {project}/.sisyphus/plans/{name}.md
 */
export function findPrometheusPlans(directory: string): string[] {
  const plansDir = join(directory, PROMETHEUS_PLANS_DIR)

  if (!existsSync(plansDir)) {
    return []
  }

  try {
    const files = readdirSync(plansDir)
    return files
      .filter((f) => f.endsWith(".md"))
      .map((f) => join(plansDir, f))
      .sort((a, b) => {
        // Sort by modification time, newest first
        const aStat = require("node:fs").statSync(a)
        const bStat = require("node:fs").statSync(b)
        return bStat.mtimeMs - aStat.mtimeMs
      })
  } catch {
    return []
  }
}

/**
 * Parse a plan file and count checkbox progress.
 */
export function getPlanProgress(planPath: string): PlanProgress {
  if (!existsSync(planPath)) {
    return { total: 0, completed: 0, isComplete: true }
  }

  try {
    const { structuredTasks, fallbackTasks } = parsePlanTasks(planPath)
    const tasks = structuredTasks.length > 0 ? structuredTasks : fallbackTasks
    const planRoot = inferPlanRoot(planPath)
    const total = tasks.length
    const completed = tasks.filter((task) => task.checked && hasRequiredEvidence(planRoot, task)).length

    return {
      total,
      completed,
      isComplete: total > 0 && completed === total,
    }
  } catch {
    return { total: 0, completed: 0, isComplete: true }
  }
}

/**
 * Extract plan name from file path.
 */
export function getPlanName(planPath: string): string {
  return basename(planPath, ".md")
}

/**
 * Create a new boulder state for a plan.
 */
export function createBoulderState(
  planPath: string,
  sessionId: string,
  agent?: string,
  worktreePath?: string,
): BoulderState {
  return {
    active_plan: planPath,
    started_at: new Date().toISOString(),
    session_ids: [sessionId],
    plan_name: getPlanName(planPath),
    ...(agent !== undefined ? { agent } : {}),
    ...(worktreePath !== undefined ? { worktree_path: worktreePath } : {}),
  }
}
