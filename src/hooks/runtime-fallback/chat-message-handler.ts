import type { HookDeps } from "./types"
import { HOOK_NAME } from "./constants"
import { log } from "../../shared/logger"
import { createFallbackState, inheritCanonicalRetryParts, recoverPreferredModel } from "./fallback-state"
import { applyScopedFallbackSessionHint } from "./scoped-fallback-hints"
import { getFallbackModelsForSession } from "./fallback-models"
import { isModelGloballyCooling } from "./global-model-cooldown"
import { parseModelString } from "../../tools/delegate-task/model-string-parser"

function setOutputModel(
  output: { message: { model?: { providerID: string; modelID: string }; variant?: string } },
  model: string,
): void {
  const parsedModel = parseModelString(model)
  if (!parsedModel) {
    return
  }

  output.message.model = {
    providerID: parsedModel.providerID,
    modelID: parsedModel.modelID,
  }

  if (parsedModel.variant) {
    output.message.variant = parsedModel.variant
    return
  }

  delete output.message.variant
}

function getRequestedModel(
  input: { model?: { providerID: string; modelID: string } },
  output: { message: { model?: { providerID: string; modelID: string } } },
): string | undefined {
  if (input.model?.providerID && input.model?.modelID) {
    return `${input.model.providerID}/${input.model.modelID}`
  }

  if (output.message.model?.providerID && output.message.model?.modelID) {
    return `${output.message.model.providerID}/${output.message.model.modelID}`
  }

  return undefined
}

function selectHealthyBootstrapFallback(args: {
  requestedModel: string
  fallbackModels: string[]
  globalModelCooldowns: Map<string, number>
}): string | undefined {
  const chain = [args.requestedModel, ...args.fallbackModels]
  let passedRequestedModel = false

  for (const candidate of chain) {
    if (!candidate) {
      continue
    }

    if (!passedRequestedModel) {
      if (candidate === args.requestedModel) {
        passedRequestedModel = true
      }
      continue
    }

    if (isModelGloballyCooling(args.globalModelCooldowns, candidate)) {
      continue
    }

    return candidate
  }

  return undefined
}

export function createChatMessageHandler(deps: HookDeps) {
  const {
    config,
    globalModelCooldowns,
    pluginConfig,
    sessionLastAccess,
    sessionStates,
  } = deps

  return async (
    input: { sessionID: string; agent?: string; model?: { providerID: string; modelID: string } },
    output: { message: { model?: { providerID: string; modelID: string }; variant?: string }; parts?: Array<{ type: string; text?: string }> }
  ) => {
    if (!config.enabled) return

    const { sessionID } = input
    let state = sessionStates.get(sessionID)
    const requestedModel = getRequestedModel(input, output)

    if (!state) {
      if (!requestedModel || !isModelGloballyCooling(globalModelCooldowns, requestedModel)) {
        return
      }

      const fallbackModels = getFallbackModelsForSession(sessionID, input.agent, pluginConfig)
      const healthyFallbackModel = selectHealthyBootstrapFallback({
        requestedModel,
        fallbackModels,
        globalModelCooldowns,
      })
      if (!healthyFallbackModel) {
        log(`[${HOOK_NAME}] Requested model is globally cooling but no healthy bootstrap fallback was available`, {
          sessionID,
          requestedModel,
          agent: input.agent,
        })
        return
      }

      state = createFallbackState(requestedModel, fallbackModels)
      state.currentModel = healthyFallbackModel
      state.fallbackIndex = fallbackModels.findIndex((candidate) => candidate === healthyFallbackModel)
      state.resolvedAgent = input.agent
      sessionStates.set(sessionID, state)
      sessionLastAccess.set(sessionID, Date.now())
      applyScopedFallbackSessionHint(deps, sessionID, state)
      log(`[${HOOK_NAME}] Applying global unhealthy-model override before the first send`, {
        sessionID,
        agent: input.agent,
        from: requestedModel,
        to: healthyFallbackModel,
      })
      setOutputModel(output, healthyFallbackModel)
      return
    }

    sessionLastAccess.set(sessionID, Date.now())

    const recoveredModel = recoverPreferredModel(state, config.cooldown_seconds)
    if (recoveredModel) {
      log(`[${HOOK_NAME}] Recovered to a higher-priority model before sending the next message`, {
        sessionID,
        recoveredModel,
      })
    }

    if (requestedModel && requestedModel !== state.currentModel) {
      if (state.pendingFallbackModel && state.pendingFallbackModel === requestedModel) {
        state.pendingFallbackModel = undefined
        return
      }

      log(`[${HOOK_NAME}] Detected manual model change, resetting fallback state`, {
        sessionID,
        from: state.currentModel,
        to: requestedModel,
      })
      const nextState = createFallbackState(requestedModel)
      inheritCanonicalRetryParts(nextState, state)
      applyScopedFallbackSessionHint(deps, sessionID, nextState)
      sessionStates.set(sessionID, nextState)
      return
    }

    if (state.currentModel === state.originalModel) return

    const activeModel = state.currentModel

    log(`[${HOOK_NAME}] Applying fallback model override`, {
      sessionID,
      from: input.model,
      to: activeModel,
    })

    if (output.message && activeModel) {
      setOutputModel(output, activeModel)
    }
  }
}
