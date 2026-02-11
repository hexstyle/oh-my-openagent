import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import { readInbox } from "./inbox-store"
import { ReadInboxInputSchema } from "./types"

export function createReadInboxTool(): ToolDefinition {
  return tool({
    description: "Read inbox messages for a team member.",
    args: {
      team_name: tool.schema.string().describe("Team name"),
      agent_name: tool.schema.string().describe("Member name"),
      unread_only: tool.schema.boolean().optional().describe("Return only unread messages"),
      mark_as_read: tool.schema.boolean().optional().describe("Mark returned messages as read"),
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
      try {
        const input = ReadInboxInputSchema.parse(args)
        const messages = readInbox(
          input.team_name,
          input.agent_name,
          input.unread_only ?? false,
          input.mark_as_read ?? false,
        )
        return JSON.stringify(messages)
      } catch (error) {
        return JSON.stringify({ error: error instanceof Error ? error.message : "read_inbox_failed" })
      }
    },
  })
}