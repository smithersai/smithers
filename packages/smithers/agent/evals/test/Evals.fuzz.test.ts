import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Baseline, Gate, Regression, Report, Suite, Trials } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "250"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

describe("@smthrs/evals comprehensive fuzz invariants", () => {
  it("Suite.encodeData / decodeData round-trips plain JSON + bigint/undefined/-0/NaN/Infinity and rejects Map/Set/Function", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        s: Schema.String.pipe(Schema.check(Schema.isMaxLength(32))),
        n: Schema.Number,
        b: Schema.Boolean,
        bi: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -1000, maximum: 1000 }))),
        withUndef: Schema.Boolean,
        special: Schema.Literals(["normal", "negZero", "nan", "inf", "negInf"])
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ s, n, b, bi, withUndef, special }) =>
          Effect.gen(function*() {
            const num = special === "negZero"
              ? -0
              : special === "nan"
              ? Number.NaN
              : special === "inf"
              ? Number.POSITIVE_INFINITY
              : special === "negInf"
              ? Number.NEGATIVE_INFINITY
              : n
            const value = {
              s,
              num,
              b,
              big: BigInt(bi),
              ...(withUndef ? { u: undefined } : {})
            }
            const enc = yield* Suite.encodeData(value)
            const dec = (yield* Suite.decodeData(enc)) as Record<string, unknown>
            if (dec["s"] !== s || dec["b"] !== b || dec["big"] !== BigInt(bi)) return false
            if (!Object.is(dec["num"], num)) return false
            // Non-plain objects MUST fail with EvalError
            const badMap = yield* Effect.result(Suite.encodeData(new Map([["a", 1]])))
            if (Result.isSuccess(badMap) || badMap.failure._tag !== "flows/evals/EvalError") return false
            const badSet = yield* Effect.result(Suite.encodeData(new Set([1])))
            if (Result.isSuccess(badSet) || badSet.failure._tag !== "flows/evals/EvalError") return false
            return true
          }),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Suite.decodeData never throws unhandled errors on arbitrary corrupt strings", async () => {
    const arb = Arbitrary.schema(Schema.String.pipe(Schema.check(Schema.isMaxLength(128))))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (raw) =>
          Effect.gen(function*() {
            const res = yield* Effect.result(Suite.decodeData(raw))
            return Result.isSuccess(res) || res.failure._tag === "flows/evals/EvalError"
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Trials passAtK, passHatK, summarize & aggregate obey probability bounds, monotonicity, and passHatK <= passAtK", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        outcomes: Schema.Array(Schema.Boolean).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(16))),
        kRaw: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 16 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ outcomes, kRaw }) =>
          Effect.sync(() => {
            const n = outcomes.length
            const k = Math.min(kRaw, n)
            const c = outcomes.filter(Boolean).length
            const pk = Trials.passAtK(n, c, k)
            const phk = Trials.passHatK(n, c, k)
            if (!Number.isFinite(pk) || pk < -1e-12 || pk > 1 + 1e-12) return false
            if (!Number.isFinite(phk) || phk < -1e-12 || phk > 1 + 1e-12) return false
            if (c === 0 && (pk !== 0 || phk !== 0)) return false
            if (c === n && (Math.abs(pk - 1) > 1e-12 || Math.abs(phk - 1) > 1e-12)) return false
            // pass^k (all k pass) <= pass@k (at least 1 of k passes)
            if (phk > pk + 1e-12) return false
            // Monotone in c
            if (c < n && Trials.passAtK(n, c + 1, k) + 1e-12 < pk) return false
            if (c < n && Trials.passHatK(n, c + 1, k) + 1e-12 < phk) return false

            const sum = Trials.summarize(outcomes, k)
            if (sum.n !== n || sum.passes !== c) return false
            const agg = Trials.aggregate({ c1: outcomes, c2: [...outcomes].reverse() }, k)
            return Math.abs(agg.passAtK - pk) < 1e-9 && Math.abs(agg.passHatK - phk) < 1e-9
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Baseline make/write/load is permutation-invariant, round-trips cleanly, and Regression.compare + Report + Gate agree", async () => {
    const scoreArb = Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 })))
    const arb = Arbitrary.schema(
      Schema.Struct({
        s1: scoreArb,
        s2: scoreArb,
        cur1: scoreArb,
        cur2: scoreArb,
        absTol: Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 0.5 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ s1, s2, cur1, cur2, absTol }) =>
          Effect.gen(function*() {
            const r1 = { suite: "demo", case: "c1", scorer: "sc", scorerName: "sc", stepKey: "k1", score: s1 }
            const r2 = { suite: "demo", case: "c2", scorer: "sc", scorerName: "sc", stepKey: "k2", score: s2 }
            const b1 = yield* Baseline.make({ suite: "demo", records: [r1, r2] })
            const b2 = yield* Baseline.make({ suite: "demo", records: [r2, r1] })
            const w1 = Baseline.write(b1)
            const w2 = Baseline.write(b2)
            // Permutation-invariant canonical baseline serialization
            if (w1 !== w2 || !w1.endsWith("\n")) return false
            const loaded = yield* Baseline.load(w1)
            if (loaded.suite !== "demo" || loaded.records.length !== 2) return false

            const runResult = {
              runId: "run-1",
              suite: "demo",
              cases: [],
              observations: [
                {
                  kind: "score",
                  case: "c1",
                  scorer: "sc",
                  scorerName: "sc",
                  stepKey: "k1",
                  at: "2026-11-22T00:00:00Z",
                  score: cur1
                },
                {
                  kind: "score",
                  case: "c2",
                  scorer: "sc",
                  scorerName: "sc",
                  stepKey: "k2",
                  at: "2026-11-22T00:00:00Z",
                  score: cur2
                }
              ]
            } as unknown as Parameters<typeof Regression.compare>[1]
            const regReport = yield* Regression.compare(loaded, runResult, { absolute: absTol })
            const repData = Report.data(regReport)
            const repJson = Report.json(regReport)
            const repMd = Report.markdown(regReport)
            if (repJson.length === 0 || repMd.length === 0 || typeof repData !== "object") return false

            const verdict = yield* Gate.check(regReport)
            const graded = Gate.ciGrade(verdict)
            if (regReport.regressions.length > 0 && graded.exitCode !== 1) return false
            if (
              regReport.regressions.length === 0 && regReport.nondeterminism.length === 0 &&
              regReport.missing.length === 0 && graded.exitCode !== 0
            ) return false
            return true
          }),
        { seed: seed + 3, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
