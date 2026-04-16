import type { FallbackEntry } from "../../shared/model-requirements"
import type { DelegatedModelConfig } from "./types"
import {
  clearPendingModelFallback,
  getNextFallback,
  setPendingModelFallback,
} from "../../hooks/model-fallback/hook"

function toDelegatedModelConfig(fallback: NonNullable<ReturnType<typeof getNextFallback>>): DelegatedModelConfig {
  return {
    providerID: fallback.providerID,
    modelID: fallback.modelID,
    variant: fallback.variant,
  }
}

export async function retrySyncPromptWithFallbacks(input: {
  sessionID: string
  agentToUse: string
  initialError: string
  categoryModel: DelegatedModelConfig | undefined
  fallbackChain: FallbackEntry[] | undefined
  sendPrompt: (categoryModel: DelegatedModelConfig) => Promise<string | null>
}): Promise<{ promptError: string | null; categoryModel: DelegatedModelConfig | undefined }> {
  const { sessionID, agentToUse, initialError, categoryModel, fallbackChain, sendPrompt } = input

  if (!categoryModel || !fallbackChain || fallbackChain.length === 0) {
    return {
      promptError: initialError,
      categoryModel,
    }
  }

  const armed = setPendingModelFallback(
    sessionID,
    agentToUse,
    categoryModel.providerID,
    categoryModel.modelID,
  )
  if (!armed) {
    return {
      promptError: initialError,
      categoryModel,
    }
  }

  let finalError = initialError

  try {
    while (true) {
      const nextFallback = getNextFallback(sessionID)
      if (!nextFallback) {
        return {
          promptError: finalError,
          categoryModel,
        }
      }

      const fallbackModel = toDelegatedModelConfig(nextFallback)
      const promptError = await sendPrompt(fallbackModel)
      if (!promptError) {
        clearPendingModelFallback(sessionID)
        return {
          promptError: null,
          categoryModel: fallbackModel,
        }
      }

      finalError = promptError
      const rearmed = setPendingModelFallback(
        sessionID,
        agentToUse,
        fallbackModel.providerID,
        fallbackModel.modelID,
      )
      if (!rearmed) {
        return {
          promptError: finalError,
          categoryModel: fallbackModel,
        }
      }
    }
  } finally {
    clearPendingModelFallback(sessionID)
  }
}
