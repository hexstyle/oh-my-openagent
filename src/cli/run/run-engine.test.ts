/// <reference types="bun-types" />

import { describe, expect, it, mock } from "bun:test"
import { executeRunSession } from "./run-engine"
import type { OpencodeClient, StreamEvent } from "./types"

function toAsyncIterable(values: unknown[]): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const value of values) {
        yield value
      }
    },
  }
}

describe("executeRunSession", () => {
  it("allows SDK sessions to enable questions and emits normalized events", async () => {
    const seenEvents: StreamEvent[] = []
    const client = {
      session: {
        create: mock(() => Promise.resolve({ data: { id: "ses_sdk" } })),
        promptAsync: mock(() => Promise.resolve({})),
        status: mock(() => Promise.resolve({ data: { ses_sdk: { type: "idle" } } })),
        todo: mock(() => Promise.resolve({ data: [] })),
        children: mock(() => Promise.resolve({ data: [] })),
      },
      event: {
        subscribe: mock(() => Promise.resolve({
          stream: toAsyncIterable([
            {
              type: "message.updated",
              properties: {
                info: {
                  id: "msg_1",
                  sessionID: "ses_sdk",
                  role: "assistant",
                  agent: "Prometheus (Plan Builder)",
                },
              },
            },
            {
              type: "tool.execute",
              properties: {
                sessionID: "ses_sdk",
                name: "question",
                input: {
                  questions: [{ question: "Which agent should run?" }],
                },
              },
            },
            {
              type: "message.part.delta",
              properties: {
                sessionID: "ses_sdk",
                messageID: "msg_1",
                partID: "part_1",
                field: "text",
                delta: "hello",
              },
            },
            {
              type: "tool.result",
              properties: {
                sessionID: "ses_sdk",
                name: "question",
                output: "waiting",
              },
            },
            {
              type: "message.part.updated",
              properties: {
                part: {
                  id: "part_1",
                  sessionID: "ses_sdk",
                  messageID: "msg_1",
                  type: "text",
                  text: "hello",
                  time: { end: 1 },
                },
              },
            },
            {
              type: "session.status",
              properties: {
                sessionID: "ses_sdk",
                status: { type: "idle" },
              },
            },
          ]),
        })),
      },
    } as unknown as OpencodeClient

    const result = await executeRunSession({
      client,
      directory: "/repo",
      message: "hello",
      agent: "prometheus",
      questionPermission: "allow",
      questionToolEnabled: true,
      renderOutput: false,
      logger: { log: () => {}, error: () => {} },
      pluginConfig: {},
      pollOptions: {
        pollIntervalMs: 1,
        minStabilizationMs: 0,
      },
      eventObserver: {
        onEvent: async (event) => {
          seenEvents.push(event)
        },
      },
    })

    expect(result.exitCode).toBe(0)
    expect(result.result.success).toBe(true)
    expect(client.session.create).toHaveBeenCalledWith({
      body: {
        title: "oh-my-opencode run",
        permission: [
          { permission: "question", action: "allow", pattern: "*" },
        ],
      },
      query: { directory: "/repo" },
    })
    expect(client.session.promptAsync).toHaveBeenCalledWith({
      path: { id: "ses_sdk" },
      body: {
        agent: "Prometheus (Plan Builder)",
        tools: { question: true },
        parts: [{ type: "text", text: "hello" }],
      },
      query: { directory: "/repo" },
    })
    expect(seenEvents.map((event) => event.type)).toContain("session.started")
    expect(seenEvents.map((event) => event.type)).toContain("session.question")
    expect(seenEvents.map((event) => event.type)).toContain("message.delta")
    expect(seenEvents.map((event) => event.type)).toContain("message.completed")
    expect(seenEvents.map((event) => event.type)).toContain("session.completed")
  })
})
