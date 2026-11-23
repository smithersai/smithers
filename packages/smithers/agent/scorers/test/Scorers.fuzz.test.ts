import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Checks, Sampling, ScoreGate } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "300"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const specialValues = [
  -1,
  -0.0001,
  0,
  0.25,
  0.5,
  1,
  1.0001,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY
] as const

describe("@smthrs/scorers ScoreGate, Sampling & Checks fuzz invariants", () => {
  it("ScoreGate.validateSamples accepts iff every numeric score is finite and in [0, 1]", async () => {
    const arb = Arbitrary.schema(
      Schema.Array(
        Schema.Struct({
          isScore: Schema.Boolean,
          useSpecial: Schema.Boolean,
          specialIdx: Schema.Int.pipe(
            Schema.check(Schema.isBetween({ minimum: 0, maximum: specialValues.length - 1 }))
          ),
          numVal: Schema.Number
        })
      ).pipe(Schema.check(Schema.isMaxLength(12)))
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (items) =>
          Effect.gen(function*() {
            const samples: Array<ScoreGate.ScoreSample> = items.map((item, i) => {
              const value = item.useSpecial ? specialValues[item.specialIdx]! : item.numVal
              return item.isScore
                ? { case: `c${i}`, stepKey: `s${i}`, scorer: "sc", kind: "score", value }
                : { case: `c${i}`, stepKey: `s${i}`, scorer: "sc", kind: "inconclusive", reason: "timeout" }
            })
            const res = yield* Effect.result(ScoreGate.validateSamples(samples))
            const allValid = samples.every(
              (s) => s.kind !== "score" || (Number.isFinite(s.value) && s.value >= 0 && s.value <= 1)
            )
            return Result.isSuccess(res) === allValid
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("ScoreGate.combine & grade preserve strict severity lattice: Failed(1) > Inconclusive/unresolved(5) > clean Passed(0)", async () => {
    const verdictArb = Schema.Union([
      Schema.Struct({
        _tag: Schema.Literal("Passed"),
        inconclusive: Schema.Array(Schema.Literals(["f1", "f2"])).pipe(Schema.check(Schema.isMaxLength(2)))
      }),
      Schema.Struct({
        _tag: Schema.Literal("Failed"),
        reasons: Schema.Array(Schema.Literals(["r1", "r2"])).pipe(Schema.check(Schema.isMaxLength(2))),
        inconclusive: Schema.Array(Schema.Literals(["f1"])).pipe(Schema.check(Schema.isMaxLength(1)))
      }),
      Schema.Struct({
        _tag: Schema.Literal("Inconclusive"),
        reasons: Schema.Array(Schema.Literals(["u1"])).pipe(Schema.check(Schema.isMaxLength(2)))
      })
    ])
    const arb = Arbitrary.schema(
      Schema.Struct({
        verdicts: Schema.Array(verdictArb).pipe(Schema.check(Schema.isMaxLength(8))),
        envFaults: Schema.Array(Schema.Literals(["env1", "env2"])).pipe(Schema.check(Schema.isMaxLength(2)))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ verdicts, envFaults }) =>
          Effect.sync(() => {
            const combined = ScoreGate.combine(verdicts, envFaults)
            const graded = ScoreGate.grade(combined)
            const hasFailed = verdicts.some((v) => v._tag === "Failed")
            const hasInc = verdicts.some((v) => v._tag === "Inconclusive") ||
              verdicts.some((v) => v._tag !== "Inconclusive" && v.inconclusive.length > 0) ||
              envFaults.length > 0

            if (hasFailed) {
              return combined._tag === "Failed" && combined.reasons.length > 0 && graded.exitCode === 1
            }
            if (hasInc) {
              return graded.exitCode === 5
            }
            return combined._tag === "Passed" && graded.exitCode === 0
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Sampling.decide is deterministic, respects all/none extremes, and Checks produce bounded scores", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        stepKey: Schema.String.pipe(Schema.check(Schema.isMaxLength(32))),
        scorerKey: Schema.String.pipe(Schema.check(Schema.isMaxLength(32))),
        seedStr: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(16))),
        ratio: Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: 0.01, maximum: 0.99 }))),
        text: Schema.String.pipe(Schema.check(Schema.isMaxLength(200)))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ stepKey, scorerKey, seedStr, ratio, text }) =>
          Effect.gen(function*() {
            if ((yield* Sampling.decide("all", stepKey, scorerKey)) !== true) return false
            if ((yield* Sampling.decide("none", stepKey, scorerKey)) !== false) return false
            const d1 = yield* Sampling.decide({ ratio, seed: seedStr }, stepKey, scorerKey)
            const d2 = yield* Sampling.decide({ ratio, seed: seedStr }, stepKey, scorerKey)
            if (d1 !== d2) return false
            const summary = Checks.all([
              Checks.length(text, { min: 0, max: 100 }),
              Checks.excludes(text, ["FORBIDDEN_SECRET"]),
              Checks.truncated(text)
            ])
            if (summary.score < 0 || summary.score > 1 || !Number.isFinite(summary.score)) return false
            return true
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
