import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const CLEANUP_KEY = "__opencodeTlsCertificateRetryCleanup"

const RETRY_DELAY_MS = 60_000
const MODEL_RECOVERY_CHECK_MS = 10 * 60_000
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 10 * 60_000

const RETRYABLE_CONNECTIVITY_ERROR_PATTERNS = [
  /unknown certificate verification error/i,
  /certificate verification/i,
  /unable to verify the first certificate/i,
  /unable to get local issuer certificate/i,
  /unable to verify leaf signature/i,
  /unable_to_verify_leaf_signature/i,
  /self[-_ ]signed certificate/i,
  /self_signed_cert_in_chain/i,
  /cert_has_expired/i,
  /err_tls_cert_altname_invalid/i,
  /unable to connect/i,
  /network error/i,
  /socket hang up/i,
  /econnreset/i,
  /econnrefused/i,
  /timed out/i,
  /timeout/i,
]

const RATE_LIMIT_PATTERNS = [
  /rate limit/i,
  /too many requests/i,
  /exceed your account's rate limit/i,
  /extra\s+usage\s+is\s+required\s+for\s+long\s+context\s+requests/i,
  /token limit/i,
  /token quota/i,
  /quota exceeded/i,
  /insufficient quota/i,
  /billing limit/i,
]

const HARD_PROVIDER_BLOCK_PATTERNS = [
  /blocked by a gateway or proxy/i,
  /check your account and provider settings/i,
  /may not have permission to access this resource/i,
]

const KNOWN_VARIANTS = new Set(["low", "medium", "high", "xhigh", "max", "minimal", "none", "auto", "thinking"])

function clone(value) {
  if (value === undefined) {
    return undefined
  }

  return JSON.parse(JSON.stringify(value))
}

function createRetrySessionState() {
  return {
    state: "idle",
    attempt: 0,
    nextRetryAt: undefined,
    errorMessage: undefined,
    hardProviderBlock: false,
    currentModel: undefined,
    preferredModel: undefined,
    lastFallbackReason: undefined,
    fallbackCycleCount: 0,
    cycleVisitedModels: [],
  }
}

function extractErrorMessage(error) {
  if (!error) {
    return ""
  }

  if (typeof error === "string") {
    return error
  }

  if (typeof error?.data?.message === "string") {
    return error.data.message
  }

  if (typeof error?.message === "string") {
    return error.message
  }

  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function extractStatusCode(error) {
  if (!error || typeof error !== "object") {
    return undefined
  }

  return error.statusCode ?? error.status ?? error.data?.statusCode ?? error.error?.statusCode
}

function isRetryableConnectivityError(message) {
  return RETRYABLE_CONNECTIVITY_ERROR_PATTERNS.some((pattern) => pattern.test(message))
}

function isHardProviderBlock(error) {
  const message = extractErrorMessage(error)
  const statusCode = extractStatusCode(error)

  return statusCode === 403 && HARD_PROVIDER_BLOCK_PATTERNS.some((pattern) => pattern.test(message))
}

function isRateLimitError(errorOrMessage) {
  const message = extractErrorMessage(errorOrMessage)
  const statusCode = extractStatusCode(errorOrMessage)

  return statusCode === 429
    || statusCode === 529
    || RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(message))
}

function parseVariantFromModelID(rawModelID) {
  const trimmedModelID = rawModelID.trim()
  if (!trimmedModelID) {
    return { modelID: "" }
  }

  const parenthesizedVariant = trimmedModelID.match(/^(.*)\(([^()]+)\)\s*$/)
  if (parenthesizedVariant) {
    const modelID = parenthesizedVariant[1]?.trim() ?? ""
    const variant = parenthesizedVariant[2]?.trim()
    return variant ? { modelID, variant } : { modelID }
  }

  const spaceVariant = trimmedModelID.match(/^(.*\S)\s+([a-z][a-z0-9_-]*)$/i)
  if (spaceVariant) {
    const modelID = spaceVariant[1]?.trim() ?? ""
    const variant = spaceVariant[2]?.trim().toLowerCase()

    if (variant && KNOWN_VARIANTS.has(variant)) {
      return { modelID, variant }
    }
  }

  return { modelID: trimmedModelID }
}

function parseModelString(model) {
  if (typeof model !== "string") {
    return undefined
  }

  const trimmedModel = model.trim()
  if (!trimmedModel) {
    return undefined
  }

  const parts = trimmedModel.split("/")
  if (parts.length < 2) {
    return undefined
  }

  const providerID = parts[0]?.trim()
  const rawModelID = parts.slice(1).join("/").trim()
  if (!providerID || !rawModelID) {
    return undefined
  }

  const parsedModel = parseVariantFromModelID(rawModelID)
  if (!parsedModel.modelID) {
    return undefined
  }

  return parsedModel.variant
    ? { providerID, modelID: parsedModel.modelID, variant: parsedModel.variant }
    : { providerID, modelID: parsedModel.modelID }
}

