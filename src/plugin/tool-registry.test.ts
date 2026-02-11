/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test"
import { createToolRegistry } from "./tool-registry"
import type { OhMyOpenCodeConfig } from "../config/schema"

describe("team system tool registration", () => {
  test("registers team tools when experimental.team_system is true", () => {
    const pluginConfig = {
      experimental: { team_system: true },
    } as unknown as OhMyOpenCodeConfig

    const result = createToolRegistry({
      ctx: {} as any,
      pluginConfig,
      managers: {} as any,
      skillContext: {} as any,
      availableCategories: [],
    })

    expect(Object.keys(result.filteredTools)).toContain("team_create")
    expect(Object.keys(result.filteredTools)).toContain("team_delete")
    expect(Object.keys(result.filteredTools)).toContain("send_message")
    expect(Object.keys(result.filteredTools)).toContain("read_inbox")
    expect(Object.keys(result.filteredTools)).toContain("read_config")
    expect(Object.keys(result.filteredTools)).toContain("force_kill_teammate")
    expect(Object.keys(result.filteredTools)).toContain("process_shutdown_approved")
  })

  test("does not register team tools when experimental.team_system is false", () => {
    const pluginConfig = {
      experimental: { team_system: false },
    } as unknown as OhMyOpenCodeConfig

    const result = createToolRegistry({
      ctx: {} as any,
      pluginConfig,
      managers: {} as any,
      skillContext: {} as any,
      availableCategories: [],
    })

    expect(Object.keys(result.filteredTools)).not.toContain("team_create")
    expect(Object.keys(result.filteredTools)).not.toContain("team_delete")
    expect(Object.keys(result.filteredTools)).not.toContain("send_message")
    expect(Object.keys(result.filteredTools)).not.toContain("read_inbox")
    expect(Object.keys(result.filteredTools)).not.toContain("read_config")
    expect(Object.keys(result.filteredTools)).not.toContain("force_kill_teammate")
    expect(Object.keys(result.filteredTools)).not.toContain("process_shutdown_approved")
  })

  test("does not register team tools when experimental.team_system is undefined", () => {
    const pluginConfig = {
      experimental: {},
    } as unknown as OhMyOpenCodeConfig

    const result = createToolRegistry({
      ctx: {} as any,
      pluginConfig,
      managers: {} as any,
      skillContext: {} as any,
      availableCategories: [],
    })

    expect(Object.keys(result.filteredTools)).not.toContain("team_create")
    expect(Object.keys(result.filteredTools)).not.toContain("team_delete")
    expect(Object.keys(result.filteredTools)).not.toContain("send_message")
    expect(Object.keys(result.filteredTools)).not.toContain("read_inbox")
    expect(Object.keys(result.filteredTools)).not.toContain("read_config")
    expect(Object.keys(result.filteredTools)).not.toContain("force_kill_teammate")
    expect(Object.keys(result.filteredTools)).not.toContain("process_shutdown_approved")
  })
})
