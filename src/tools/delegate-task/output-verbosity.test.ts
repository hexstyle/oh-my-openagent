/// <reference types="bun-types" />

import { describe, test, expect } from "bun:test"
import {
  buildPlanAgentSystemPrepend,
  PLAN_AGENT_SYSTEM_PREPEND_STATIC_BEFORE_SKILLS,
  PLAN_AGENT_SYSTEM_PREPEND_STATIC_AFTER_SKILLS,
} from "./constants"

const mockCategories = [
  { name: "quick", description: "Fast lightweight tasks", model: "anthropic/claude-haiku-4-5" },
  { name: "deep", description: "Goal-oriented autonomous problem-solving", model: "openai/gpt-5.3-codex" },
  { name: "artistry", description: "Visual engineering and creative tasks", model: "google/gemini-3.1-pro" },
]

const mockSkills = [
  { name: "ci-green-loop", description: "Drive CI pipeline to green via iterative fix cycles", location: "plugin" as const },
  { name: "dotnet-playwright", description: "ASP.NET + Playwright test automation", location: "plugin" as const },
  { name: "typescript-programmer", description: "Production TypeScript code", location: "plugin" as const },
]

describe("output verbosity guards", () => {
  test("plan agent system prepend is under 4000 chars", () => {
    const prepend = buildPlanAgentSystemPrepend(mockCategories, mockSkills)
    expect(prepend.length).toBeLessThan(4000)
  })

  test("plan agent static parts are under 1500 chars total", () => {
    const staticSize =
      PLAN_AGENT_SYSTEM_PREPEND_STATIC_BEFORE_SKILLS.length +
      PLAN_AGENT_SYSTEM_PREPEND_STATIC_AFTER_SKILLS.length
    expect(staticSize).toBeLessThan(1500)
  })

  test("plan agent prepend contains all required sections", () => {
    const prepend = buildPlanAgentSystemPrepend(mockCategories, mockSkills)
    expect(prepend).toContain("Dependency Graph")
    expect(prepend).toContain("Parallel Execution")
    expect(prepend).toContain("Category")
    expect(prepend).toContain("Skills")
    expect(prepend).toContain("TODO")
    expect(prepend).toContain("AVAILABLE CATEGORIES")
    expect(prepend).toContain("AVAILABLE SKILLS")
  })

  test("plan agent prepend does not contain ASCII art", () => {
    const prepend = buildPlanAgentSystemPrepend(mockCategories, mockSkills)
    expect(prepend).not.toContain("██")
    expect(prepend).not.toContain("═══")
    expect(prepend).not.toContain("╗")
    expect(prepend).not.toContain("╚")
    expect(prepend).not.toContain("█ SECTION")
  })

  test("plan agent prepend does not contain verbose decorative patterns", () => {
    const prepend = buildPlanAgentSystemPrepend(mockCategories, mockSkills)
    expect(prepend).not.toContain("WHY THIS MATTERS")
    expect(prepend).not.toContain("FAILURE TO INCLUDE")
    expect(prepend).not.toContain("MOMUS")
    expect(prepend).not.toContain("FINAL_OUTPUT_FOR_CALLER")
  })

  test("plan agent prepend renders all provided categories", () => {
    const prepend = buildPlanAgentSystemPrepend(mockCategories, mockSkills)
    for (const cat of mockCategories) {
      expect(prepend).toContain(`\`${cat.name}\``)
    }
  })

  test("plan agent prepend renders all provided skills", () => {
    const prepend = buildPlanAgentSystemPrepend(mockCategories, mockSkills)
    for (const skill of mockSkills) {
      expect(prepend).toContain(`\`${skill.name}\``)
    }
  })

  test("plan agent prepend with empty categories/skills stays under 2000 chars", () => {
    const prepend = buildPlanAgentSystemPrepend([], [])
    expect(prepend.length).toBeLessThan(2000)
  })
})
