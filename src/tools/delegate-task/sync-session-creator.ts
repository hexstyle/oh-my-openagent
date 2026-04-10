import type { OpencodeClient } from "./types"
import { QUESTION_DENIED_SESSION_PERMISSION } from "../../shared/question-denied-session-permission"
import { normalizeAgentForDisplay } from "../../shared/agent-display-names"
import { resolveSessionDirectory } from "../../shared"
import { resolveBoulderExecutionDirectory } from "../../features/boulder-state"

export async function createSyncSession(
  client: OpencodeClient,
  input: { parentSessionID: string; agentToUse: string; description: string; defaultDirectory: string }
): Promise<{ ok: true; sessionID: string; parentDirectory: string } | { ok: false; error: string }> {
  const parentSession = client.session.get
    ? await client.session.get({ path: { id: input.parentSessionID } }).catch(() => null)
    : null
  const sessionDirectory = resolveSessionDirectory({
    parentDirectory: parentSession?.data?.directory,
    fallbackDirectory: input.defaultDirectory,
  })
  const parentDirectory = resolveBoulderExecutionDirectory(input.defaultDirectory, sessionDirectory)
  const titleAgent = normalizeAgentForDisplay(input.agentToUse) ?? input.agentToUse

  const createResult = await client.session.create({
    body: {
      parentID: input.parentSessionID,
      title: `${input.description} (@${titleAgent} subagent)`,
      permission: QUESTION_DENIED_SESSION_PERMISSION,
    } as Record<string, unknown>,
    query: {
      directory: parentDirectory,
    },
  })

  if (createResult.error) {
    return { ok: false, error: `Failed to create session: ${createResult.error}` }
  }

  return { ok: true, sessionID: createResult.data.id, parentDirectory }
}
