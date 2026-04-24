import { describe, expect, test } from "bun:test"
import type { OpencodeClient } from "./constants"
import { resolveSubagentSpawnContext } from "./subagent-spawn-limits"

function createMockClient(sessionGet: OpencodeClient["session"]["get"]): OpencodeClient {
  return {
    session: {
      get: sessionGet,
    },
  } as OpencodeClient
}

describe("resolveSubagentSpawnContext", () => {
  describe("#given session.get hits the known SDK client-binding crash", () => {
    test("falls back to treating the parent session as the root lineage", async () => {
      // given
      const client = createMockClient(async () => {
        throw new TypeError("undefined is not an object (evaluating 'this._client')")
      })

      // when
      const result = await resolveSubagentSpawnContext(client, "parent-session")

      // then
      expect(result).toEqual({
        rootSessionID: "parent-session",
        parentDepth: 0,
        childDepth: 1,
      })
    })
  })

  describe("#given session.get returns an SDK error response", () => {
    test("throws a fail-closed spawn blocked error", async () => {
      // given
      const client = createMockClient(async () => ({
        error: "lookup failed",
        data: undefined,
      }))

      // when
      const result = resolveSubagentSpawnContext(client, "parent-session")

      // then
      await expect(result).rejects.toThrow(/background_task\.maxDescendants cannot be enforced safely.*lookup failed/)
    })
  })

  describe("#given session.get returns no session data", () => {
    test("throws a fail-closed spawn blocked error", async () => {
      // given
      const client = createMockClient(async () => ({
        data: undefined,
      }))

      // when
      const result = resolveSubagentSpawnContext(client, "parent-session")

      // then
      await expect(result).rejects.toThrow(/background_task\.maxDescendants cannot be enforced safely.*No session data returned/)
    })
  })
})
