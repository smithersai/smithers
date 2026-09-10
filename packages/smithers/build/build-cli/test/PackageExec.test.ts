/**
 * `PackageExec.run` narrows its result by the `plan` option: a literal
 * `true` yields the inert `PlanReport`, an omitted or literal `false` plan
 * yields the executor `Summary`, and only a runtime `boolean` keeps the
 * union. Callers that already chose then use `Summary.ok` without an
 * assertion. Compile-time only: tsconfig.test.json is the gate.
 */
import { describe, expectTypeOf, it } from "vitest"
import type * as Executor from "../src/Executor.ts"
import * as PackageExec from "../src/PackageExec.ts"

type Base = Omit<PackageExec.RunOptions, "plan">

// Never called: only the call signatures are under test.
const planned = (base: Base) => PackageExec.run({ ...base, plan: true })
const omitted = (base: Base) => PackageExec.run(base)
const declined = (base: Base) => PackageExec.run({ ...base, plan: false })
const undecided = (base: Base, flag: boolean) => PackageExec.run({ ...base, plan: flag })

describe("PackageExec.run result narrowing", () => {
  it("a literal true plan yields the plan report", () => {
    expectTypeOf(planned).returns.resolves.toEqualTypeOf<PackageExec.PlanReport>()
  })

  it("an omitted or literal false plan yields the executor summary", () => {
    expectTypeOf(omitted).returns.resolves.toEqualTypeOf<Executor.Summary>()
    expectTypeOf(declined).returns.resolves.toEqualTypeOf<Executor.Summary>()
  })

  it("a runtime boolean plan keeps the union", () => {
    expectTypeOf(undecided).returns.resolves.toEqualTypeOf<Executor.Summary | PackageExec.PlanReport>()
  })
})
