import { describe, it, expect } from "bun:test"
import { BOULDER_CONTINUATION_PROMPT } from "./system-reminder-templates"

describe("BOULDER_CONTINUATION_PROMPT", () => {
  describe("checkbox-first priority rules", () => {
    it("first rule after RULES: mentions both reading the plan AND marking a still-unchecked completed task", () => {
      const rulesSection = BOULDER_CONTINUATION_PROMPT.split("RULES:")[1]!
      const firstRule = rulesSection.split("\n")[1]!.trim()

      expect(firstRule).toContain("Read the plan")
      expect(firstRule).toContain("mark")
      expect(firstRule).toContain("completed")
    })

    it("first rule includes IMMEDIATELY keyword", () => {
      const rulesSection = BOULDER_CONTINUATION_PROMPT.split("RULES:")[1]!
      const firstRule = rulesSection.split("\n")[1]!.trim()

      expect(firstRule).toContain("IMMEDIATELY")
    })

    it("checkbox-marking guidance appears BEFORE Proceed without asking for permission", () => {
      const rulesSection = BOULDER_CONTINUATION_PROMPT.split("RULES:")[1]!

      const checkboxMarkingMatch = rulesSection.match(/- \[x\]/i)
      const proceedMatch = rulesSection.match(/Proceed without asking for permission/)

      expect(checkboxMarkingMatch).not.toBeNull()
      expect(proceedMatch).not.toBeNull()

      const checkboxPosition = checkboxMarkingMatch!.index
      const proceedPosition = proceedMatch!.index

      expect(checkboxPosition).toBeLessThan(proceedPosition)
    })
  })

  describe("delegation-first orchestration rules", () => {
    it("requires immediate delegation of the current top-level task after minimal context refresh", () => {
      const rulesSection = BOULDER_CONTINUATION_PROMPT.split("RULES:")[1]!
      const lowerRules = rulesSection.toLowerCase()

      expect(lowerRules).toContain("current top-level task")
      expect(lowerRules).toContain("task(")
      expect(lowerRules).toMatch(/immediately|next substantive action/)
    })

    it("forbids long self-directed read/bash research loops before delegation", () => {
      const rulesSection = BOULDER_CONTINUATION_PROMPT.split("RULES:")[1]!
      const lowerRules = rulesSection.toLowerCase()

      expect(lowerRules).toContain("do not spend multiple")
      expect(lowerRules).toContain("`read`/`bash`")
      expect(lowerRules).toContain("explore")
    })
  })
})
