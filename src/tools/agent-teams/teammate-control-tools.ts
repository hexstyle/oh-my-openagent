import { tool } from "@opencode-ai/plugin/tool"
import { ForceKillTeammateInputSchema, ProcessShutdownApprovedInputSchema, isTeammateMember } from "./types"
import { readTeamConfig, removeTeammate, updateTeamConfig, getTeamMember } from "./team-config-store"
import { deleteInbox } from "./inbox-store"

export function createForceKillTeammateTool() {
  return tool({
    description: "Force kill a teammate - remove from team config and delete inbox without graceful shutdown.",
    args: {
      team_name: tool.schema.string().describe("Team name"),
      teammate_name: tool.schema.string().describe("Teammate name to kill"),
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
      try {
        const input = ForceKillTeammateInputSchema.parse(args)

        const config = readTeamConfig(input.team_name)
        if (!config) {
          return JSON.stringify({ error: "team_not_found" })
        }

        const teammate = getTeamMember(config, input.teammate_name)
        if (!teammate) {
          return JSON.stringify({ error: "teammate_not_found" })
        }

        if (input.teammate_name === "team-lead") {
          return JSON.stringify({ error: "cannot_remove_team_lead" })
        }

        if (!isTeammateMember(teammate)) {
          return JSON.stringify({ error: "not_a_teammate" })
        }

        updateTeamConfig(input.team_name, (config) => removeTeammate(config, input.teammate_name))
        deleteInbox(input.team_name, input.teammate_name)

        return JSON.stringify({
          killed: true,
          teammate_name: input.teammate_name,
        })
      } catch (error) {
        if (error instanceof Error) {
          if (error.message === "cannot_remove_team_lead") {
            return JSON.stringify({ error: "cannot_remove_team_lead" })
          }
          return JSON.stringify({ error: error.message })
        }
        return JSON.stringify({ error: "force_kill_failed" })
      }
    },
  })
}

export function createProcessShutdownApprovedTool() {
  return tool({
    description:
      "Process approved teammate shutdown - remove from team config and delete inbox gracefully.",
    args: {
      team_name: tool.schema.string().describe("Team name"),
      teammate_name: tool.schema.string().describe("Teammate name to shutdown"),
    },
    execute: async (args: Record<string, unknown>): Promise<string> => {
      try {
        const input = ProcessShutdownApprovedInputSchema.parse(args)

        const config = readTeamConfig(input.team_name)
        if (!config) {
          return JSON.stringify({ error: "team_not_found" })
        }

        const teammate = getTeamMember(config, input.teammate_name)
        if (!teammate) {
          return JSON.stringify({ error: "teammate_not_found" })
        }

        if (input.teammate_name === "team-lead") {
          return JSON.stringify({ error: "cannot_remove_team_lead" })
        }

        if (!isTeammateMember(teammate)) {
          return JSON.stringify({ error: "not_a_teammate" })
        }

        updateTeamConfig(input.team_name, (config) => removeTeammate(config, input.teammate_name))
        deleteInbox(input.team_name, input.teammate_name)

        return JSON.stringify({
          shutdown_processed: true,
          teammate_name: input.teammate_name,
        })
      } catch (error) {
        if (error instanceof Error) {
          if (error.message === "cannot_remove_team_lead") {
            return JSON.stringify({ error: "cannot_remove_team_lead" })
          }
          return JSON.stringify({ error: error.message })
        }
        return JSON.stringify({ error: "shutdown_processing_failed" })
      }
    },
  })
}
