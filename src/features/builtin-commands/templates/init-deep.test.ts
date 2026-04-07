import { describe, expect, test } from "bun:test"
import { INIT_DEEP_TEMPLATE } from "./init-deep"

function extractSection(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)

  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)

  return source.slice(start, end)
}

function extractExploreTaskDescriptions(section: string): string[] {
  return Array.from(
    section.matchAll(/task\(subagent_type="explore"[\s\S]*?description="([^"]+)"/g),
    (match) => match[1],
  )
}

describe("init-deep template", () => {
  test("exports a non-empty template string", () => {
    expect(typeof INIT_DEEP_TEMPLATE).toBe("string")
    expect(INIT_DEEP_TEMPLATE.length).toBeGreaterThan(0)
  })

  test("documents duplicate-task prevention and reduced initial fan-out", () => {
    expect(INIT_DEEP_TEMPLATE).toContain("Do NOT launch the same background task twice.")
    expect(INIT_DEEP_TEMPLATE).toContain("Keep the initial fan-out to 3 unique explore tasks")
    expect(INIT_DEEP_TEMPLATE).toContain("spawn AT MOST 2 ADDITIONAL unique explore agents")
  })

  test("keeps the initial explore launch block limited to three unique tasks", () => {
    const initialBlock = extractSection(
      INIT_DEEP_TEMPLATE,
      "// Fire a SMALL unique set first, collect results later",
      "</dynamic-agents>",
    )

    const descriptions = extractExploreTaskDescriptions(initialBlock)

    expect(descriptions).toEqual([
      "Explore project structure",
      "Find entry points",
      "Find conventions",
      "Analyze large files",
      "Explore deep modules",
    ])

    const initialOnly = descriptions.slice(0, 3)
    expect(new Set(initialOnly).size).toBe(3)
  })

  test("does not reintroduce the old aggressive explore starter set", () => {
    expect(INIT_DEEP_TEMPLATE).not.toContain('description="Find anti-patterns"')
    expect(INIT_DEEP_TEMPLATE).not.toContain('description="Explore build/CI"')
    expect(INIT_DEEP_TEMPLATE).not.toContain('description="Find test patterns"')
  })
})
