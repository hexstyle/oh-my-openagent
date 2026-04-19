import type { PluginInput } from "@opencode-ai/plugin"
import { appendSessionId, getPlanProgress, readBoulderState } from "../../features/boulder-state"
import type { BoulderSessionOrigin, BoulderState, PlanProgress } from "../../features/boulder-state"
import { getSessionAgent, subagentSessions, syncSubagentSessions } from "../../features/claude-code-session-state"
import { getAgentConfigKey } from "../../shared/agent-display-names"
import { isSessionInBoulderLineage } from "./boulder-session-lineage"
import { getLastAgentFromSession } from "./session-last-agent"

function resolveSessionOrigin(
  boulderState: BoulderState,
  sessionID: string,
): BoulderSessionOrigin {
  const storedOrigin = boulderState.session_origins?.[sessionID]
  if (storedOrigin === "appended" || storedOrigin === "direct") {
    return storedOrigin
  }

  return subagentSessions.has(sessionID) ? "appended" : "direct"
}

async function resolveSessionAgent(input: {
  client: PluginInput["client"]
  sessionID: string
}): Promise<string | undefined> {
  const inMemoryAgent = getSessionAgent(input.sessionID)
  if (inMemoryAgent) {
    return inMemoryAgent
  }

  if (typeof input.client.session.messages !== "function") {
    return undefined
  }

  return await getLastAgentFromSession(input.sessionID, input.client) ?? undefined
}

function agentsMatch(sessionAgent: string, requiredAgentName: string): boolean {
  const sessionAgentKey = getAgentConfigKey(sessionAgent)
  const requiredAgentKey = getAgentConfigKey(requiredAgentName)
  return sessionAgentKey === requiredAgentKey
    || (requiredAgentKey === getAgentConfigKey("atlas") && sessionAgentKey === getAgentConfigKey("sisyphus"))
}

export async function resolveActiveBoulderSession(input: {
  client: PluginInput["client"]
  directory: string
  sessionID: string
}): Promise<{
  boulderState: BoulderState
  progress: PlanProgress
  appendedSession: boolean
  sessionOrigin: BoulderSessionOrigin
  sessionAgent?: string
} | null> {
  const boulderState = readBoulderState(input.directory)
  if (!boulderState) {
    return null
  }

  if (syncSubagentSessions.has(input.sessionID)) {
    return null
  }

  const progress = getPlanProgress(boulderState.active_plan)
  if (boulderState.session_ids.includes(input.sessionID)) {
    const sessionOrigin = resolveSessionOrigin(boulderState, input.sessionID)
    const sessionAgent = sessionOrigin === "appended"
      ? await resolveSessionAgent({ client: input.client, sessionID: input.sessionID })
      : undefined

    if (sessionOrigin === "appended") {
      const belongsToActiveBoulder = await isSessionInBoulderLineage({
        client: input.client,
        sessionID: input.sessionID,
        boulderSessionIDs: boulderState.session_ids.filter((sessionID) => sessionID !== input.sessionID),
      })
      if (!belongsToActiveBoulder) {
        return null
      }
    }

    return {
      boulderState,
      progress,
      appendedSession: false,
      sessionOrigin,
      sessionAgent,
    }
  }

  if (progress.isComplete) {
    return null
  }

  if (!subagentSessions.has(input.sessionID)) {
    return null
  }

  const belongsToActiveBoulder = await isSessionInBoulderLineage({
    client: input.client,
    sessionID: input.sessionID,
    boulderSessionIDs: boulderState.session_ids,
  })
  if (!belongsToActiveBoulder) {
    return null
  }

  const requiredAgentName = boulderState.agent ?? "atlas"
  const sessionAgent = await resolveSessionAgent({ client: input.client, sessionID: input.sessionID })
  if (!sessionAgent || !agentsMatch(sessionAgent, requiredAgentName)) {
    return null
  }

  const updatedBoulderState = appendSessionId(input.directory, input.sessionID, "appended")
  if (!updatedBoulderState?.session_ids.includes(input.sessionID)) {
    return null
  }

  return {
    boulderState: updatedBoulderState,
    progress,
    appendedSession: true,
    sessionOrigin: "appended",
    sessionAgent,
  }
}
