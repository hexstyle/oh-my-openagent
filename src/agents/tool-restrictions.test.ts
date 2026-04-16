import { describe, test, expect } from "bun:test"
import { createOracleAgent } from "./oracle"
import { createLibrarianAgent } from "./librarian"
import { createExploreAgent } from "./explore"
import { createMomusAgent } from "./momus"
import { createMetisAgent } from "./metis"
import { createAtlasAgent } from "./atlas"

const TEST_MODEL = "anthropic/claude-sonnet-4-5"

describe("read-only agent tool restrictions", () => {
  const FILE_WRITE_TOOLS = ["write", "edit", "apply_patch"]

  describe("Oracle", () => {
    test("denies all file-writing tools", () => {
      // given
      const agent = createOracleAgent(TEST_MODEL)

      // when
      const permission = agent.permission as Record<string, string>

      // then
      for (const tool of FILE_WRITE_TOOLS) {
        expect(permission[tool]).toBe("deny")
      }
    })

    test("denies task but allows call_omo_agent for research", () => {
      // given
      const agent = createOracleAgent(TEST_MODEL)

      // when
      const permission = agent.permission as Record<string, string>

      // then
      expect(permission["task"]).toBe("deny")
      expect(permission["call_omo_agent"]).toBeUndefined()
    })
  })

  describe("Librarian", () => {
    test("denies all file-writing tools", () => {
      // given
      const agent = createLibrarianAgent(TEST_MODEL)

      // when
      const permission = agent.permission as Record<string, string>

      // then
      for (const tool of FILE_WRITE_TOOLS) {
        expect(permission[tool]).toBe("deny")
      }
    })
  })

  describe("Explore", () => {
    test("keeps file-writing tools blocked via wildcard-deny allowlist", () => {
      // given
      const agent = createExploreAgent(TEST_MODEL)

      // when
      const permission = agent.permission as Record<string, string>

      // then
      expect(permission["*"]).toBe("deny")
      for (const tool of FILE_WRITE_TOOLS) {
        expect(permission[tool] ?? permission["*"]).toBe("deny")
      }
    })

    test("allowlists only read-only code search tools", () => {
      //#given
      const agent = createExploreAgent(TEST_MODEL)

      //#when
      const permission = agent.permission as Record<string, string>

      //#then
      expect(permission).toMatchObject({
        "*": "deny",
        bash: "allow",
        read: "allow",
        grep: "allow",
        glob: "allow",
        ast_grep_search: "allow",
        lsp_definition: "allow",
        lsp_references: "allow",
        lsp_hover: "allow",
        lsp_symbols: "allow",
        lsp_diagnostics: "allow",
      })
      expect(permission["task"]).toBeUndefined()
      expect(permission["call_omo_agent"]).toBeUndefined()
      expect(permission["session_search"]).toBeUndefined()
      expect(permission["websearch_web_search_exa"]).toBeUndefined()
      expect(permission["context7_query-docs"]).toBeUndefined()
    })
  })

  describe("Momus", () => {
    test("denies all file-writing tools", () => {
      // given
      const agent = createMomusAgent(TEST_MODEL)

      // when
      const permission = agent.permission as Record<string, string>

      // then
      for (const tool of FILE_WRITE_TOOLS) {
        expect(permission[tool]).toBe("deny")
      }
    })
  })

  describe("Metis", () => {
    test("denies all file-writing tools", () => {
      // given
      const agent = createMetisAgent(TEST_MODEL)

      // when
      const permission = agent.permission as Record<string, string>

      // then
      for (const tool of FILE_WRITE_TOOLS) {
        expect(permission[tool]).toBe("deny")
      }
    })
  })

  describe("Atlas", () => {
    test("allows delegation tools for orchestration", () => {
      // given
      const agent = createAtlasAgent({ model: TEST_MODEL })

      // when
      const permission = (agent.permission ?? {}) as Record<string, string>

      // then
      expect(permission["task"]).toBeUndefined()
      expect(permission["call_omo_agent"]).toBeUndefined()
    })
  })
})