function normalizeModelRef(model) {
  if (!model) {
    return undefined
  }

  if (typeof model === "string") {
    return model
  }

  if (typeof model?.providerID === "string" && typeof model?.modelID === "string") {
    return `${model.providerID}/${model.modelID}`
  }

  return undefined
}

function buildRetryModelPayload(model) {
  const parsedModel = parseModelString(model)
  if (!parsedModel) {
    return {}
  }

  return parsedModel.variant
    ? {
        model: {
          providerID: parsedModel.providerID,
          modelID: parsedModel.modelID,
        },
        variant: parsedModel.variant,
      }
    : {
        model: {
          providerID: parsedModel.providerID,
          modelID: parsedModel.modelID,
        },
      }
}

function normalizeNextTimestamp(next, fallbackMs, now) {
  if (typeof next !== "number" || Number.isNaN(next)) {
    return now() + fallbackMs
  }

  if (next > 1e11) {
    return next
  }

  if (next > 1000) {
    return now() + next
  }

  return now() + next * 1000
}

function normalizePositiveInteger(value, fallback) {
  if (!Number.isFinite(value)) {
    return fallback
  }

  return Math.max(1, Math.floor(value))
}

function getConfigDir() {
  return process.env.OPENCODE_CONFIG_DIR || join(homedir(), ".config", "opencode")
}

function defaultConfigLoader() {
  const configDir = getConfigDir()
  const candidates = [
    join(configDir, "oh-my-opencode.json"),
    join(configDir, "oh-my-openagent.json"),
  ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, "utf-8"))
    }
  }

  return {}
}

function resolveRuntimeFallbackConfig(pluginConfig) {
  const raw = pluginConfig?.runtime_fallback
  if (raw === false) {
    return {
      enabled: false,
      max_fallback_attempts: 0,
      max_full_chain_cycles: 0,
      cooldown_seconds: 600,
    }
  }

  if (raw === true || raw === undefined) {
    return {
      enabled: true,
      max_fallback_attempts: 5,
      max_full_chain_cycles: 5,
      cooldown_seconds: 600,
    }
  }

  const maxAttempts = normalizePositiveInteger(raw.max_fallback_attempts, 5)
  const maxCycles = normalizePositiveInteger(raw.max_full_chain_cycles ?? raw.max_fallback_attempts, 5)

  return {
    enabled: raw.enabled ?? true,
    max_fallback_attempts: maxAttempts,
    max_full_chain_cycles: maxCycles,
    cooldown_seconds: Math.max(600, raw.cooldown_seconds ?? 600),
  }
}

function normalizeFallbackEntry(entry) {
  if (typeof entry === "string") {
    return entry
  }

  if (entry && typeof entry === "object" && typeof entry.model === "string") {
    return entry.model
  }

  return undefined
}

function dedupeModels(models) {
  const seen = new Set()
  const result = []

  for (const model of models) {
    if (!model || seen.has(model)) {
      continue
    }

    seen.add(model)
    result.push(model)
  }

  return result
}

function resolveAgentKey(agentName, pluginConfig) {
  const normalized = String(agentName ?? "").trim().toLowerCase()
  if (!normalized) {
    return undefined
  }

  const knownAgentKeys = Object.keys(pluginConfig?.agents ?? {})
  if (knownAgentKeys.includes(normalized)) {
    return normalized
  }

  for (const key of knownAgentKeys) {
    if (normalized.includes(key)) {
      return key
    }
  }

  const aliases = {
    "prometheus (plan builder)": "prometheus",
    "atlas (plan executor)": "atlas",
    "sisyphus (ultraworker)": "sisyphus",
    "sisyphus-junior": "sisyphus-junior",
  }

  for (const [alias, key] of Object.entries(aliases)) {
    if (normalized.includes(alias)) {
      return key
    }
  }

  return undefined
}

function getFallbackChainForAgent(agentName, pluginConfig) {
  const agentKey = resolveAgentKey(agentName, pluginConfig)
  const agentConfig = agentKey ? pluginConfig?.agents?.[agentKey] : undefined
  const globalFallback = Array.isArray(pluginConfig?.fallback_models)
    ? pluginConfig.fallback_models.map(normalizeFallbackEntry).filter(Boolean)
    : []

  if (!agentConfig) {
    return dedupeModels(globalFallback)
  }

  const fallbackModels = Array.isArray(agentConfig.fallback_models)
    ? agentConfig.fallback_models.map(normalizeFallbackEntry).filter(Boolean)
    : []

  return dedupeModels([
    typeof agentConfig.model === "string" ? agentConfig.model : undefined,
    ...fallbackModels,
    ...globalFallback,
  ])
}

