import { describe, expect, test } from "bun:test"
import { loadAgentProfileColors } from "./agent-profile-colors"

describe("loadAgentProfileColors", () => {
  test("normalizes reserved runtime keys to display names", async () => {
    const client = {
      app: {
        agents: async () => ([
          { name: "explore", color: "#123456" },
          { name: "Oracle (Strategic Advisor)", color: "#abcdef" },
        ]),
      },
    } as any

    const result = await loadAgentProfileColors(client)

    expect(result).toEqual({
      "Explore (Code Search)": "#123456",
      "Oracle (Strategic Advisor)": "#abcdef",
    })
  })
})
