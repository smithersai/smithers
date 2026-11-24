/**
 * `renderDiagnostic` names each primitive a failure can carry without
 * coercing it through caller code. A non-finite number is rendered as a fixed
 * marker, and that marker must say which non-finite value it was: an operator
 * reading `NaN` as negative infinity chases the wrong arithmetic.
 */
import { describe, expect, it } from "@effect/vitest"
import { hostReflection, renderDiagnosticWith } from "../src/internal/Diagnostic.ts"

const renderDiagnostic = (value: unknown) => renderDiagnosticWith(hostReflection(process), value)

describe("renderDiagnostic primitives", () => {
  it("tells NaN apart from either infinity", () => {
    expect(renderDiagnostic(Number.NaN)).toBe("[NaN]")
    expect(renderDiagnostic(Number.POSITIVE_INFINITY)).toBe("[+non-finite number]")
    expect(renderDiagnostic(Number.NEGATIVE_INFINITY)).toBe("[-non-finite number]")
  })

  it("renders a NaN field of a failure as NaN", () => {
    expect(JSON.parse(renderDiagnostic({ _tag: "Overflow", value: Number.NaN }))).toEqual({
      _tag: "Overflow",
      value: "[NaN]"
    })
  })

  it("passes finite numbers and booleans through as JSON values", () => {
    expect(JSON.parse(renderDiagnostic({ code: 404, value: -0.5, error: false }))).toEqual({
      code: 404,
      value: -0.5,
      error: false
    })
  })
})
