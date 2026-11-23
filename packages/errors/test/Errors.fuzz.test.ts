import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  getSmithersErrorDefinition,
  hasSmithersErrorShape,
  isSmithersError,
  isSmithersErrorCode,
  SmithersError,
  smithersErrorCodes
} from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1500" : "250"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("@smthrs/errors fuzz invariants", () => {
  it("every registered error code builds a valid SmithersError with arbitrary messages and details", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        codeIdx: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: smithersErrorCodes.length - 1 })),
        message: Schema.String,
        detailKey: Schema.String,
        detailVal: Schema.Union([Schema.String, Schema.Int, Schema.Boolean, Schema.Null])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ codeIdx, message, detailKey, detailVal }) => {
          const code = smithersErrorCodes[codeIdx]!
          if (!isSmithersErrorCode(code)) return false
          const def = getSmithersErrorDefinition(code)
          if (def === undefined || def.when.length === 0) return false
          const err = new SmithersError(code, message || "summary", { [detailKey || "k"]: detailVal })
          return isSmithersError(err) && hasSmithersErrorShape(err) && err.code === code
        },
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("guards never crash on arbitrary unknown values", async () => {
    const arb = Arbitrary.schema(
      Schema.Union([Schema.Null, Schema.Boolean, Schema.Finite, Schema.String, Schema.Array(Schema.String)])
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (value) => !isSmithersError(value) && !hasSmithersErrorShape(value),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
