import { tool, type ToolDefinition } from "@opencode-ai/plugin"
import type { BackgroundTask } from "../../features/background-agent"
import { BACKGROUND_WAIT_DESCRIPTION } from "./constants"
import { delay } from "./delay"
import type { BackgroundOutputManager, BackgroundWaitArgs, BackgroundWaitResult } from "./types"

type WaitTaskStatus = "pending" | "running" | "completed" | "error" | "cancelled" | "interrupt" | "not_found"

const TERMINAL_STATUSES: ReadonlySet<BackgroundTask["status"]> = new Set([
  "completed",
  "error",
  "cancelled",
  "interrupt",
])

function isTerminalStatus(status: BackgroundTask["status"]): boolean {
  return TERMINAL_STATUSES.has(status)
}

function toValidTaskIDs(taskIDs: string[]): string[] {
  const uniqueTaskIDs = new Set<string>()
  for (const taskID of taskIDs) {
    const normalized = taskID.trim()
    if (normalized) {
      uniqueTaskIDs.add(normalized)
    }
  }
  return [...uniqueTaskIDs]
}

export function createBackgroundWait(manager: BackgroundOutputManager): ToolDefinition {
  return tool({
    description: BACKGROUND_WAIT_DESCRIPTION,
    args: {
      task_ids: tool.schema.array(tool.schema.string()).describe("Task IDs to inspect as a group"),
      mode: tool.schema.string().optional().describe("all (default) waits for all, any returns on first quorum/race completion"),
      quorum: tool.schema.number().optional().describe("Optional terminal-task quorum target"),
      block: tool.schema.boolean().optional().describe("Wait for quorum/race completion (default: false)"),
      timeout: tool.schema.number().optional().describe("Max wait time in ms when block=true (default: 60000, max: 600000)"),
      poll_interval: tool.schema.number().optional().describe("Polling interval in ms when block=true (default: 1000, min: 100)"),
    },
    async execute(args: BackgroundWaitArgs) {
      const taskIDs = toValidTaskIDs(args.task_ids)
      if (taskIDs.length === 0) {
        return "Error: task_ids must contain at least one task ID."
      }

      const mode = args.mode === "any" ? "any" : args.mode === undefined || args.mode === "all" ? "all" : null
      if (!mode) {
        return `Error: invalid mode \"${args.mode}\". Use \"all\" or \"any\".`
      }

      if (args.quorum !== undefined && (!Number.isInteger(args.quorum) || args.quorum < 1)) {
        return "Error: quorum must be a positive integer."
      }

      const timeoutMs = Math.min(args.timeout ?? 60000, 600000)
      const pollIntervalMs = Math.max(args.poll_interval ?? 1000, 100)
      const block = args.block === true
      const quorumTarget = Math.min(args.quorum ?? (mode === "any" ? 1 : taskIDs.length), taskIDs.length)
      const startTime = Date.now()

      const buildSnapshot = (): BackgroundWaitResult => {
        const byStatus: Record<string, number> = {
          pending: 0,
          running: 0,
          completed: 0,
          error: 0,
          cancelled: 0,
          interrupt: 0,
          not_found: 0,
        }

        const tasks = taskIDs.map((taskID) => {
          const task = manager.getTask(taskID)
          if (!task) {
            byStatus.not_found += 1
            return {
              task_id: taskID,
              found: false,
              status: "not_found" as const,
            }
          }

          byStatus[task.status] += 1
          return {
            task_id: task.id,
            found: true,
            status: task.status,
            agent: task.agent,
            description: task.description,
            session_id: task.sessionID,
            started_at: task.startedAt?.toISOString(),
            completed_at: task.completedAt?.toISOString(),
          }
        })

        const terminalCount = tasks.filter((task) => task.found && isTerminalStatus(task.status as BackgroundTask["status"]))
          .length
        const activeCount = tasks.filter((task) => task.status === "pending" || task.status === "running").length
        const quorumReached = terminalCount >= quorumTarget

        return {
          mode,
          block,
          timeout_ms: timeoutMs,
          waited_ms: Date.now() - startTime,
          done: quorumReached,
          reason: block ? "waiting" : "non_blocking",
          quorum: {
            target: quorumTarget,
            reached: terminalCount,
            remaining: Math.max(quorumTarget - terminalCount, 0),
            progress: quorumTarget === 0 ? 1 : terminalCount / quorumTarget,
          },
          summary: {
            total: tasks.length,
            terminal: terminalCount,
            active: activeCount,
            by_status: byStatus,
          },
          grouped: {
            pending: tasks.filter((task) => task.status === "pending").map((task) => task.task_id),
            running: tasks.filter((task) => task.status === "running").map((task) => task.task_id),
            completed: tasks.filter((task) => task.status === "completed").map((task) => task.task_id),
            error: tasks.filter((task) => task.status === "error").map((task) => task.task_id),
            cancelled: tasks.filter((task) => task.status === "cancelled").map((task) => task.task_id),
            interrupt: tasks.filter((task) => task.status === "interrupt").map((task) => task.task_id),
            not_found: tasks.filter((task) => task.status === "not_found").map((task) => task.task_id),
          },
          tasks: tasks.map((task) => ({
            ...task,
            status: task.status as WaitTaskStatus,
          })),
        }
      }

      let snapshot = buildSnapshot()
      if (!block) {
        return JSON.stringify(snapshot, null, 2)
      }

      while (!snapshot.done && Date.now() - startTime < timeoutMs) {
        await delay(pollIntervalMs)
        snapshot = buildSnapshot()
      }

      const finalSnapshot: BackgroundWaitResult = {
        ...snapshot,
        waited_ms: Date.now() - startTime,
        done: snapshot.done,
        reason: snapshot.done ? "quorum_reached" : "timeout",
      }

      return JSON.stringify(finalSnapshot, null, 2)
    },
  })
}
