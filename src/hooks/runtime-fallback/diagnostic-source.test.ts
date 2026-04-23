import { describe, expect, test } from "bun:test"

import { appendDiagnosticSourceSegment, compactDiagnosticSource } from "./diagnostic-source"

describe("runtime-fallback diagnostic source", () => {
  test("collapses repeated Prometheus timeout promotion cycles", () => {
    const source = compactDiagnosticSource(
      "message.part.updated.progress.timeout.prometheus-plan-promotion.timeout.prometheus-plan-promotion.timeout.prometheus-plan-promotion",
    )

    expect(source).toBe("message.part.updated.progress.timeout.prometheus-plan-promotion")
  })

  test("keeps only a bounded number of segments for long diagnostic chains", () => {
    const source = compactDiagnosticSource(
      "a.b.c.d.e.f.g.h.i.j.k.l.m.n.o.p",
    )

    expect(source).toBe("a.b.c.d.....j.k.l.m.n.o.p")
  })

  test("append helper does not keep extending the same timeout promotion suffix forever", () => {
    const once = appendDiagnosticSourceSegment("message.part.updated.progress.timeout", "prometheus-plan-promotion")
    const twice = appendDiagnosticSourceSegment(once, "timeout")
    const thrice = appendDiagnosticSourceSegment(twice, "prometheus-plan-promotion")

    expect(once).toBe("message.part.updated.progress.timeout.prometheus-plan-promotion")
    expect(twice).toBe("message.part.updated.progress.timeout.prometheus-plan-promotion")
    expect(thrice).toBe("message.part.updated.progress.timeout.prometheus-plan-promotion")
  })
})
