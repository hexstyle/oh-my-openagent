const store = new Map<string, Record<string, boolean>>();
const flagsStore = new Map<string, Set<string>>();

export function setSessionTools(sessionID: string, tools: Record<string, boolean>): void {
  store.set(sessionID, { ...tools });
}

export function getSessionTools(sessionID: string): Record<string, boolean> | undefined {
  const tools = store.get(sessionID);
  return tools ? { ...tools } : undefined;
}

export function setSessionFlag(sessionID: string, flag: string): void {
  const flags = flagsStore.get(sessionID) ?? new Set<string>();
  flags.add(flag);
  flagsStore.set(sessionID, flags);
}

export function hasSessionFlag(sessionID: string, flag: string): boolean {
  return flagsStore.get(sessionID)?.has(flag) ?? false;
}

export function clearSessionFlag(sessionID: string, flag: string): void {
  const flags = flagsStore.get(sessionID);
  if (!flags) return;
  flags.delete(flag);
  if (flags.size === 0) {
    flagsStore.delete(sessionID);
  }
}

export function isSessionToolDisabled(sessionID: string, toolName: string): boolean {
  const tools = store.get(sessionID);
  if (!tools) {
    return false;
  }

  const normalizedToolName = toolName.toLowerCase();
  return Object.entries(tools).some(([configuredName, enabled]) => {
    if (enabled !== false) {
      return false;
    }

    const normalizedConfiguredName = configuredName.toLowerCase();
    if (normalizedConfiguredName.endsWith("*")) {
      const prefix = normalizedConfiguredName.slice(0, -1);
      return normalizedToolName.startsWith(prefix);
    }

    return (
      normalizedConfiguredName === normalizedToolName
    );
  });
}

export function deleteSessionTools(sessionID: string): void {
  store.delete(sessionID);
  flagsStore.delete(sessionID);
}

export function clearSessionTools(): void {
  store.clear();
  flagsStore.clear();
}
