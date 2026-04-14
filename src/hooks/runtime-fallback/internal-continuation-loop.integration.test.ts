import { describe, expect, test } from "bun:test"
import { createRuntimeFallbackHook } from "./hook"
import type { RuntimeFallbackHook, RuntimeFallbackPluginInput } from "./types"
import { DEFAULT_INTERNAL_CONTINUATION_LOOP_THRESHOLD } from "./internal-continuation-loop-detector"
import { createInternalAgentTextPart } from "../../shared/internal-initiator-marker"

const WATCHDOG_CONTINUATION_PROMPT = "Continue the current task from where you left off. The previous request appears stalled. Resume from the existing context, do not redo completed work, and continue."

function createPluginInput(): RuntimeFallbackPluginInput {
  return {
    client: {
      session: {
        abort: async () => ({}),
        messages: async () => ({ data: [] }),
        promptAsync: async () => ({}),
      },
      tui: {
        showToast: async () => ({}),
      },
    },
    directory: "/test/dir",
  }
}

function createHook(): RuntimeFallbackHook {
  return createRuntimeFallbackHook(createPluginInput(), {
    config: {
      enabled: true,
      retry_on_errors: [429, 503, 529],
      max_fallback_attempts: 3,
      max_full_chain_cycles: 5,
      cooldown_seconds: 60,
      timeout_seconds: 30,
      transient_retry_window_seconds: 900,
      transient_retry_initial_delay_seconds: 10,
      transient_retry_max_delay_seconds: 300,
      notify_on_fallback: false,
    },
    pluginConfig: {
      git_master: {
        commit_footer: true,
        include_co_authored_by: true,
        git_env_prefix: "GIT_MASTER=1",
      },
      categories: {
        test: {
          fallback_models: ["openai/gpt-5.4"],
        },
      },
    },
  })
}

async function sendRealUserMessage(hook: RuntimeFallbackHook, sessionID: string, id: string): Promise<void> {
  await hook.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id,
          sessionID,
          role: "user",
          providerID: "openai",
          modelID: "gpt-5.4",
        },
      },
    },
  })
}

async function sendInternalContinuation(
  hook: RuntimeFallbackHook,
  sessionID: string,
  id: string,
  text: string = `internal continuation ${id}`,
): Promise<void> {
  await hook.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id,
          sessionID,
          role: "user",
          providerID: "openai",
          modelID: "gpt-5.4",
        },
        parts: [createInternalAgentTextPart(text)],
      },
    },
  })
}

async function sendVisibleAssistantOutput(hook: RuntimeFallbackHook, sessionID: string, id: string): Promise<void> {
  await hook.event({
    event: {
      type: "message.updated",
      properties: {
        info: {
          id,
          sessionID,
          role: "assistant",
          model: {
            providerID: "openai",
            modelID: "gpt-5.4",
          },
          message: "Visible assistant progress.",
        },
      },
    },
  })
}

function getState(hook: RuntimeFallbackHook, sessionID: string) {
  const state = hook._deps?.sessionStates.get(sessionID)
  expect(state).toBeDefined()
  return state
}

