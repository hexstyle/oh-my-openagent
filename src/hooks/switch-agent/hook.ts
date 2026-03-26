import type { ChatMessageHandlerOutput, ChatMessageInput } from "../../plugin/chat-message"
import {
  consumePendingSessionAgentSwitch,
  updateSessionAgent,
} from "../../features/claude-code-session-state"

export function createSwitchAgentHook() {
  return {
    "chat.message": async (input: ChatMessageInput, output: ChatMessageHandlerOutput): Promise<void> => {
      const pendingSwitch = consumePendingSessionAgentSwitch(input.sessionID)
      if (!pendingSwitch) {
        return
      }

      output.message["agent"] = pendingSwitch.agent
      input.agent = pendingSwitch.agent
      updateSessionAgent(input.sessionID, pendingSwitch.agent)
    },
  }
}
