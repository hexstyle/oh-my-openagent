import type { PluginInput } from "@opencode-ai/plugin"

import { normalizeSDKResponse } from "../../shared"
import { log } from "../../shared/logger"

import { HOOK_NAME } from "./constants"
import type { SessionMessage, Todo } from "./types"

export async function fetchSessionMessages(args: {
  ctx: PluginInput
  sessionID: string
  source: string
}): Promise<SessionMessage[] | null> {
  const { ctx, sessionID, source } = args

  try {
    const response = await ctx.client.session.messages({
      path: { id: sessionID },
      query: { directory: ctx.directory },
    })

    return normalizeSDKResponse(response, [] as SessionMessage[])
  } catch (error) {
    log(`[${HOOK_NAME}] Session messages fetch failed`, {
      sessionID,
      source,
      error: String(error),
    })
    return null
  }
}

export async function fetchSessionTodos(args: {
  ctx: PluginInput
  sessionID: string
  source: string
}): Promise<Todo[] | null> {
  const { ctx, sessionID, source } = args

  try {
    const response = await ctx.client.session.todo({ path: { id: sessionID } })
    return normalizeSDKResponse(response, [] as Todo[], {
      preferResponseOnMissingData: true,
    })
  } catch (error) {
    log(`[${HOOK_NAME}] Session todo fetch failed`, {
      sessionID,
      source,
      error: String(error),
    })
    return null
  }
}