function toPromptPart(part) {
  if (!part || typeof part !== "object") {
    return null
  }

  if (part.type === "text" && typeof part.text === "string") {
    const nextPart = { type: "text", text: part.text }

    if (part.synthetic) {
      nextPart.synthetic = true
    }

    if (part.ignored) {
      nextPart.ignored = true
    }

    return nextPart
  }

  if (part.type === "file" && typeof part.mime === "string" && typeof part.url === "string") {
    const nextPart = {
      type: "file",
      mime: part.mime,
      url: part.url,
    }

    if (typeof part.filename === "string") {
      nextPart.filename = part.filename
    }

    if (part.source) {
      nextPart.source = clone(part.source)
    }

    return nextPart
  }

  if (part.type === "agent" && typeof part.name === "string") {
    const nextPart = { type: "agent", name: part.name }

    if (part.source) {
      nextPart.source = clone(part.source)
    }

    return nextPart
  }

  if (
    part.type === "subtask"
    && typeof part.prompt === "string"
    && typeof part.description === "string"
    && typeof part.agent === "string"
  ) {
    return {
      type: "subtask",
      prompt: part.prompt,
      description: part.description,
      agent: part.agent,
    }
  }

  return null
}

function buildRetryBody(payload) {
  const body = {
    parts: clone(payload.parts) ?? [],
  }

  if (payload.agent) {
    body.agent = payload.agent
  }

  if (payload.model) {
    body.model = clone(payload.model)
  }

  if (payload.variant) {
    body.variant = payload.variant
  }

  if (payload.system) {
    body.system = payload.system
  }

  if (payload.tools) {
    body.tools = clone(payload.tools)
  }

  return body
}

async function safeToast(client, body) {
  await client?.tui?.showToast?.({ body }).catch(() => {})
}

async function safeLog(client, level, message, extra = {}) {
  await client?.app?.log?.({
    body: {
      service: "tls-certificate-retry",
      level,
      message,
      extra,
    },
  }).catch(() => {})
}

async function readLastUserPayload(client, directory, sessionID) {
  const response = await client.session.messages({
    path: { id: sessionID },
    query: { directory },
  })

  const messages = Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : []
  const lastUserMessage = [...messages].reverse().find((message) => message?.info?.role === "user")

  if (!lastUserMessage) {
    return undefined
  }

  const parts = (lastUserMessage.parts ?? []).map(toPromptPart).filter(Boolean)

  if (parts.length === 0) {
    return undefined
  }

  return {
    agent: lastUserMessage.info.agent,
    model: clone(lastUserMessage.info.model),
    variant: lastUserMessage.info.variant,
    system: lastUserMessage.info.system,
    tools: clone(lastUserMessage.info.tools),
    parts,
  }
}

