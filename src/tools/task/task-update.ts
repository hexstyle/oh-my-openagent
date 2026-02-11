import { join } from "path";
import type { PluginInput } from "@opencode-ai/plugin";
import type { OhMyOpenCodeConfig } from "../../config/schema";
import type { TaskObject, TaskUpdateInput } from "./types";
import { TaskObjectSchema, TaskUpdateInputSchema } from "./types";
import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool";
import {
  getTaskDir,
  readJsonSafe,
  writeJsonAtomic,
  acquireLock,
} from "../../features/claude-tasks/storage";
import { syncTaskTodoUpdate } from "./todo-sync";
import { readTeamTask, writeTeamTask } from "../agent-teams/team-task-store";

const TASK_ID_PATTERN = /^T-[A-Za-z0-9-]+$/;

function parseTaskId(id: string): string | null {
  if (!TASK_ID_PATTERN.test(id)) return null;
  return id;
}

export function createTaskUpdateTool(
  config: Partial<OhMyOpenCodeConfig>,
  ctx?: PluginInput,
): ToolDefinition {
   return tool({
     description: `Update an existing task with new values.

Supports updating: subject, description, status, activeForm, owner, metadata.
For blocks/blockedBy: use addBlocks/addBlockedBy to append (additive, not replacement).
For metadata: merge with existing, set key to null to delete.
Syncs to OpenCode Todo API after update.

**IMPORTANT - Dependency Management:**
Use \`addBlockedBy\` to declare dependencies on other tasks.
Properly managed dependencies enable maximum parallel execution.`,
      args: {
       id: tool.schema.string().describe("Task ID (required)"),
       subject: tool.schema.string().optional().describe("Task subject"),
       description: tool.schema.string().optional().describe("Task description"),
       status: tool.schema
         .enum(["pending", "in_progress", "completed", "deleted"])
         .optional()
         .describe("Task status"),
       activeForm: tool.schema
         .string()
         .optional()
         .describe("Active form (present continuous)"),
       owner: tool.schema
         .string()
         .optional()
         .describe("Task owner (agent name)"),
       addBlocks: tool.schema
         .array(tool.schema.string())
         .optional()
         .describe("Task IDs to add to blocks (additive, not replacement)"),
       addBlockedBy: tool.schema
         .array(tool.schema.string())
         .optional()
         .describe("Task IDs to add to blockedBy (additive, not replacement)"),
       metadata: tool.schema
         .record(tool.schema.string(), tool.schema.unknown())
         .optional()
         .describe("Task metadata to merge (set key to null to delete)"),
       team_name: tool.schema.string().optional().describe("Team namespace for task storage"),
     },
     execute: async (args: Record<string, unknown>, context) => {
       return handleUpdate(args, config, ctx, context);
     },
  });
}

async function handleUpdate(
  args: Record<string, unknown>,
  config: Partial<OhMyOpenCodeConfig>,
  ctx: PluginInput | undefined,
  context: { sessionID: string },
): Promise<string> {
  try {
    const validatedArgs = TaskUpdateInputSchema.parse(args);
    const taskId = parseTaskId(validatedArgs.id);
    if (!taskId) {
      return JSON.stringify({ error: "invalid_task_id" });
    }

    if (validatedArgs.team_name) {
      // Team namespace routing
      const task = readTeamTask(validatedArgs.team_name, taskId);
      if (!task) {
        return JSON.stringify({ error: "task_not_found" });
      }

      if (validatedArgs.subject !== undefined) {
        task.subject = validatedArgs.subject;
      }
      if (validatedArgs.description !== undefined) {
        task.description = validatedArgs.description;
      }
      if (validatedArgs.status !== undefined) {
        task.status = validatedArgs.status;
      }
      if (validatedArgs.activeForm !== undefined) {
        task.activeForm = validatedArgs.activeForm;
      }
      if (validatedArgs.owner !== undefined) {
        task.owner = validatedArgs.owner;
      }

      const addBlocks = args.addBlocks as string[] | undefined;
      if (addBlocks) {
        task.blocks = [...new Set([...task.blocks, ...addBlocks])];
      }

      const addBlockedBy = args.addBlockedBy as string[] | undefined;
      if (addBlockedBy) {
        task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
      }

      if (validatedArgs.metadata !== undefined) {
        task.metadata = { ...task.metadata, ...validatedArgs.metadata };
        Object.keys(task.metadata).forEach((key) => {
          if (task.metadata?.[key] === null) {
            delete task.metadata[key];
          }
        });
      }

      const validatedTask = TaskObjectSchema.parse(task);
      writeTeamTask(validatedArgs.team_name, taskId, validatedTask);

      await syncTaskTodoUpdate(ctx, validatedTask, context.sessionID);

      return JSON.stringify({ task: validatedTask });
    } else {
      // Regular task storage
      const taskDir = getTaskDir(config);
      const lock = acquireLock(taskDir);

      if (!lock.acquired) {
        return JSON.stringify({ error: "task_lock_unavailable" });
      }

      try {
        const taskPath = join(taskDir, `${taskId}.json`);
        const task = readJsonSafe(taskPath, TaskObjectSchema);

        if (!task) {
          return JSON.stringify({ error: "task_not_found" });
        }

        if (validatedArgs.subject !== undefined) {
          task.subject = validatedArgs.subject;
        }
        if (validatedArgs.description !== undefined) {
          task.description = validatedArgs.description;
        }
        if (validatedArgs.status !== undefined) {
          task.status = validatedArgs.status;
        }
        if (validatedArgs.activeForm !== undefined) {
          task.activeForm = validatedArgs.activeForm;
        }
        if (validatedArgs.owner !== undefined) {
          task.owner = validatedArgs.owner;
        }

        const addBlocks = args.addBlocks as string[] | undefined;
        if (addBlocks) {
          task.blocks = [...new Set([...task.blocks, ...addBlocks])];
        }

        const addBlockedBy = args.addBlockedBy as string[] | undefined;
        if (addBlockedBy) {
          task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
        }

        if (validatedArgs.metadata !== undefined) {
          task.metadata = { ...task.metadata, ...validatedArgs.metadata };
          Object.keys(task.metadata).forEach((key) => {
            if (task.metadata?.[key] === null) {
              delete task.metadata[key];
            }
          });
        }

        const validatedTask = TaskObjectSchema.parse(task);
        writeJsonAtomic(taskPath, validatedTask);

        await syncTaskTodoUpdate(ctx, validatedTask, context.sessionID);

        return JSON.stringify({ task: validatedTask });
      } finally {
        lock.release();
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("Required")) {
      return JSON.stringify({
        error: "validation_error",
        message: error.message,
      });
    }
    return JSON.stringify({ error: "internal_error" });
  }
}
