import { describe, expect, test } from "bun:test"
import { AthenaConfigSchema } from "./athena-config"
import { OhMyOpenCodeConfigSchema } from "./oh-my-opencode-config"

describe("AthenaConfigSchema", () => {
  test("accepts athena config with required members", () => {
    // given
    const config = {
      model: "openai/gpt-5.4",
      members: [
        { name: "Socrates", model: "openai/gpt-5.4" },
        { name: "Plato", model: "anthropic/claude-sonnet-4-6" },
      ],
    }

    // when
    const result = AthenaConfigSchema.safeParse(config)

    // then
    expect(result.success).toBe(true)
  })

  test("rejects athena config when members are missing", () => {
    // given
    const config = {
      model: "openai/gpt-5.4",
    }

    // when
    const result = AthenaConfigSchema.safeParse(config)

    // then
    expect(result.success).toBe(false)
  })

  test("rejects case-insensitive duplicate member names", () => {
    // given
    const config = {
      members: [
        { name: "Socrates", model: "openai/gpt-5.4" },
        { name: "socrates", model: "anthropic/claude-sonnet-4-6" },
      ],
    }

    // when
    const result = AthenaConfigSchema.safeParse(config)

    // then
    expect(result.success).toBe(false)
  })

  test("rejects member model without provider prefix", () => {
    // given
    const config = {
      members: [{ name: "Socrates", model: "gpt-5.4" }],
    }

    // when
    const result = AthenaConfigSchema.safeParse(config)

    // then
    expect(result.success).toBe(false)
  })
})

describe("OhMyOpenCodeConfigSchema athena field", () => {
  test("accepts athena config at root", () => {
    // given
    const config = {
      athena: {
        model: "openai/gpt-5.4",
        members: [{ name: "Socrates", model: "openai/gpt-5.4" }],
      },
    }

    // when
    const result = OhMyOpenCodeConfigSchema.safeParse(config)

    // then
    expect(result.success).toBe(true)
  })
})