function createTlsCertificateRetryRuntime({
  client,
  directory,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  onStateChange,
  configLoader = defaultConfigLoader,
} = {}) {
  const lastPayloadBySession = new Map()
  const retryTimerBySession = new Map()
  const retryAttemptBySession = new Map()
  const retryDispatchInFlight = new Set()
  const hardBlockedSessions = new Set()
  const retryStateBySession = new Map()
  const blockedModels = new Map()

  const getRetryState = (sessionID) => {
    let state = retryStateBySession.get(sessionID)

    if (!state) {
      state = createRetrySessionState()
      retryStateBySession.set(sessionID, state)
    }

    return state
  }

  const getSessionRetryState = (sessionID) => {
    const state = getRetryState(sessionID)

    return {
      state: state.state,
      attempt: state.attempt,
      nextRetryAt: state.nextRetryAt,
      errorMessage: state.errorMessage,
      hardProviderBlock: state.hardProviderBlock,
      scheduled: retryTimerBySession.has(sessionID),
      dispatchInFlight: retryDispatchInFlight.has(sessionID),
      payloadCached: lastPayloadBySession.has(sessionID),
      currentModel: state.currentModel,
      preferredModel: state.preferredModel,
      fallbackCycleCount: state.fallbackCycleCount,
      cycleVisitedModels: [...(state.cycleVisitedModels ?? [])],
      blockedModels: Array.from(blockedModels.entries()).map(([model, until]) => ({ model, until })),
    }
  }

  const safeStateChange = async (sessionID, signal) => {
    if (typeof onStateChange !== "function") {
      return
    }

    try {
      await onStateChange(sessionID, signal)
    } catch (error) {
      await safeLog(client, "warn", "Retry state bridge rejected an update", {
        sessionID,
        signal,
        error: extractErrorMessage(error),
      })
    }
  }

  const clearRetryTimer = (sessionID) => {
    const timer = retryTimerBySession.get(sessionID)

    if (timer) {
      clearTimeoutFn(timer)
      retryTimerBySession.delete(sessionID)
    }
  }

  const cleanupExpiredBlocks = () => {
    const released = []

    for (const [model, until] of blockedModels.entries()) {
      if (until <= now()) {
        blockedModels.delete(model)
        released.push(model)
      }
    }

    if (released.length > 0) {
      safeLog(client, "info", "Released models from temporary cooldown after periodic recovery check", {
        models: released,
      })
    }
  }

  const resetRetryState = (sessionID) => {
    const state = getRetryState(sessionID)
    state.state = "idle"
    state.attempt = 0
    state.nextRetryAt = undefined
    state.errorMessage = undefined
    state.hardProviderBlock = false
    state.lastFallbackReason = undefined
    resetFallbackCycleState(state)
  }

  const clearSessionState = (sessionID) => {
    clearRetryTimer(sessionID)
    retryAttemptBySession.delete(sessionID)
    retryDispatchInFlight.delete(sessionID)
    hardBlockedSessions.delete(sessionID)
    lastPayloadBySession.delete(sessionID)
    retryStateBySession.delete(sessionID)
  }

  const setRetryingState = async (sessionID, attempt, errorMessage, nextRetryAt, currentModel) => {
    const state = getRetryState(sessionID)
    state.state = "retrying"
    state.attempt = attempt
    state.nextRetryAt = nextRetryAt
    state.errorMessage = errorMessage
    state.hardProviderBlock = false
    if (currentModel) {
      state.currentModel = currentModel
    }

    await safeStateChange(sessionID, {
      state: "retrying",
      attempt,
      message: errorMessage,
      next: nextRetryAt,
    })
  }

  const setFailedState = async (sessionID, error, hardProviderBlock) => {
    const state = getRetryState(sessionID)
    state.state = "failed"
    state.nextRetryAt = undefined
    state.errorMessage = extractErrorMessage(error) || "Unknown session error"
    state.hardProviderBlock = Boolean(hardProviderBlock)

    await safeStateChange(sessionID, {
      state: "failed",
      error,
      hardProviderBlock: state.hardProviderBlock,
    })
  }

  const getRetryPayload = async (sessionID) => {
    const cachedPayload = lastPayloadBySession.get(sessionID)

    if (cachedPayload) {
      return clone(cachedPayload)
    }

    const resolvedPayload = await readLastUserPayload(client, directory, sessionID)

    if (resolvedPayload) {
      lastPayloadBySession.set(sessionID, clone(resolvedPayload))
    }

    return resolvedPayload
  }

  const getManagedConfig = () => {
    try {
      return configLoader() ?? {}
    } catch (error) {
      safeLog(client, "warn", "Failed to load managed plugin config for fallback resolution", {
        error: extractErrorMessage(error),
      })
      return {}
    }
  }

  const blockModelUntil = (model, next, fallbackConfig, reason) => {
    if (!model) {
      return undefined
    }

    const cooldownMs = Math.max(
      DEFAULT_RATE_LIMIT_COOLDOWN_MS,
      (fallbackConfig.cooldown_seconds ?? 600) * 1000,
    )
    const blockedUntil = normalizeNextTimestamp(next, cooldownMs, now)
    blockedModels.set(model, blockedUntil)

    safeLog(client, "warn", "Blocked model after retryable provider failure", {
      model,
      blockedUntil,
      reason,
    })

    return blockedUntil
  }

  const isModelBlocked = (model) => {
    if (!model) {
      return false
    }

    cleanupExpiredBlocks()
    const until = blockedModels.get(model)
    return typeof until === "number" && until > now()
  }

  const getSoonestRecovery = (chain, excludeModel) => {
    let soonest = undefined

    for (const model of chain) {
      if (!model || model === excludeModel) {
        continue
      }

      const until = blockedModels.get(model)
      if (typeof until !== "number") {
        continue
      }

      soonest = soonest === undefined ? until : Math.min(soonest, until)
    }

    return soonest
  }

  const chooseBestAvailableModel = (chain, currentModel, attemptedModels = new Set()) => {
    cleanupExpiredBlocks()

    const currentIndex = chain.indexOf(currentModel)

    for (let offset = 1; offset <= chain.length; offset += 1) {
      const index = currentIndex >= 0
        ? (currentIndex + offset) % chain.length
        : offset - 1
      const model = chain[index]

      if (!model || model === currentModel || attemptedModels.has(model)) {
        continue
      }

      if (!isModelBlocked(model)) {
        return model
      }
    }

    return undefined
  }

  const prioritizeFallbackChainForExternalModel = (chain, currentModel) => {
    if (!currentModel || chain.length < 2) {
      return chain
    }

    const preferredModel = chain[0]
    if (!preferredModel || currentModel === preferredModel) {
      return chain
    }

    return chain.slice(1)
  }

  const resetFallbackCycleState = (state) => {
    state.fallbackCycleCount = 0
    state.cycleVisitedModels = []
  }

  const recordFailedFallbackAttempt = (state, failedModel, chain) => {
    if (!failedModel || chain.length === 0) {
      return {
        cycleCompleted: false,
        cycleCount: state.fallbackCycleCount,
      }
    }

    const visited = new Set(Array.isArray(state.cycleVisitedModels) ? state.cycleVisitedModels : [])
    visited.add(failedModel)

    const uniqueChain = dedupeModels(chain)
    const orderedVisited = uniqueChain.filter((model) => visited.has(model))
    const completedCycle = orderedVisited.length >= uniqueChain.length

    if (completedCycle) {
      state.fallbackCycleCount += 1
      state.cycleVisitedModels = []
    } else {
      state.cycleVisitedModels = orderedVisited
    }

    return {
      cycleCompleted: completedCycle,
      cycleCount: state.fallbackCycleCount,
    }
  }

  const scheduleRecoveryRetry = async (sessionID, errorMessage, nextRetryAt) => {
    if (!sessionID || hardBlockedSessions.has(sessionID)) {
      return false
    }

    if (retryTimerBySession.has(sessionID)) {
      return false
    }

    const delayMs = Math.max(1_000, nextRetryAt - now())
    const nextAttempt = (retryAttemptBySession.get(sessionID) ?? 0) + 1
    const timer = setTimeoutFn(() => dispatchBestFallback(sessionID, errorMessage, nextRetryAt), delayMs)

    retryTimerBySession.set(sessionID, timer)
    await setRetryingState(sessionID, nextAttempt, errorMessage, nextRetryAt)

    await safeToast(client, {
      title: "Fallback Recovery Scheduled",
      message: `All fallback models are cooling down. Retrying when one becomes available again.`,
      variant: "warning",
      duration: 7000,
    })

    await safeLog(client, "warn", "Scheduled retry while waiting for a blocked model to recover", {
      sessionID,
      nextAttempt,
      nextRetryAt,
      delayMs,
      error: errorMessage,
    })

    return true
  }

  const scheduleConnectivityRetry = async (sessionID, errorMessage) => {
    if (!sessionID || hardBlockedSessions.has(sessionID)) {
      return false
    }

    if (retryTimerBySession.has(sessionID) || retryDispatchInFlight.has(sessionID)) {
      return false
    }

    const nextAttempt = (retryAttemptBySession.get(sessionID) ?? 0) + 1
    const nextRetryAt = now() + RETRY_DELAY_MS
    const timer = setTimeoutFn(() => dispatchConnectivityRetry(sessionID), RETRY_DELAY_MS)

    retryTimerBySession.set(sessionID, timer)
    await setRetryingState(sessionID, nextAttempt, errorMessage, nextRetryAt)

    await safeToast(client, {
      title: "Connection Retry Scheduled",
      message: `Connection failed. Retrying in 60 seconds (attempt ${nextAttempt}).`,
      variant: "warning",
      duration: 7000,
    })

    await safeLog(client, "warn", "Scheduled automatic retry after connectivity failure", {
      sessionID,
      nextAttempt,
      delayMs: RETRY_DELAY_MS,
      error: errorMessage,
    })

    return true
  }

  const dispatchConnectivityRetry = async (sessionID) => {
    if (hardBlockedSessions.has(sessionID)) {
      clearRetryTimer(sessionID)
      return
    }

    clearRetryTimer(sessionID)

    if (retryDispatchInFlight.has(sessionID)) {
      return
    }

    retryDispatchInFlight.add(sessionID)
    let retryableDispatchErrorMessage

    try {
      const payload = await getRetryPayload(sessionID)

      if (!payload) {
        await safeLog(client, "warn", "Retry skipped because no user payload could be reconstructed", {
          sessionID,
        })
        return
      }

      const attempt = (retryAttemptBySession.get(sessionID) ?? 0) + 1
      retryAttemptBySession.set(sessionID, attempt)

      await safeToast(client, {
        title: "Connection Retry",
        message: `Connection failed. Retrying now (attempt ${attempt}).`,
        variant: "warning",
        duration: 5000,
      })

      await safeLog(client, "warn", "Dispatching automatic retry after connectivity failure", {
        sessionID,
        attempt,
        delayMs: RETRY_DELAY_MS,
      })

      await client.session.promptAsync({
        path: { id: sessionID },
        body: buildRetryBody(payload),
        query: { directory },
      })

      const state = getRetryState(sessionID)
      state.state = "running"
      state.nextRetryAt = undefined
      state.errorMessage = undefined
      resetFallbackCycleState(state)
    } catch (error) {
      const errorMessage = extractErrorMessage(error)

      await safeLog(client, "error", "Automatic connectivity retry dispatch failed", {
        sessionID,
        error: errorMessage,
      })

      if (isHardProviderBlock(error)) {
        await dispatchBestFallback(sessionID, error)
        return
      }

      if (isRetryableConnectivityError(errorMessage)) {
        retryableDispatchErrorMessage = errorMessage
        return
      }

      if (isRateLimitError(error)) {
        await dispatchBestFallback(sessionID, error)
      }
    } finally {
      retryDispatchInFlight.delete(sessionID)
    }

    if (retryableDispatchErrorMessage) {
      await scheduleConnectivityRetry(sessionID, retryableDispatchErrorMessage)
    }
  }

  const applySelectedModelToPayload = (payload, selectedModel) => {
    const retryModelPayload = buildRetryModelPayload(selectedModel)
    payload.model = retryModelPayload.model
    payload.variant = retryModelPayload.variant ?? payload.variant
  }

  const dispatchBestFallback = async (sessionID, errorContext, nextHint) => {
    if (!sessionID || hardBlockedSessions.has(sessionID)) {
      return false
    }

    if (retryDispatchInFlight.has(sessionID)) {
      return false
    }

    clearRetryTimer(sessionID)
    retryDispatchInFlight.add(sessionID)

    try {
      const payload = await getRetryPayload(sessionID)
      if (!payload) {
        await safeLog(client, "warn", "Fallback skipped because no user payload could be reconstructed", {
          sessionID,
        })
        return false
      }

      const pluginConfig = getManagedConfig()
      const fallbackConfig = resolveRuntimeFallbackConfig(pluginConfig)
      if (!fallbackConfig.enabled) {
        return false
      }

      const chain = getFallbackChainForAgent(payload.agent, pluginConfig)
      if (chain.length === 0) {
        await safeLog(client, "warn", "Fallback skipped because no fallback chain was resolved for agent", {
          sessionID,
          agent: payload.agent,
        })
        return false
      }

      const state = getRetryState(sessionID)
      state.preferredModel = state.preferredModel ?? chain[0]
      state.currentModel = state.currentModel ?? normalizeModelRef(payload.model) ?? chain[0]
      const fallbackReason = extractErrorMessage(errorContext)
      state.lastFallbackReason = fallbackReason

      const prioritizedChain = prioritizeFallbackChainForExternalModel(chain, state.currentModel)
      const activeChain = prioritizedChain.length > 0 ? prioritizedChain : chain
      const cycleLimit = Math.max(1, fallbackConfig.max_full_chain_cycles ?? fallbackConfig.max_fallback_attempts ?? 5)

      const failDueToCycleExhaustion = async () => {
        const message = `Fallback exhausted after ${state.fallbackCycleCount} full cycle(s) without a successful dispatch.`
        await setFailedState(sessionID, { message }, false)

        await safeToast(client, {
          title: "Fallback Exhausted",
          message,
          variant: "error",
          duration: 9000,
        })

        await safeLog(client, "error", "Fallback cycle limit reached; stopping automatic retries", {
          sessionID,
          cycleLimit,
          cycleCount: state.fallbackCycleCount,
          chain: activeChain,
          lastError: state.lastFallbackReason ?? fallbackReason,
        })
      }

      const trackFailedModel = async (failedModel, reason) => {
        const cycleStatus = recordFailedFallbackAttempt(state, failedModel, activeChain)
        if (!cycleStatus.cycleCompleted) {
          return false
        }

        await safeLog(client, "warn", "Completed a full fallback cycle without success", {
          sessionID,
          cycleCount: cycleStatus.cycleCount,
          cycleLimit,
          failedModel,
          reason,
        })

        if (cycleStatus.cycleCount >= cycleLimit) {
          await failDueToCycleExhaustion()
          return true
        }

        return false
      }

      if (isRateLimitError(errorContext) || isHardProviderBlock(errorContext)) {
        blockModelUntil(state.currentModel, nextHint, fallbackConfig, fallbackReason)
        const cyclesExhausted = await trackFailedModel(state.currentModel, fallbackReason)
        if (cyclesExhausted) {
          return false
        }
      }

      if (state.fallbackCycleCount >= cycleLimit) {
        await failDueToCycleExhaustion()
        return false
      }

      const attemptedModels = new Set()
      let selectedModel = chooseBestAvailableModel(activeChain, state.currentModel, attemptedModels)

      while (selectedModel) {
        attemptedModels.add(selectedModel)
        const previousModel = state.currentModel
        const attempt = (retryAttemptBySession.get(sessionID) ?? 0) + 1
        retryAttemptBySession.set(sessionID, attempt)
        state.currentModel = selectedModel

        const nextRetryAt = nextHint ?? now() + 1_000
        await setRetryingState(sessionID, attempt, fallbackReason, nextRetryAt, selectedModel)

        const retryPayload = clone(payload)
        applySelectedModelToPayload(retryPayload, selectedModel)
        lastPayloadBySession.set(sessionID, clone(retryPayload))

        await safeToast(client, {
          title: "Fallback Model Retry",
          message: `${previousModel || "Current model"} failed. Retrying with ${selectedModel}.`,
          variant: "warning",
          duration: 7000,
        })

        await safeLog(client, "warn", "Dispatching retry with a fallback model", {
          sessionID,
          previousModel,
          selectedModel,
          attempt,
          error: fallbackReason,
        })

        try {
          await client.session.promptAsync({
            path: { id: sessionID },
            body: buildRetryBody(retryPayload),
            query: { directory },
          })

          state.state = "running"
          state.nextRetryAt = undefined
          state.errorMessage = undefined
          state.lastFallbackReason = undefined
          resetFallbackCycleState(state)

          return true
        } catch (error) {
          const dispatchErrorMessage = extractErrorMessage(error)

          await safeLog(client, "error", "Fallback dispatch failed", {
            sessionID,
            selectedModel,
            error: dispatchErrorMessage,
          })

          if (isHardProviderBlock(error)) {
            blockModelUntil(selectedModel, nextHint, fallbackConfig, dispatchErrorMessage)
            const cyclesExhausted = await trackFailedModel(selectedModel, dispatchErrorMessage)
            if (cyclesExhausted) {
              return false
            }

            await safeToast(client, {
              title: "Provider Blocked, Switching Model",
              message: `${selectedModel} returned a provider/account block. Trying the next fallback model.`,
              variant: "warning",
              duration: 8000,
            })

            selectedModel = chooseBestAvailableModel(activeChain, selectedModel, attemptedModels)
            continue
          }

          if (isRateLimitError(error)) {
            blockModelUntil(selectedModel, nextHint, fallbackConfig, dispatchErrorMessage)
            const cyclesExhausted = await trackFailedModel(selectedModel, dispatchErrorMessage)
            if (cyclesExhausted) {
              return false
            }

            selectedModel = chooseBestAvailableModel(activeChain, selectedModel, attemptedModels)
            continue
          }

          if (isRetryableConnectivityError(dispatchErrorMessage)) {
            const cyclesExhausted = await trackFailedModel(selectedModel, dispatchErrorMessage)
            if (cyclesExhausted) {
              return false
            }

            await scheduleConnectivityRetry(sessionID, dispatchErrorMessage)
            return false
          }

          const cyclesExhausted = await trackFailedModel(selectedModel, dispatchErrorMessage)
          if (cyclesExhausted) {
            return false
          }

          await setFailedState(sessionID, error, false)
          return false
        }
      }

      if (state.fallbackCycleCount >= cycleLimit) {
        await failDueToCycleExhaustion()
        return false
      }

      const nextRecoveryAt = getSoonestRecovery(activeChain, state.currentModel)
      if (nextRecoveryAt) {
        await scheduleRecoveryRetry(sessionID, fallbackReason, nextRecoveryAt)
        return false
      }

      await setFailedState(sessionID, {
        message: `No available fallback models remain for ${payload.agent || "session"}.`,
      }, false)
      return false
    } finally {
      retryDispatchInFlight.delete(sessionID)
    }
  }

  const recoveryInterval = setIntervalFn(() => {
    cleanupExpiredBlocks()
  }, MODEL_RECOVERY_CHECK_MS)

  return {
    hooks: {
      "chat.message": async (input, output) => {
        const sessionID = input.sessionID

        if (!sessionID || output.message?.role !== "user") {
          return
        }

        hardBlockedSessions.delete(sessionID)
        resetRetryState(sessionID)

        const pluginConfig = getManagedConfig()
        const chain = getFallbackChainForAgent(input.agent ?? output.message.agent, pluginConfig)
        const explicitModel = input.model
        const resolvedModel = normalizeModelRef(explicitModel ?? output.message.model)

        if (!explicitModel && chain.length > 0) {
          const preferredAvailableModel = chooseBestAvailableModel(chain, undefined) ?? chain[0]
          if (preferredAvailableModel && preferredAvailableModel !== resolvedModel) {
            const retryModelPayload = buildRetryModelPayload(preferredAvailableModel)
            if (retryModelPayload.model) {
              output.message.model = retryModelPayload.model
            }
          }
        }

        const payload = {
          agent: input.agent ?? output.message.agent,
          model: clone(output.message.model ?? explicitModel),
          variant: input.variant,
          system: output.message.system,
          tools: clone(output.message.tools),
          parts: (output.parts ?? []).map(toPromptPart).filter(Boolean),
        }

        if (payload.parts.length > 0) {
          lastPayloadBySession.set(sessionID, clone(payload))
        }

        const state = getRetryState(sessionID)
        state.currentModel = normalizeModelRef(payload.model) ?? state.currentModel ?? chain[0]
        state.preferredModel = chain[0] ?? state.preferredModel

        if (retryDispatchInFlight.has(sessionID)) {
          return
        }

        if (retryTimerBySession.has(sessionID)) {
          clearRetryTimer(sessionID)
          retryAttemptBySession.delete(sessionID)

          await safeLog(client, "info", "Cancelled scheduled retry because a new user message was sent", {
            sessionID,
          })
        }
      },

      event: async ({ event }) => {
        if (event.type === "session.deleted") {
          const sessionID = event.properties?.info?.id

          if (sessionID) {
            clearSessionState(sessionID)
          }

          return
        }

        if (event.type === "session.status") {
          const sessionID = event.properties?.sessionID
          const status = event.properties?.status

          if (!sessionID || !status || hardBlockedSessions.has(sessionID)) {
            return
          }

          if (status.type === "retry" && isRateLimitError(status.message)) {
            await dispatchBestFallback(sessionID, status.message, status.next)
          }

          return
        }

        if (event.type === "session.idle") {
          const sessionID = event.properties?.sessionID

          if (!sessionID) {
            return
          }

          if (!retryTimerBySession.has(sessionID) && !retryDispatchInFlight.has(sessionID)) {
            retryAttemptBySession.delete(sessionID)

            if (!hardBlockedSessions.has(sessionID)) {
              resetRetryState(sessionID)
            }
          }

          return
        }

        if (event.type !== "session.error") {
          return
        }

        const sessionID = event.properties?.sessionID
        const rawError = event.properties?.error
        const errorMessage = extractErrorMessage(rawError)

        if (!sessionID || hardBlockedSessions.has(sessionID)) {
          return
        }

        if (isHardProviderBlock(rawError)) {
          clearRetryTimer(sessionID)
          await safeLog(client, "warn", "Detected provider block; switching to fallback model", {
            sessionID,
            error: errorMessage,
            statusCode: extractStatusCode(rawError),
          })

          await dispatchBestFallback(sessionID, rawError)
          return
        }

        if (isRetryableConnectivityError(errorMessage)) {
          await scheduleConnectivityRetry(sessionID, errorMessage)
          return
        }

        if (isRateLimitError(rawError)) {
          await dispatchBestFallback(sessionID, rawError)
        }
      },
    },

    getSessionRetryState,

    getAllSessionRetryStates() {
      return Array.from(retryStateBySession.keys()).map((sessionID) => ({
        sessionID,
        state: getSessionRetryState(sessionID),
      }))
    },

    getBlockedModels() {
      cleanupExpiredBlocks()
      return Array.from(blockedModels.entries()).map(([model, until]) => ({ model, until }))
    },

    dispose() {
      clearIntervalFn(recoveryInterval)
      for (const sessionID of retryTimerBySession.keys()) {
        clearRetryTimer(sessionID)
      }
    },
  }
}

const TlsCertificateRetryPluginImpl = Object.assign(async ({ client, directory }) => {
  try {
    globalThis[CLEANUP_KEY]?.()
  } catch {}

  const runtime = createTlsCertificateRetryRuntime({ client, directory })
  globalThis[CLEANUP_KEY] = () => runtime.dispose()
  return runtime.hooks
}, {
  createRuntime: createTlsCertificateRetryRuntime,
  RETRY_DELAY_MS,
  MODEL_RECOVERY_CHECK_MS,
})

export const TlsCertificateRetryPlugin = TlsCertificateRetryPluginImpl
