type PendingAgentSwitch = {
  agent: string
  requestedAt: Date
}

const pendingAgentSwitchBySession = new Map<string, PendingAgentSwitch>()

export function setPendingSessionAgentSwitch(sessionID: string, agent: string): PendingAgentSwitch {
  const pendingSwitch: PendingAgentSwitch = {
    agent,
    requestedAt: new Date(),
  }
  pendingAgentSwitchBySession.set(sessionID, pendingSwitch)
  return pendingSwitch
}

export function getPendingSessionAgentSwitch(sessionID: string): PendingAgentSwitch | undefined {
  return pendingAgentSwitchBySession.get(sessionID)
}

export function consumePendingSessionAgentSwitch(sessionID: string): PendingAgentSwitch | undefined {
  const pendingSwitch = pendingAgentSwitchBySession.get(sessionID)
  if (!pendingSwitch) {
    return undefined
  }

  pendingAgentSwitchBySession.delete(sessionID)
  return pendingSwitch
}

export function clearPendingSessionAgentSwitch(sessionID: string): void {
  pendingAgentSwitchBySession.delete(sessionID)
}

export function resetPendingSessionAgentSwitchesForTesting(): void {
  pendingAgentSwitchBySession.clear()
}
