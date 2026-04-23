function getModelIdentity(model: string): string {
  return model.replace(/\([^)]*\)\s*$/, "").trim()
}

export function pruneExpiredGlobalModelCooldowns(
  cooldowns: Map<string, number>,
  now = Date.now(),
): void {
  for (const [modelIdentity, until] of cooldowns.entries()) {
    if (until <= now) {
      cooldowns.delete(modelIdentity)
    }
  }
}

export function getGlobalModelCooldownUntil(
  cooldowns: Map<string, number>,
  model: string,
  now = Date.now(),
): number | undefined {
  pruneExpiredGlobalModelCooldowns(cooldowns, now)
  const until = cooldowns.get(getModelIdentity(model))
  if (typeof until !== "number" || until <= now) {
    return undefined
  }
  return until
}

export function isModelGloballyCooling(
  cooldowns: Map<string, number>,
  model: string,
  now = Date.now(),
): boolean {
  return typeof getGlobalModelCooldownUntil(cooldowns, model, now) === "number"
}

export function markGlobalModelCooldown(
  cooldowns: Map<string, number>,
  model: string,
  cooldownMs: number,
  now = Date.now(),
): number | undefined {
  if (!(cooldownMs > 0)) {
    return undefined
  }

  const modelIdentity = getModelIdentity(model)
  const nextUntil = now + cooldownMs
  const existingUntil = cooldowns.get(modelIdentity) ?? 0
  const until = Math.max(existingUntil, nextUntil)
  cooldowns.set(modelIdentity, until)
  return until
}
