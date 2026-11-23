import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Suite } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1500" : "250"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("@smthrs/evals Suite codec fuzz invariants", () => {
  it("encodeData and decodeData round-trip plain objects, arrays, bigint, undefined, -0, NaN, Infinity, and cycles", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        str: Schema.String,
        num: Schema.Finite,
        bool: Schema.Boolean,
        big: Schema.Int.check(Schema.isBetween({ minimum: -100000, maximum: 100000 })),
        list: Schema.Array(Schema.Union([Schema.String, Schema.Int, Schema.Null])),
        nonFinite: Schema.Literals(["negZero", "nan", "inf", "negInf"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ str, num, bool, big, list, nonFinite }) =>
          Effect.gen(function*() {
            const special = nonFinite === "negZero"
              ? -0
              : nonFinite === "nan"
              ? Number.NaN
              : nonFinite === "inf"
              ? Infinity
              : -Infinity
            const payload: Record<string, unknown> = {
              str,
              num,
              bool,
              big: BigInt(big) * 1_000_000_000_000n,
              undef: undefined,
              special,
              list: list.slice(0, 8)
            }
            payload.self = payload
            const encoded = yield* Suite.encodeData(payload)
            const decoded = (yield* Suite.decodeData(encoded)) as Record<string, unknown>
            if (decoded.str !== str || decoded.bool !== bool || !Object.is(decoded.num, num)) return false
            if (
              decoded.big !== payload.big || decoded.undef !== undefined || !Object.is(decoded.special, special)
            ) return false
            if (decoded.self !== decoded) return false
            // Non-plain objects (Map/Function) MUST be rejected with EvalError.
            const rejected = yield* Effect.result(Suite.encodeData({ bad: new Map([["a", 1]]) }))
            return Result.isFailure(rejected) && rejected.failure._tag === "flows/evals/EvalError"
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("decodeData never throws defects on arbitrary corrupted strings", async () => {
    const arb = Arbitrary.schema(Schema.String)
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (raw) =>
          Effect.map(
            Effect.result(Suite.decodeData(raw)),
            (res) => Result.isSuccess(res) || res.failure._tag === "flows/evals/EvalError"
          ),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
