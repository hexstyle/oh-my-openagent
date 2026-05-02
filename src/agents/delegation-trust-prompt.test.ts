import { describe, expect, test } from "bun:test"
import { createSisyphusAgent } from "./sisyphus"
import { createHephaestusAgent } from "./hephaestus"
import { buildSisyphusJuniorPrompt } from "./sisyphus-junior/agent"
import {
  buildAntiDuplicationSection,
  buildExploreSection,
  type AvailableAgent,
} from "./dynamic-agent-prompt-builder"

const exploreAgent = {
  name: "explore",
  description: "Contextual grep specialist",
  metadata: {
    category: "advisor",
    cost: "FREE",
    promptAlias: "Explore",
    triggers: [],
    useWhen: ["Multiple search angles needed"],
    avoidWhen: ["Single keyword search is enough"],
  },
} satisfies AvailableAgent

describe("delegation trust prompt rules", () => {
  test("buildAntiDuplicationSection explains overlap is forbidden", () => {
    // given
    const section = buildAntiDuplicationSection()

    // when / then
    expect(section).toContain("DO NOT perform the same search yourself")
    expect(section).toContain("non-overlapping work")
    expect(section).toContain("End your response")
  })

  test("buildExploreSection includes delegation trust rule", () => {
    // given
    const agents = [exploreAgent]

    // when
    const section = buildExploreSection(agents)

    // then
    expect(section).toContain("Delegation Trust Rule")
    expect(section).toContain("do **not** manually perform that same search yourself")
  })

  test("Sisyphus prompt forbids duplicate delegated exploration", () => {
    // given
    const agent = createSisyphusAgent("anthropic/claude-sonnet-4-6", [exploreAgent])

    // when
    const prompt = agent.prompt

    // then
    expect(prompt).toContain("Continue only with non-overlapping work")
    expect(prompt).toContain("DO NOT perform the same search yourself")
  })

  test("Hephaestus prompt forbids duplicate delegated exploration", () => {
    // given
    const agent = createHephaestusAgent("openai/gpt-5.2", [exploreAgent])

    // when
    const prompt = agent.prompt

    // then
    expect(prompt).toContain("Continue only with non-overlapping work after launching background agents")
    expect(prompt).toContain("DO NOT perform the same search yourself")
  })

  test("Hephaestus GPT-5.4 prompt forbids duplicate delegated exploration", () => {
    // given
    const agent = createHephaestusAgent("openai/gpt-5.4", [exploreAgent])

    // when
    const prompt = agent.prompt

    // then
    expect(prompt).toContain("continue only with non-overlapping work while they search")
    expect(prompt).toContain("Continue only with non-overlapping work after launching background agents")
    expect(prompt).toContain("DO NOT perform the same search yourself")
  })

  test("Hephaestus GPT-5.3 Codex prompt forbids duplicate delegated exploration", () => {
    // given
    const agent = createHephaestusAgent("openai/gpt-5.3-codex", [exploreAgent])

    // when
    const prompt = agent.prompt

    // then
    expect(prompt).toContain("continue only with non-overlapping work while they search")
    expect(prompt).toContain("Continue only with non-overlapping work after launching background agents")
    expect(prompt).toContain("DO NOT perform the same search yourself")
  })

  test("Sisyphus-Junior GPT prompt forbids duplicate delegated exploration", () => {
    // given
    const prompt = buildSisyphusJuniorPrompt("openai/gpt-5.2", false)

    // when / then
    expect(prompt).toContain("continue only with non-overlapping work while they search")
    expect(prompt).toContain("DO NOT perform the same search yourself")
  })

  test("Sisyphus GPT-5.4 prompt forbids duplicate delegated exploration", () => {
    // given
    const agent = createSisyphusAgent("openai/gpt-5.4", [exploreAgent])

    // when
    const prompt = agent.prompt

    // then
    expect(prompt).toContain("do only non-overlapping work simultaneously")
    expect(prompt).toContain("Continue only with non-overlapping work")
    expect(prompt).toContain("DO NOT perform the same search yourself")
  })

  test("Sisyphus GPT-5.4 prompt adds evidence-gated CI delegation override", () => {
    const agent = createSisyphusAgent("openai/gpt-5.4", [exploreAgent])
    const prompt = agent.prompt

    expect(prompt).toContain("evidence-gated CI mode")
    expect(prompt).toContain("background delegation is FORBIDDEN")
    expect(prompt).toContain("Launch at most ONE background research agent at a time")
    expect(prompt).toContain("STOP researching and start the edit batch immediately")
    expect(prompt).toContain("Do NOT open a second-wave adjacent-code audit")
    expect(prompt).toContain("maximum discovery budget after the evidence pass")
    expect(prompt).toContain("do NOT queue Oracle consultation")
    expect(prompt).toContain("keep tasks/todos on the critical path only")
    expect(prompt).toContain("those files are the first edit batch")
    expect(prompt).toContain("editing is mandatory in the same turn")
    expect(prompt).toContain("one failing test method slice")
    expect(prompt).toContain("must stop reading and write the expanded edit batch immediately")
    expect(prompt).toContain("Oracle/post-implementation review is optional")
    expect(prompt).toContain("Do not poll, do not idle")
  })

  test("Sisyphus-Junior GPT-5.4 prompt forbids duplicate delegated exploration", () => {
    // given
    const prompt = buildSisyphusJuniorPrompt("openai/gpt-5.4", false)

    // when / then
    expect(prompt).toContain("continue only with non-overlapping work while they search")
    expect(prompt).toContain("DO NOT perform the same search yourself")
  })

  test("Sisyphus-Junior GPT-5.3 Codex prompt forbids duplicate delegated exploration", () => {
    // given
    const prompt = buildSisyphusJuniorPrompt("openai/gpt-5.3-codex", false)

    // when / then
    expect(prompt).toContain("continue only with non-overlapping work while they search")
    expect(prompt).toContain("DO NOT perform the same search yourself")
  })

  test("Sisyphus-Junior Gemini prompt forbids duplicate delegated exploration", () => {
    // given
    const prompt = buildSisyphusJuniorPrompt("google/gemini-3.1-pro", false)

    // when / then
    expect(prompt).toContain("continue only with non-overlapping work while they search")
    expect(prompt).toContain("DO NOT perform the same search yourself")
  })
})
