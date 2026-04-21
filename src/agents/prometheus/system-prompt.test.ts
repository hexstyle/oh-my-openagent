import { describe, it, expect } from "bun:test"
import { getPrometheusPrompt } from "./system-prompt"

describe("getPrometheusPrompt", () => {
  describe("#given question tool is not disabled", () => {
    describe("#when generating prompt", () => {
      it("#then should include Question tool references", () => {
        const prompt = getPrometheusPrompt(undefined, [])

        expect(prompt).toContain("Question({")
      })
    })
  })

  describe("#given question tool is disabled via disabled_tools", () => {
    describe("#when generating prompt", () => {
      it("#then should strip Question tool code examples", () => {
        const prompt = getPrometheusPrompt(undefined, ["question"])

        expect(prompt).not.toContain("Question({")
      })
    })

    describe("#when disabled_tools includes question among other tools", () => {
      it("#then should strip Question tool code examples", () => {
        const prompt = getPrometheusPrompt(undefined, ["todowrite", "question", "interactive_bash"])

        expect(prompt).not.toContain("Question({")
      })
    })
  })

  describe("#given no disabled_tools provided", () => {
    describe("#when generating prompt with undefined", () => {
      it("#then should include Question tool references", () => {
        const prompt = getPrometheusPrompt(undefined, undefined)

        expect(prompt).toContain("Question({")
      })
    })
  })

  describe("draft-first final write protocol", () => {
    it("uses the safer single-final-write protocol for the default prompt", () => {
      const prompt = getPrometheusPrompt(undefined, [])

      expect(prompt).toContain("ONE final Write")
      expect(prompt).toContain("cp .sisyphus/drafts/{name}.md .sisyphus/plans/{name}.md")
      expect(prompt).toContain("## TODOs` is not empty")
      expect(prompt).toContain("already exists but still begins with `# Draft:`")
      expect(prompt).toContain("treat it as a broken partial artifact")
      expect(prompt).not.toContain("multiple Edits")
      expect(prompt).not.toContain("Edit-append tasks in batches")
    })

    it("uses the safer single-final-write protocol for GPT prompts", () => {
      const prompt = getPrometheusPrompt("openai/gpt-5.4", [])

      expect(prompt).toContain("ONE final Write")
      expect(prompt).toContain("cp .sisyphus/drafts/{name}.md .sisyphus/plans/{name}.md")
      expect(prompt).toContain("Do NOT emit a Write call with an empty or placeholder payload.")
      expect(prompt).toContain("Do NOT use repeated Edit-append calls for large TODO sections.")
      expect(prompt).toContain("already exists but still begins with `# Draft:`")
      expect(prompt).toContain("Repair the draft and promote it again")
      expect(prompt).not.toContain("multiple Edits")
    })

    it("uses the safer single-final-write protocol for Gemini prompts", () => {
      const prompt = getPrometheusPrompt("google/gemini-2.5-pro", [])

      expect(prompt).toContain("one final Write")
      expect(prompt).toContain("cp .sisyphus/drafts/{name}.md .sisyphus/plans/{name}.md")
      expect(prompt).toContain("Do NOT emit a Write call with an empty or placeholder payload.")
      expect(prompt).toContain("Do NOT use repeated Edit-append calls for large TODO sections.")
      expect(prompt).toContain("already exists but still begins with `# Draft:`")
      expect(prompt).toContain("Repair the draft and promote it again")
      expect(prompt).not.toContain("multiple Edits")
    })
  })

  describe("conditional Metis review", () => {
    it("does not require mandatory Metis consultation in the default prompt", () => {
      const prompt = getPrometheusPrompt(undefined, [])

      expect(prompt).toContain("Run final gap audit")
      expect(prompt).toContain("consult Metis only if needed")
      expect(prompt).toContain("generate the plan directly")
      expect(prompt).not.toContain("Consult Metis for gap analysis (auto-proceed)")
      expect(prompt).not.toContain("## Pre-Generation: Metis Consultation (MANDATORY)")
      expect(prompt).not.toContain("Summon Metis (auto)")
    })

    it("keeps Metis optional for GPT prompts", () => {
      const prompt = getPrometheusPrompt("openai/gpt-5.4", [])

      expect(prompt).toContain("conditional Metis review")
      expect(prompt).toContain("Consult Metis only if at least one is true")
      expect(prompt).toContain("If none of those are true, skip Metis and generate the plan immediately.")
      expect(prompt).not.toContain("### Step 2: Consult Metis (MANDATORY)")
      expect(prompt).not.toContain("Skip Metis consultation before plan generation")
    })

    it("keeps Metis optional for Gemini prompts", () => {
      const prompt = getPrometheusPrompt("google/gemini-2.5-pro", [])

      expect(prompt).toContain("conditional Metis review")
      expect(prompt).toContain("Consult Metis only if at least one is true")
      expect(prompt).toContain("If none of those are true, skip Metis and generate the plan immediately.")
      expect(prompt).not.toContain("### Step 2: Consult Metis (MANDATORY)")
      expect(prompt).not.toContain("Skip Metis consultation before plan generation")
    })
  })

  describe("plan-write focus rule", () => {
    it("keeps Claude prompts focused on finishing the final plan instead of reopening discovery", () => {
      const prompt = getPrometheusPrompt(undefined, [])

      expect(prompt).toContain("Once the \"Generate ... plan\" todo is `in_progress`")
      expect(prompt).toContain("Explore/Librarian/Oracle/background task waves during `plan-2`")
      expect(prompt).toContain("checking sibling or hotfix worktrees unless the user explicitly asked for that exact worktree")
      expect(prompt).toContain("write the final `.sisyphus/plans/{name}.md`")
    })
  })
})
