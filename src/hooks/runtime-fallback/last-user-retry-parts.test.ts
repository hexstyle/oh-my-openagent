import { describe, expect, it } from "bun:test"
import { getLastUserRetryParts } from "./last-user-retry-parts"
import { OMO_INTERNAL_INITIATOR_MARKER } from "../../shared/internal-initiator-marker"

describe("getLastUserRetryParts", () => {
  it("#given a normal user message #when extracting retry parts #then returns the text parts", () => {
    const messagesResponse = {
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "hello world" }] },
      ],
    }

    const result = getLastUserRetryParts(messagesResponse)

    expect(result).toEqual([{ type: "text", text: "hello world" }])
  })

  it("#given multiple user messages #when extracting retry parts #then returns the last user message parts", () => {
    const messagesResponse = {
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "first question" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "first answer" }] },
        { info: { role: "user" }, parts: [{ type: "text", text: "second question" }] },
      ],
    }

    const result = getLastUserRetryParts(messagesResponse)

    expect(result).toEqual([{ type: "text", text: "second question" }])
  })

  it("#given the last user message is an internal initiator prompt #when extracting retry parts #then skips internal message and returns the previous real user message", () => {
    const messagesResponse = {
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "implement the feature" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "working on it..." }] },
        {
          info: { role: "user" },
          parts: [{ type: "text", text: `Continue from where you left off.\n${OMO_INTERNAL_INITIATOR_MARKER}` }],
        },
      ],
    }

    const result = getLastUserRetryParts(messagesResponse)

    expect(result).toEqual([{ type: "text", text: "implement the feature" }])
  })

  it("#given multiple consecutive internal initiator messages #when extracting retry parts #then skips all internal messages and returns the last real user message", () => {
    const messagesResponse = {
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "real user request" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "partial response" }] },
        {
          info: { role: "user" },
          parts: [{ type: "text", text: `Continue.\n${OMO_INTERNAL_INITIATOR_MARKER}` }],
        },
        { info: { role: "assistant" }, parts: [] },
        {
          info: { role: "user" },
          parts: [{ type: "text", text: `Resume work.\n${OMO_INTERNAL_INITIATOR_MARKER}` }],
        },
      ],
    }

    const result = getLastUserRetryParts(messagesResponse)

    expect(result).toEqual([{ type: "text", text: "real user request" }])
  })

  it("#given only internal initiator messages and no real user messages #when extracting retry parts #then returns empty array", () => {
    const messagesResponse = {
      data: [
        {
          info: { role: "user" },
          parts: [{ type: "text", text: `Continue.\n${OMO_INTERNAL_INITIATOR_MARKER}` }],
        },
      ],
    }

    const result = getLastUserRetryParts(messagesResponse)

    expect(result).toEqual([])
  })

  it("#given an internal initiator message with info.parts fallback #when extracting retry parts #then still filters it out", () => {
    const messagesResponse = {
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "real request" }] },
        {
          info: {
            role: "user",
            parts: [{ type: "text", text: `Internal continuation\n${OMO_INTERNAL_INITIATOR_MARKER}` }],
          },
        },
      ],
    }

    const result = getLastUserRetryParts(messagesResponse)

    expect(result).toEqual([{ type: "text", text: "real request" }])
  })

  it("#given an internal initiator user message followed by an assistant update #when extracting retry parts #then the assistant update is ignored and the last real user payload is preserved", () => {
    const messagesResponse = {
      data: [
        { info: { role: "user" }, parts: [{ type: "text", text: "ship the partial fix" }] },
        {
          info: { role: "user" },
          parts: [{ type: "text", text: `Continue from where you left off.\n${OMO_INTERNAL_INITIATOR_MARKER}` }],
        },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "working" }] },
      ],
    }

    const result = getLastUserRetryParts(messagesResponse)

    expect(result).toEqual([{ type: "text", text: "ship the partial fix" }])
  })

  it("#given a real multipart user request followed by an internal initiator payload #when extracting retry parts #then only the last real user text parts remain eligible for retry", () => {
    const messagesResponse = {
      data: [
        {
          info: { role: "user" },
          parts: [
            { type: "text", text: "keep this anchor" },
            { type: "tool_use" },
            { type: "text", text: "and preserve this detail" },
          ],
        },
        {
          info: { role: "user" },
          parts: [
            { type: "text", text: "Continue from where you left off." },
            { type: "text", text: OMO_INTERNAL_INITIATOR_MARKER },
          ],
        },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "still working" }] },
      ],
    }

    const result = getLastUserRetryParts(messagesResponse)

    expect(result).toEqual([
      { type: "text", text: "keep this anchor" },
      { type: "text", text: "and preserve this detail" },
    ])
  })

  it("#given no messages at all #when extracting retry parts #then returns empty array", () => {
    const result = getLastUserRetryParts(undefined)

    expect(result).toEqual([])
  })
})
