import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
declare const require: (name: string) => any
import { prependThinkingPart, prependThinkingPartAsync } from "./storage/thinking-prepend"
import { PART_STORAGE } from "../../shared/opencode-storage-paths"

const { describe, expect, it, mock } = require("bun:test")

type StoredPartRecord = {
  id: string
  sessionID: string
  messageID: string
  type: string
  signature?: string
  thinking?: string
}

type SyncDeps = NonNullable<Parameters<typeof prependThinkingPart>[2]>
type AsyncDeps = NonNullable<Parameters<typeof prependThinkingPartAsync>[3]>

const cleanup = (messageID: string): void => {
  rmSync(join(PART_STORAGE, messageID), { recursive: true, force: true })
}

const createSyncDeps = (overrides: Partial<SyncDeps>): SyncDeps => ({
  isSqliteBackend: () => false,
  patchPart: async () => true,
  log: mock(() => {}),
  findLastThinkingPart: () => null,
  findLastThinkingPartFromSDK: async () => null,
  readTargetPartIDs: () => [],
  readTargetPartIDsFromSDK: async () => [],
  ...overrides,
})

const createAsyncDeps = (overrides: Partial<AsyncDeps>): AsyncDeps => ({
  isSqliteBackend: () => false,
  patchPart: async () => true,
  log: mock(() => {}),
  findLastThinkingPart: () => null,
  findLastThinkingPartFromSDK: async () => null,
  readTargetPartIDs: () => [],
  readTargetPartIDsFromSDK: async () => [],
  ...overrides,
})

async function runAsyncPrepend(
  client: unknown,
  sessionID: string,
  messageID: string,
  deps: AsyncDeps,
): Promise<boolean> {
  const fn = Reflect.get({ prependThinkingPartAsync }, "prependThinkingPartAsync")
  return Reflect.apply(fn, undefined, [client, sessionID, messageID, deps]) as Promise<boolean>
}

export function registerThinkingPrependTests(): void {
  describe("thinking-prepend", () => {
    it("writes the original signed thinking part verbatim for file-backed recovery", () => {
      const sessionID = "ses_thinking_prepend_sync"
      const targetMessageID = "msg_target_signed"
      const originalPart = {
        id: "prt_prev_signed",
        sessionID,
        messageID: "msg_prev_signed",
        type: "thinking",
        thinking: "prior reasoning",
        signature: "sig_prev",
      } as const satisfies StoredPartRecord

      const result = prependThinkingPart(sessionID, targetMessageID, createSyncDeps({
        findLastThinkingPart: () => originalPart,
        readTargetPartIDs: () => ["prt_target_text"],
      }))

      const writtenPath = join(PART_STORAGE, targetMessageID, `${originalPart.id}.json`)
      expect(result).toBe(true)
      expect(existsSync(writtenPath)).toBe(true)
      expect(JSON.parse(readFileSync(writtenPath, "utf-8"))).toEqual(originalPart)
      cleanup(targetMessageID)
    })

    for (const testCase of [
      {
        name: "returns false without writing when no signed thinking part exists in history",
        sessionID: "ses_thinking_prepend_sync_missing",
        targetMessageID: "msg_target_missing",
        deps: createSyncDeps({}),
      },
      {
        name: "returns false immediately when sqlite backend is active",
        sessionID: "ses_sqlite",
        targetMessageID: "msg_sqlite",
        deps: createSyncDeps({ isSqliteBackend: () => true }),
      },
      {
        name: "returns false when the reused signed thinking part would not sort before target parts",
        sessionID: "ses_thinking_prepend_sync_out_of_order",
        targetMessageID: "msg_target_out_of_order",
        deps: createSyncDeps({
          findLastThinkingPart: () => ({
            id: "prt_z_reused",
            sessionID: "ses_thinking_prepend_sync_out_of_order",
            messageID: "msg_prev_signed",
            type: "thinking",
            thinking: "prior reasoning",
            signature: "sig_prev",
          }),
          readTargetPartIDs: () => ["prt_a_target"],
        }),
      },
    ]) {
      it(testCase.name, () => {
        expect(prependThinkingPart(testCase.sessionID, testCase.targetMessageID, testCase.deps)).toBe(false)
        expect(existsSync(join(PART_STORAGE, testCase.targetMessageID))).toBe(false)
        cleanup(testCase.targetMessageID)
      })
    }

    it("patches the original signed thinking part verbatim for sdk-backed recovery", async () => {
      const patchPartMock = mock(async () => true)
      const originalPart = {
        id: "prt_prev_async",
        type: "thinking",
        thinking: "prior reasoning",
        signature: "sig_async",
      } as const
      const client = { session: { messages: async () => ({ data: [] }) } }
      const result = await runAsyncPrepend(client, "ses_thinking_prepend_async", "msg_target_async", createAsyncDeps({
        patchPart: patchPartMock,
        findLastThinkingPartFromSDK: async () => originalPart,
        readTargetPartIDsFromSDK: async () => ["prt_target_text"],
      }))

      expect(result).toBe(true)
      expect(patchPartMock).toHaveBeenCalledTimes(1)
      expect(patchPartMock.mock.calls[0]?.[0]).toBe(client)
      expect(patchPartMock.mock.calls[0]?.[1]).toBe("ses_thinking_prepend_async")
      expect(patchPartMock.mock.calls[0]?.[2]).toBe("msg_target_async")
      expect(patchPartMock.mock.calls[0]?.[3]).toBe("prt_prev_async")
      expect(patchPartMock.mock.calls[0]?.[4]).toEqual(originalPart)
    })

    for (const testCase of [
      {
        name: "returns false without patching when sdk history has no signed thinking part",
        sessionID: "ses_thinking_prepend_async_missing",
        targetMessageID: "msg_target_async_missing",
        deps: createAsyncDeps({}),
      },
      {
        name: "returns false when the sdk reused signed thinking part would not sort before target parts",
        sessionID: "ses_thinking_prepend_async_out_of_order",
        targetMessageID: "msg_target_async_out_of_order",
        deps: createAsyncDeps({
          findLastThinkingPartFromSDK: async () => ({
            id: "prt_z_reused",
            type: "thinking",
            thinking: "prior reasoning",
            signature: "sig_async",
          }),
          readTargetPartIDsFromSDK: async () => ["prt_a_target"],
        }),
      },
    ]) {
      it(testCase.name, async () => {
        const patchPartMock = mock(async () => true)
        const client = { session: { messages: async () => ({ data: [] }) } }
        const result = await runAsyncPrepend(client, testCase.sessionID, testCase.targetMessageID, {
          ...testCase.deps,
          patchPart: patchPartMock,
        })

        expect(result).toBe(false)
        expect(patchPartMock).toHaveBeenCalledTimes(0)
      })
    }
  })
}
