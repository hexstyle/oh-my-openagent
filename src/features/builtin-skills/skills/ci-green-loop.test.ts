import { describe, expect, test } from "bun:test"
import { bambooCiSkill } from "./bamboo-ci"
import { ciGreenLoopSkill } from "./ci-green-loop"

describe("ci green loop builtin skills", () => {
  test("ci-green-loop template requires iteration ledger updates", () => {
    expect(ciGreenLoopSkill.template).toContain(".sisyphus/evidence/repair-log.md")
    expect(ciGreenLoopSkill.template).toContain("Iteration Ledger (MANDATORY)")
    expect(ciGreenLoopSkill.template).toContain("Coverage map:")
    expect(ciGreenLoopSkill.template).toContain("Code changed:")
    expect(ciGreenLoopSkill.template).toContain("Per-test ledger:")
    expect(ciGreenLoopSkill.template).toContain("Checkpoint MUST reference repair-log")
    expect(ciGreenLoopSkill.template).toContain("free-form narrative")
    expect(ciGreenLoopSkill.template).toContain("tracker files with status `fixed-pending`")
    expect(ciGreenLoopSkill.template).toContain("Managed .sisyphus repo fast-path (STRICT)")
    expect(ciGreenLoopSkill.template).toContain("Missing tracker directory is a blocker for code edits")
    expect(ciGreenLoopSkill.template).toContain("If any of those checks fail, DO NOT skip steps (b)-(f)")
    expect(ciGreenLoopSkill.template).toContain("one shared file/helper")
    expect(ciGreenLoopSkill.template).toContain("MATERIALIZE EVIDENCE NOW (hard gate)")
    expect(ciGreenLoopSkill.template).toContain("BEFORE any source-code reads outside `.sisyphus/evidence/`")
  })

  test("bamboo-ci template couples Bamboo fetches to repair-log updates", () => {
    expect(bambooCiSkill.template).toContain(".sisyphus/evidence/repair-log.md")
    expect(bambooCiSkill.template).toContain("Every Bamboo iteration must also update")
    expect(bambooCiSkill.template).toContain("build number + revision")
    expect(bambooCiSkill.template).toContain("changed-files coverage")
  })

  test("bamboo-ci template teaches certificate fallback for read-only monitoring", () => {
    expect(bambooCiSkill.template).toContain("curl --insecure")
    expect(bambooCiSkill.template).toContain("Corporate TLS is not a terminal blocker")
    expect(bambooCiSkill.template).toContain("Do NOT stop after a successful push")
    expect(bambooCiSkill.template).toContain("python3 <<'PY'")
    expect(bambooCiSkill.template).toContain("Do NOT build giant one-line commands with nested quotes")
  })

  test("ci-green-loop treats Bamboo certificate errors as monitoring fallback, not push failure", () => {
    expect(ciGreenLoopSkill.template).toContain("retry those READ-ONLY fetches with `curl --insecure`")
    expect(ciGreenLoopSkill.template).toContain("That is a CI observation TLS issue, not a push failure")
  })

  test("ci-green-loop evidence eviction preserves repair-log and checkpoint", () => {
    expect(ciGreenLoopSkill.template).toContain('! -name "repair-log.md" ! -name "ci-loop-checkpoint.md"')
    expect(ciGreenLoopSkill.template).toContain("Never delete them just because they exceed 10KB")
    expect(ciGreenLoopSkill.template).toContain("keep test tracker files, repair-log.md, ci-loop-checkpoint.md")
  })
})
