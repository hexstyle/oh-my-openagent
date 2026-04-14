import type { BackgroundManager } from "./manager"
import type { BackgroundTask } from "./types"
import { log } from "../../shared/logger"

export interface ParentSessionTaskInspection {
  available: boolean
  tasks: BackgroundTask[]
  hasRunningTasks: boolean
  hasActiveTasks: boolean
}

export function inspectParentSessionTasks(args: {
  backgroundManager?: Pick<BackgroundManager, "getTasksByParentSession">
  sessionID: string
  logScope: string
}): ParentSessionTaskInspection {
  const { backgroundManager, sessionID, logScope } = args

  if (!backgroundManager) {
    return {
      available: true,
      tasks: [],
      hasRunningTasks: false,
      hasActiveTasks: false,
    }
  }

  try {
    const tasks = backgroundManager.getTasksByParentSession(sessionID)
    const normalizedTasks = Array.isArray(tasks) ? tasks : []

    return {
      available: true,
      tasks: normalizedTasks,
      hasRunningTasks: normalizedTasks.some((task) => task.status === "running"),
      hasActiveTasks: normalizedTasks.some((task) => task.status === "running" || task.status === "pending"),
    }
  } catch (error) {
    log(`[${logScope}] Failed to inspect background tasks`, {
      sessionID,
      error: String(error),
    })

    return {
      available: false,
      tasks: [],
      hasRunningTasks: false,
      hasActiveTasks: false,
    }
  }
}
