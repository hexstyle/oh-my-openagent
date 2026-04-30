import { describe, expect, test } from "bun:test"
import { bambooCiSkill } from "./bamboo-ci"
import { ciGreenLoopSkill } from "./ci-green-loop"

describe("ci green loop builtin skills", () => {
  test("ci-green-loop template requires iteration ledger updates", () => {
    expect(ciGreenLoopSkill.template).toContain(".sisyphus/evidence/repair-log.md")
    expect(ciGreenLoopSkill.template).toContain("Iteration Ledger (MANDATORY)")
    expect(ciGreenLoopSkill.template).toContain("Coverage map:")
    expect(ciGreenLoopSkill.template).toContain("Code changed:")
    expect(ciGreenLoopSkill.template).toContain("Checkpoint MUST reference repair-log")
    expect(ciGreenLoopSkill.template).toContain("free-form narrative")
    expect(ciGreenLoopSkill.template).toContain("tracker files with status `fixed-pending`")
  })

  test("bamboo-ci template couples Bamboo fetches to repair-log updates", () => {
    expect(bambooCiSkill.template).toContain(".sisyphus/evidence/repair-log.md")
    expect(bambooCiSkill.template).toContain("Every Bamboo iteration must also update")
    expect(bambooCiSkill.template).toContain("build number + revision")
    expect(bambooCiSkill.template).toContain("changed-files coverage")
  })
})
