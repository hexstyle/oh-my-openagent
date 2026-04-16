import type { PluginInput } from "@opencode-ai/plugin"

import { findNearestMessageWithFields, findFirstMessageWithAgent } from "../../features/hook-message-injector"
import {
  findFirstMessageWithAgentFromSDK,
  findNearestMessageWithFieldsFromSDK,
} from "../../features/hook-message-injector"
import { getSessionAgent } from "../../features/claude-code-session-state"
import { readBoulderState } from "../../features/boulder-state"
import { getMessageDir } from "../../shared/opencode-message-dir"
import { isSqliteBackend } from "../../shared/opencode-storage-detection"

type OpencodeClient = PluginInput["client"]

function isCompactionAgent(agent: string): boolean {
  return agent.toLowerCase() === "compaction"
}

async function getAgentFromMessageFiles(
  sessionID: string,
  client?: OpencodeClient
): Promise<string | undefined> {
  if (isSqliteBackend() && client) {
    const firstAgent = await findFirstMessageWithAgentFromSDK(client, sessionID)
    if (firstAgent && !isCompactionAgent(firstAgent)) return firstAgent

    const nearest = await findNearestMessageWithFieldsFromSDK(client, sessionID)
    if (nearest?.agent && !isCompactionAgent(nearest.agent)) return nearest.agent
    return undefined
  }

  const messageDir = getMessageDir(sessionID)
  if (!messageDir) return undefined
  const firstAgent = findFirstMessageWithAgent(messageDir)
  if (firstAgent && !isCompactionAgent(firstAgent)) return firstAgent
  const nearestAgent = findNearestMessageWithFields(messageDir)?.agent
  if (nearestAgent && !isCompactionAgent(nearestAgent)) return nearestAgent
  return undefined
}

/**
 * Get the effective agent for the session.
 * Priority order:
 * 1. Boulder state agent for tracked execution sessions (authoritative after /start-work)
 * 2. In-memory session agent (current non-boulder session state)
 * 3. Message files (fallback for sessions without boulder state)
 *
 * This fixes issue #927 where after interruption:
 * - In-memory map is cleared (process restart)
 * - Message files return "prometheus" (oldest message from /plan)
 * - But boulder.json has agent: "atlas" (set by /start-work)
 *
 * Boulder must also win over stale in-memory Prometheus because execution sessions
 * can receive internal user prompts/reminders that momentarily restore the planner
 * agent name into memory while the boulder itself is still owned by Atlas/Sisyphus.
 */
export async function getAgentFromSession(
  sessionID: string,
  directory: string,
  client?: OpencodeClient
): Promise<string | undefined> {
  // Boulder is authoritative for tracked execution sessions started via /start-work.
  const boulderState = readBoulderState(directory)
  if (boulderState?.session_ids?.includes(sessionID) && boulderState.agent) {
    return boulderState.agent
  }

  // Check in-memory for non-boulder sessions.
  const memoryAgent = getSessionAgent(sessionID)
  if (memoryAgent) return memoryAgent

  // Fallback to message files
  return await getAgentFromMessageFiles(sessionID, client)
}
