import type { ToolDefinition } from "@opencode-ai/plugin"
import type { BackgroundManager } from "../../features/background-agent"
import type { PluginInput } from "@opencode-ai/plugin"
import type { CategoriesConfig } from "../../config/schema"
import { createReadInboxTool, createSendMessageTool } from "./messaging-tools"
import { createTeamCreateTool, createTeamDeleteTool, createTeamReadConfigTool } from "./team-lifecycle-tools"
import { createForceKillTeammateTool, createProcessShutdownApprovedTool } from "./teammate-control-tools"

export interface AgentTeamsToolOptions {
  client?: PluginInput["client"]
  userCategories?: CategoriesConfig
  sisyphusJuniorModel?: string
}

export function createAgentTeamsTools(
  _manager: BackgroundManager,
  _options?: AgentTeamsToolOptions,
): Record<string, ToolDefinition> {
  return {
    team_create: createTeamCreateTool(),
    team_delete: createTeamDeleteTool(),
    send_message: createSendMessageTool(_manager),
    read_inbox: createReadInboxTool(),
    read_config: createTeamReadConfigTool(),
    force_kill_teammate: createForceKillTeammateTool(),
    process_shutdown_approved: createProcessShutdownApprovedTool(),
  }
}
