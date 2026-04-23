import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  assertSmokeSucceededOrSkippable,
  createSmokeWorkspace,
  interpretSmokeDescendantMessages,
  interpretSmokeMessages,
  isSkippableProviderQuotaSmokeFailure,
  resolveSmokeTimeoutMs,
} from "./verify-local-opencode-install"

describe("verify-local-opencode-install smoke handling", () => {
  test("treats provider quota exhaustion as skippable for install verification", () => {
    expect(
      isSkippableProviderQuotaSmokeFailure(
        "AI_APICallError: You're out of extra usage. Add more at claude.ai/settings/usage and keep going.",
      ),
    ).toBe(true)
    expect(
      isSkippableProviderQuotaSmokeFailure(
        "The usage limit has been reached. Please upgrade to continue.",
      ),
    ).toBe(true)
  })

  test("still fails smoke validation for non-quota failures", () => {
    expect(() =>
      assertSmokeSucceededOrSkippable({
        providerLabel: "Anthropic",
        result: {
          exitCode: 1,
          output: "Unexpected error, check log file at /tmp/log",
        },
      }),
    ).toThrow("Anthropic smoke test did not return OK")
  })

  test("accepts successful smoke output", () => {
    expect(() =>
      assertSmokeSucceededOrSkippable({
        providerLabel: "OpenAI",
        result: {
          exitCode: 0,
          output: "OK",
        },
      }),
    ).not.toThrow()
  })

  test("treats timeout-driven fallback handoff as pending until the fallback assistant responds", () => {
    expect(
      interpretSmokeMessages([
        {
          role: "user",
          parts: [{ type: "text", text: "Reply with OK only." }],
        },
        {
          role: "assistant",
          error: { name: "MessageAbortedError", message: "" },
        },
        {
          role: "user",
          parts: [{ type: "text", text: "Reply with OK only." }],
        },
        {
          role: "assistant",
          parts: [],
        },
      ]),
    ).toEqual({
      output: "",
      state: "pending",
    })
  })

  test("handles nested sdk message payloads without crashing", () => {
    expect(
      interpretSmokeMessages({
        messages: [
          {
            role: "assistant",
            parts: [{ type: "text", text: "OK" }],
          },
        ],
      }),
    ).toEqual({
      output: "OK",
      state: "success",
    })
  })

  test("treats a successful scoped fallback child response as smoke success", async () => {
    const sessionMessages: Record<string, unknown[]> = {
      root: [
        { role: "user", parts: [{ type: "text", text: "Reply with OK only." }] },
        { role: "assistant", parts: [] },
      ],
      child: [
        { role: "user", parts: [{ type: "text", text: "Reply with OK only." }] },
        { role: "assistant", parts: [{ type: "text", text: "OK" }] },
      ],
    }
    const client = {
      session: {
        children: async ({ path }: { path: { id: string } }) => ({
          data: path.id === "root" ? [{ id: "child" }] : [],
        }),
        messages: async ({ path }: { path: { id: string } }) => ({
          data: sessionMessages[path.id] ?? [],
        }),
      },
    } as any

    await expect(
      interpretSmokeDescendantMessages({
        client,
        smokeDirectory: "/tmp/smoke",
        sessionID: "root",
      }),
    ).resolves.toEqual({
      output: "OK",
      state: "success",
    })
  })

  test("creates isolated smoke workspace outside the plugin repo state", () => {
    const baseDir = join(tmpdir(), "verify-local-opencode-install-test")
    mkdirSync(baseDir, { recursive: true })
    const workspace = createSmokeWorkspace(baseDir)

    try {
      expect(existsSync(workspace)).toBe(true)
      expect(workspace.startsWith(baseDir)).toBe(true)
      expect(workspace).not.toContain("/proj/hexstyle-oh-my-openagent")
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  test("gives the Anthropic Prometheus smoke enough time to recover onto the next paid model", () => {
    expect(resolveSmokeTimeoutMs("Prometheus (Plan Builder)")).toBe(8 * 60 * 1000)
    expect(resolveSmokeTimeoutMs("Hephaestus (Deep Agent)")).toBe(5 * 60 * 1000)
  })
})
