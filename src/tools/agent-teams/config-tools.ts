import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import { readTeamConfig } from "./team-config-store"
import { ReadConfigInputSchema } from "./types"

export function createReadConfigTool(): ToolDefinition {
  return tool({
    description: "Read team configuration and member list.",
    args: {
      team_name: tool.schema.string().describe("Team name"),
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
      try {
        const input = ReadConfigInputSchema.parse(args)
        const config = readTeamConfig(input.team_name)
        if (!config) {
          return JSON.stringify({ error: "team_not_found" })
        }
        return JSON.stringify(config)
      } catch (error) {
        return JSON.stringify({ error: error instanceof Error ? error.message : "read_config_failed" })
      }
    },
  })
}