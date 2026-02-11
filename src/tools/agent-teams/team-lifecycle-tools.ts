import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import { z } from "zod"
import { getTeamConfigPath } from "./paths"
import { validateTeamName } from "./name-validation"
import { ensureInbox } from "./inbox-store"
import {
  TeamConfig,
  TeamCreateInputSchema,
  TeamDeleteInputSchema,
  TeamReadConfigInputSchema,
  TeamToolContext,
  isTeammateMember,
} from "./types"
import { createTeamConfig, deleteTeamData, listTeammates, readTeamConfig, readTeamConfigOrThrow } from "./team-config-store"

function resolveReaderFromContext(config: TeamConfig, context: TeamToolContext): "team-lead" | string | null {
  if (context.sessionID === config.leadSessionId) {
    return "team-lead"
  }

  const matchedMember = config.members.find((member) => isTeammateMember(member) && member.sessionID === context.sessionID)
  return matchedMember?.name ?? null
}

function toPublicTeamConfig(config: TeamConfig): {
  team_name: string
  description: string | undefined
  lead_agent_id: string
  teammates: Array<{ name: string }>
} {
  return {
    team_name: config.name,
    description: config.description,
    lead_agent_id: config.leadAgentId,
    teammates: listTeammates(config).map((member) => ({ name: member.name })),
  }
}

export function createTeamCreateTool(): ToolDefinition {
   return tool({
     description: "Create a team workspace with config, inboxes, and task storage.",
     args: {
       team_name: tool.schema.string().describe("Team name (letters, numbers, hyphens, underscores)"),
       description: tool.schema.string().optional().describe("Team description"),
     },
     execute: async (args: Record<string, unknown>, context: TeamToolContext): Promise<string> => {
       try {
         const input = TeamCreateInputSchema.parse(args)

         const config = createTeamConfig(
           input.team_name,
           input.description ?? "",
           context.sessionID,
           process.cwd(),
           "native/team-lead",
         )
         ensureInbox(config.name, "team-lead")

         return JSON.stringify({
           team_name: config.name,
           config_path: getTeamConfigPath(config.name) as string,
           lead_agent_id: config.leadAgentId,
         })
       } catch (error) {
         if (error instanceof Error && error.message === "team_already_exists") {
           return JSON.stringify({ error: error.message })
         }
         return JSON.stringify({ error: "team_create_failed" })
       }
     },
   })
 }

export function createTeamDeleteTool(): ToolDefinition {
   return tool({
     description: "Delete a team and its stored data. Fails if teammates still exist.",
     args: {
       team_name: tool.schema.string().describe("Team name"),
     },
     execute: async (args: Record<string, unknown>, _context: TeamToolContext): Promise<string> => {
       let teamName: string | undefined

       try {
         const input = TeamDeleteInputSchema.parse(args)
         teamName = input.team_name
         const config = readTeamConfig(input.team_name)
         if (!config) {
           return JSON.stringify({ error: "team_not_found" })
         }

         const teammates = listTeammates(config)
         if (teammates.length > 0) {
           return JSON.stringify({
             error: "team_has_active_members",
             members: teammates.map((member) => member.name),
           })
         }

         deleteTeamData(input.team_name)
         return JSON.stringify({ deleted: true, team_name: input.team_name })
       } catch (error) {
         if (error instanceof Error) {
           if (error.message === "team_has_active_members") {
             const config = readTeamConfig(teamName!)
             const activeMembers = config ? listTeammates(config) : []
             return JSON.stringify({
               error: "team_has_active_members",
               members: activeMembers.map((member) => member.name),
             })
           }
           if (error.message === "team_not_found") {
             return JSON.stringify({ error: "team_not_found" })
           }
           return JSON.stringify({ error: error.message })
         }
         return JSON.stringify({ error: "team_delete_failed" })
       }
     },
   })
 }

export function createTeamReadConfigTool(): ToolDefinition {
  return tool({
    description: "Read team configuration and member list.",
    args: {
      team_name: tool.schema.string().describe("Team name"),
    },
    execute: async (args: Record<string, unknown>, context: TeamToolContext): Promise<string> => {
      try {
        const input = TeamReadConfigInputSchema.parse(args)
        const config = readTeamConfig(input.team_name)
        if (!config) {
          return JSON.stringify({ error: "team_not_found" })
        }

        const actor = resolveReaderFromContext(config, context)
        if (!actor) {
          return JSON.stringify({ error: "unauthorized_reader_session" })
        }

        if (actor !== "team-lead") {
          return JSON.stringify(toPublicTeamConfig(config))
        }

        return JSON.stringify(config)
      } catch (error) {
        return JSON.stringify({ error: error instanceof Error ? error.message : "team_read_config_failed" })
      }
    },
  })
}
