import { describe, expect, it } from "bun:test"

import {
  buildManagedConfigWorkspacePackage,
  getManagedConfigSchemaDependencySpec,
} from "./managed-opencode-runtime"

describe("managed opencode runtime helpers", () => {
  it("pins the config workspace schema dependency to the local repo and removes the legacy alias", () => {
    const repoRoot = "/tmp/oh-my-openagent"

    const nextPackage = buildManagedConfigWorkspacePackage(
      {
        name: "opencode-config-workspace",
        dependencies: {
          "@opencode-ai/plugin": "1.4.0",
          "oh-my-opencode": "file:///tmp/legacy",
        },
      },
      repoRoot,
    )

    expect(nextPackage).toEqual({
      name: "opencode-config-workspace",
      dependencies: {
        "@opencode-ai/plugin": "1.4.0",
        "oh-my-openagent": getManagedConfigSchemaDependencySpec(repoRoot),
      },
    })
  })
})