describe("runtime-fallback internal continuation loop integration", () => {
  test("becomes terminal after bounded repeated internal continuation turns without visible progress", async () => {
    const hook = createHook()
    const sessionID = "ses-internal-loop-terminal-threshold"

    try {
      await sendRealUserMessage(hook, sessionID, "user-1")
      const state = getState(hook, sessionID)

      for (let index = 1; index < DEFAULT_INTERNAL_CONTINUATION_LOOP_THRESHOLD; index += 1) {
        await sendInternalContinuation(hook, sessionID, `internal-${index}`)
      }

      expect(state?.stoppedAt).toBeUndefined()

      await sendInternalContinuation(hook, sessionID, `internal-${DEFAULT_INTERNAL_CONTINUATION_LOOP_THRESHOLD}`)

      expect(state?.stoppedAt).toBeDefined()
    } finally {
      hook.dispose?.()
    }
  })

  test("watchdog-origin continuation prompts count toward the same terminal threshold", async () => {
    const hook = createHook()
    const sessionID = "ses-internal-loop-watchdog-origin"

    try {
      await sendRealUserMessage(hook, sessionID, "user-1")
      const state = getState(hook, sessionID)

      for (let index = 1; index < DEFAULT_INTERNAL_CONTINUATION_LOOP_THRESHOLD; index += 1) {
        await sendInternalContinuation(hook, sessionID, `watchdog-${index}`, WATCHDOG_CONTINUATION_PROMPT)
      }

      expect(state?.stoppedAt).toBeUndefined()
      await sendInternalContinuation(hook, sessionID, `watchdog-${DEFAULT_INTERNAL_CONTINUATION_LOOP_THRESHOLD}`, WATCHDOG_CONTINUATION_PROMPT)
      expect(state?.stoppedAt).toBeDefined()
    } finally {
      hook.dispose?.()
    }
  })

  test("visible assistant output resets the loop path before threshold is reached again", async () => {
    const hook = createHook()
    const sessionID = "ses-internal-loop-visible-reset"

    try {
      await sendRealUserMessage(hook, sessionID, "user-1")
      const state = getState(hook, sessionID)

      await sendInternalContinuation(hook, sessionID, "internal-before-reset-1")
      await sendInternalContinuation(hook, sessionID, "internal-before-reset-2")
      await sendVisibleAssistantOutput(hook, sessionID, "assistant-visible-1")

      await sendInternalContinuation(hook, sessionID, "internal-after-reset-1")
      await sendInternalContinuation(hook, sessionID, "internal-after-reset-2")

      expect(state?.stoppedAt).toBeUndefined()

      await sendInternalContinuation(hook, sessionID, "internal-after-reset-3")

      expect(state?.stoppedAt).toBeDefined()
    } finally {
      hook.dispose?.()
    }
  })

  test("visible assistant output clears prior terminal loop state before unrelated later activity", async () => {
    const hook = createHook()
    const sessionID = "ses-internal-loop-visible-clears-terminal"

    try {
      await sendRealUserMessage(hook, sessionID, "user-1")
      const state = getState(hook, sessionID)

      for (let index = 1; index <= DEFAULT_INTERNAL_CONTINUATION_LOOP_THRESHOLD; index += 1) {
        await sendInternalContinuation(hook, sessionID, `internal-terminal-${index}`)
      }

      expect(state?.stoppedAt).toBeDefined()

      await sendVisibleAssistantOutput(hook, sessionID, "assistant-visible-reset")

      expect(state?.stoppedAt).toBeUndefined()

      await sendInternalContinuation(hook, sessionID, "internal-after-visible-reset-1")

      expect(state?.stoppedAt).toBeUndefined()
    } finally {
      hook.dispose?.()
    }
  })

  test("fresh real user turn resets the loop path before threshold is reached again", async () => {
    const hook = createHook()
    const sessionID = "ses-internal-loop-real-user-reset"

    try {
      await sendRealUserMessage(hook, sessionID, "user-1")
      const state = getState(hook, sessionID)

      await sendInternalContinuation(hook, sessionID, "internal-before-real-user-reset-1")
      await sendInternalContinuation(hook, sessionID, "internal-before-real-user-reset-2")
      await sendRealUserMessage(hook, sessionID, "user-2")

      await sendInternalContinuation(hook, sessionID, "internal-after-real-user-reset-1")
      await sendInternalContinuation(hook, sessionID, "internal-after-real-user-reset-2")

      expect(state?.stoppedAt).toBeUndefined()

      await sendInternalContinuation(hook, sessionID, "internal-after-real-user-reset-3")

      expect(state?.stoppedAt).toBeDefined()
    } finally {
      hook.dispose?.()
    }
  })

  test("fresh real user turn clears prior terminal loop state before unrelated later activity", async () => {
    const hook = createHook()
    const sessionID = "ses-internal-loop-real-user-clears-terminal"

    try {
      await sendRealUserMessage(hook, sessionID, "user-1")
      const state = getState(hook, sessionID)

      for (let index = 1; index <= DEFAULT_INTERNAL_CONTINUATION_LOOP_THRESHOLD; index += 1) {
        await sendInternalContinuation(hook, sessionID, `internal-terminal-${index}`)
      }

      expect(state?.stoppedAt).toBeDefined()

      await sendRealUserMessage(hook, sessionID, "user-2")

      expect(state?.stoppedAt).toBeUndefined()

      await sendInternalContinuation(hook, sessionID, "internal-after-real-user-reset-1")

      expect(state?.stoppedAt).toBeUndefined()
    } finally {
      hook.dispose?.()
    }
  })
})
