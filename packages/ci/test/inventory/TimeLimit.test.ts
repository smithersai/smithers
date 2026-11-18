import { describe, expect, it } from "vitest"
import { type Context, fields, type Scope, unknown, value, variable } from "../../src/inventory/Expression.ts"
import { readLimit, secondsOf, within } from "../../src/inventory/TimeLimit.ts"

const contexts: Record<string, Context> = {
  inputs: fields((name) => ({ minutes: value(45), label: value("45") })[name]),
  matrix: fields((name) => name === "minutes" ? variable("matrix:minutes", "matrix.minutes", false, true) : undefined),
  secrets: fields((name) => ({ kind: "secret", name }), true),
  needs: unknown("what another job gave is known only while the run goes")
}
const scope: Scope = { context: (name) => contexts[name] }

// "Workflow syntax for GitHub Actions": `jobs.<job_id>.timeout-minutes` is "the maximum number of minutes to let a
// job run before GitHub automatically cancels it", and `jobs.<job_id>.steps[*].timeout-minutes` is "the maximum
// number of minutes to run the step before killing the process. Fractional values are not supported.
// `timeout-minutes` must be a positive integer."
describe("readLimit", () => {
  it("gives no limit when the key is absent", () => {
    expect(readLimit(undefined, scope)).toEqual({ minutes: undefined })
  })

  it.each<[string, unknown, number]>([
    ["a whole number", 10, 10],
    ["an expression that is a number", "${{ 30 }}", 30],
    ["an expression over what is known before the run", "${{ inputs.minutes }}", 45],
    ["an expression that works a number out", "${{ fromJSON('[5, 15]')[1] }}", 15]
  ])("reads %s as that many minutes", (_name, raw, minutes) => {
    expect(readLimit(raw, scope)).toEqual({ minutes })
  })

  it.each<[string, unknown, string]>([
    ["a fraction", 1.5, "1.5 is not a positive whole number"],
    ["zero", 0, "0 is not a positive whole number"],
    ["a negative number", -5, "-5 is not a positive whole number"],
    ["a number too large to count", 2 ** 60, "is not a positive whole number"],
    ["no value", null, "a value that is not a number is not a positive whole number"],
    ["a boolean", true, "a value that is not a number is not a positive whole number"],
    ["text", "10", "text is not a number of minutes"],
    ["text around an expression", "1${{ 0 }}", "text is not a number of minutes"],
    [
      "an expression that is text",
      "${{ inputs.label }}",
      "a value that is not a number is not a positive whole number"
    ],
    ["an expression that is a fraction", "${{ 2.5 }}", "2.5 is not a positive whole number"],
    ["a matrix value", "${{ matrix.minutes }}", "matrix.minutes is decided while the job runs"],
    ["a secret", "${{ secrets.LIMIT }}", "it comes from secret LIMIT"],
    ["what another job gave", "${{ needs.plan.outputs.minutes }}", "known only while the run goes"],
    ["an expression that cannot be read", "${{ 1 + }}", "1 +"]
  ])("refuses %s", (_name, raw, problem) => {
    const read = readLimit(raw, scope)
    expect("problem" in read ? read.problem : read).toContain(problem)
  })
})

describe("within", () => {
  it("gives the smaller of two limits, or the one that is set", () => {
    expect(within(undefined, undefined)).toBeUndefined()
    expect(within(20, undefined)).toBe(20)
    expect(within(undefined, 3)).toBe(3)
    expect(within(20, 3)).toBe(3)
    expect(within(20, 30)).toBe(20)
  })
})

describe("secondsOf", () => {
  // Any step is stopped after six hours, here as on GitHub's own machines, so a longer limit is none.
  it("gives the limit in seconds, and none for a limit of six hours or more", () => {
    expect(secondsOf(undefined)).toBeUndefined()
    expect(secondsOf(1)).toBe(60)
    expect(secondsOf(359)).toBe(21_540)
    expect(secondsOf(360)).toBeUndefined()
    expect(secondsOf(Number.MAX_SAFE_INTEGER)).toBeUndefined()
  })
})
