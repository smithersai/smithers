import { Fuzz } from "@smthrs/fuzz"
import * as Binding from "@smthrs/scorers/Binding"
import type * as Sampling from "@smthrs/scorers/Sampling"
import * as Scorer from "@smthrs/scorers/Scorer"
import { ScorerError } from "@smthrs/scorers/ScorerError"
import * as ScorerRunner from "@smthrs/scorers/Scoring"
import { Arbitrary, Effect, Layer, Logger, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Baseline, CaseExecutor, EvalError, Gate, Regression, Report, Runner, Suite, Trials } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "250"))
const fastExecutions = Math.min(executions, 40)
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")
const silentLogger = Logger.layer([])

const target = { name: "eval-target" } as const
const otherTarget = { name: "other-target" } as const

const exactScorer = Scorer.make({
  id: "packages/smithers/agent/evals/test/fuzz/exact",
  version: "1",
  name: "exact",
  score: ({ output, groundTruth }) =>
    Effect.succeed({
      score: Object.is(output, groundTruth ?? output) ? 1 : 0,
      reason: "exact match"
    })
})

const flakyScorer = Scorer.make({
  id: "packages/smithers/agent/evals/test/fuzz/flaky",
  version: "1",
  name: "flaky",
  score: ({ output }) =>
    output === "fail-scorer"
      ? Effect.fail(new ScorerError({ code: "store", message: "scorer failed" }))
      : output === "die-scorer"
      ? Effect.die(new Error("scorer boom"))
      : Effect.succeed({ score: typeof output === "number" ? Math.max(0, Math.min(1, output)) : 0.75 })
})

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
            const badMap = yield* Effect.result(Suite.encodeData(new Map([["a", 1]])))
            if (Result.isSuccess(badMap) || badMap.failure._tag !== "flows/evals/EvalError") return false
            const badSet = yield* Effect.result(Suite.encodeData(new Set([1])))
            if (Result.isSuccess(badSet) || badSet.failure._tag !== "flows/evals/EvalError") return false
            const badFn = yield* Effect.result(Suite.encodeData(() => 1))
            if (Result.isSuccess(badFn) || badFn.failure._tag !== "flows/evals/EvalError") return false
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

  it("Suite.make & Suite.fromJsonLines validate names, concurrency, trials, duplicates, BOM, and malformed JSONL", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "validJsonl",
          "bomAndBlanks",
          "badJson",
          "badCaseShape",
          "dupCases",
          "badConcurrency",
          "badTrials",
          "emptyName",
          "emptyCases"
        ]),
        caseCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 5 }))),
        concurrency: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 4 }))),
        trials: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 5 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode, caseCount, concurrency, trials }) =>
          Effect.gen(function*() {
            const binding = Binding.make({ scorer: exactScorer, appliesTo: target })
            if (mode === "validJsonl" || mode === "bomAndBlanks") {
              const lines = Array.from({ length: caseCount }, (_, i) =>
                JSON.stringify({ name: `case-${i}`, input: i, expected: i }))
              const text = (mode === "bomAndBlanks" ? "\uFEFF\n  \n" : "") + lines.join("\n\n") + "\n"
              const suite = yield* Suite.fromJsonLines(text, {
                name: "jsonl-suite",
                concurrency,
                trials,
                bindings: [binding]
              })
              return suite.cases.length === caseCount && suite.concurrency === concurrency && suite.trials === trials
            }
            if (mode === "badJson") {
              const res = yield* Effect.result(
                Suite.fromJsonLines("{broken-json\n", { name: "bad", concurrency: 1 })
              )
              return Result.isFailure(res) && res.failure.code === "invalid_suite"
            }
            if (mode === "badCaseShape") {
              const res = yield* Effect.result(
                Suite.fromJsonLines("{\"notAName\": 123}\n", { name: "bad", concurrency: 1 })
              )
              return Result.isFailure(res) && res.failure.code === "invalid_suite"
            }
            if (mode === "dupCases") {
              const res = yield* Effect.result(
                Suite.make({
                  name: "dup",
                  concurrency: 1,
                  cases: [{ name: "a", input: 1 }, { name: "a", input: 2 }]
                })
              )
              return Result.isFailure(res) && res.failure.code === "invalid_suite"
            }
            if (mode === "badConcurrency") {
              const res = yield* Effect.result(
                Suite.make({ name: "bc", concurrency: 2000, cases: [{ name: "a", input: 1 }] })
              )
              return Result.isFailure(res) && res.failure.code === "invalid_suite"
            }
            if (mode === "badTrials") {
              const res = yield* Effect.result(
                Suite.make({ name: "bt", concurrency: 1, trials: 0, cases: [{ name: "a", input: 1 }] })
              )
              return Result.isFailure(res) && res.failure.code === "invalid_suite"
            }
            if (mode === "emptyName") {
              const res = yield* Effect.result(
                Suite.make({ name: "   ", concurrency: 1, cases: [{ name: "a", input: 1 }] })
              )
              return Result.isFailure(res) && res.failure.code === "invalid_suite"
            }
            const res = yield* Effect.result(Suite.make({ name: "empty", concurrency: 1, cases: [] }))
            return Result.isFailure(res) && res.failure.code === "invalid_suite"
          }),
        { seed: seed + 10, executions: Math.min(executions, 120) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("CaseExecutor.make, makeNoop, layerNoop enforce callback contract and typed executor failures", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        caseName: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(16))),
        val: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -50, maximum: 50 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ caseName, val }) =>
          Effect.gen(function*() {
            const exec = CaseExecutor.make((c) =>
              Effect.succeed({ output: c.input, stepKey: "s1", latencyMs: 1, target })
            )
            const out = yield* exec.run({ name: caseName, input: val })
            if (out.output !== val || out.stepKey !== "s1") return false

            const noopErr = yield* Effect.result(
              Effect.flatMap(CaseExecutor.CaseExecutor, (s) => s.run({ name: caseName, input: val })).pipe(
                Effect.provide(CaseExecutor.layerNoop)
              )
            )
            if (Result.isSuccess(noopErr) || noopErr.failure.code !== "executor") return false

            let threw = false
            try {
              CaseExecutor.make(null as unknown as CaseExecutor.Run)
            } catch (e) {
              threw = e instanceof TypeError
            }
            return threw
          }),
        { seed: seed + 11, executions: fastExecutions }
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
            if (phk > pk + 1e-12) return false
            if (c < n && Trials.passAtK(n, c + 1, k) + 1e-12 < pk) return false
            if (c < n && Trials.passHatK(n, c + 1, k) + 1e-12 < phk) return false

            const sum = Trials.summarize(outcomes, k)
            if (sum.n !== n || sum.passes !== c) return false
            const agg = Trials.aggregate({ c1: outcomes, c2: [...outcomes].reverse() }, k)
            const emptyAgg = Trials.aggregate({}, 1)
            return Math.abs(agg.passAtK - pk) < 1e-9 && Math.abs(agg.passHatK - phk) < 1e-9 && emptyAgg.passAtK === 0
          }),
        { seed: seed + 2, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Runner.run executes inline/noop/correlated/protocol-hostile scorers, trials, timeouts, failures, and feeds Baseline+Regression+Report+Gate", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "inlineHappy",
          "inlineMultiTrial",
          "inlineUnbound",
          "inlineSampledOut",
          "inlineBadSampling",
          "inlineScorerFail",
          "inlineScorerDie",
          "executorFail",
          "executorDie",
          "executorTimeout",
          "runnerNoop",
          "customBatchOk",
          "customCorrelatedOk",
          "customCorrelatedRecordFailed",
          "protocolNull",
          "protocolLengthMismatch",
          "protocolDuplicateIdentity",
          "protocolMissingIdentity",
          "protocolUnsafeKey",
          "customBadScore",
          "customBadKind",
          "customInconclusiveNoReason",
          "badRunOptions"
        ]),
        concurrency: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 3 }))),
        caseCount: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 3 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode, concurrency, caseCount }) =>
          Effect.gen(function*() {
            const cases: Array<Suite.Case> = Array.from({ length: caseCount }, (_, i) => ({
              name: `c${i}`,
              input: i,
              expected: i
            }))
            const binding = mode === "inlineSampledOut"
              ? Binding.make({ scorer: exactScorer, appliesTo: target, sampling: "none" })
              : mode === "inlineBadSampling"
              ? Binding.make({
                scorer: exactScorer,
                appliesTo: target,
                sampling: { ratio: 2, seed: "s" } as Sampling.Sampling
              })
              : mode === "inlineScorerFail" || mode === "inlineScorerDie"
              ? Binding.make({ scorer: flakyScorer, appliesTo: target })
              : Binding.make({ scorer: exactScorer, appliesTo: target })

            const suite = yield* Suite.make({
              name: `suite-${mode}`,
              concurrency,
              trials: mode === "inlineMultiTrial" ? 3 : 1,
              bindings: [binding],
              cases
            })

            const execLayer = Layer.succeed(CaseExecutor.CaseExecutor)(
              CaseExecutor.make((c) => {
                if (mode === "executorFail") {
                  return Effect.fail(new EvalError.EvalError({ code: "executor", message: "exec fail" }))
                }
                if (mode === "executorDie") {
                  return Effect.die(new Error("exec defect"))
                }
                if (mode === "executorTimeout") {
                  return Effect.never
                }
                const out = mode === "inlineScorerFail"
                  ? "fail-scorer"
                  : mode === "inlineScorerDie"
                  ? "die-scorer"
                  : c.input
                return Effect.succeed({
                  output: out,
                  stepKey: `step-${c.name}`,
                  latencyMs: 2,
                  target: mode === "inlineUnbound" ? otherTarget : target
                })
              })
            )

            const runOpts: Runner.RunOptions = {
              runId: "run-fuzz",
              at: "2026-11-22T00:00:00.000Z",
              sampleId: "sample-1",
              ...(mode === "badRunOptions" ? { k: 0 } : {}),
              ...(mode === "inlineMultiTrial" ? { k: 2 } : {}),
              ...(mode === "executorTimeout" ? { caseTimeout: "10 millis" } : {})
            }

            if (mode === "badRunOptions") {
              const r1 = yield* Effect.result(
                Runner.run(suite, { ...runOpts, runId: "   " }).pipe(
                  Effect.provide(Layer.mergeAll(execLayer, Runner.layerInline, silentLogger))
                )
              )
              const r2 = yield* Effect.result(
                Runner.run(suite, { ...runOpts, at: "not-iso" }).pipe(
                  Effect.provide(Layer.mergeAll(execLayer, Runner.layerInline, silentLogger))
                )
              )
              const r3 = yield* Effect.result(
                Runner.run(suite, { ...runOpts, caseTimeout: "0 millis" }).pipe(
                  Effect.provide(Layer.mergeAll(execLayer, Runner.layerInline, silentLogger))
                )
              )
              const r4 = yield* Effect.result(
                Runner.run(suite, { ...runOpts, k: 0 }).pipe(
                  Effect.provide(Layer.mergeAll(execLayer, Runner.layerInline, silentLogger))
                )
              )
              return (
                Result.isFailure(r1) && r1.failure.code === "invalid_run_options" &&
                Result.isFailure(r2) && r2.failure.code === "invalid_run_options" &&
                Result.isFailure(r3) && r3.failure.code === "invalid_run_options" &&
                Result.isFailure(r4) && r4.failure.code === "invalid_trials"
              )
            }

            if (mode === "runnerNoop") {
              const res = yield* Runner.run(suite, runOpts).pipe(
                Effect.provide(Layer.mergeAll(execLayer, Runner.layerNoop, silentLogger))
              )
              return res.observations.every((o) => o.kind === "inconclusive")
            }

            const makeObservation = (
              job: Runner.ScoreJob,
              overrides: Record<string, unknown> = {}
            ): Runner.ScoreObservation => ({
              ...job.observation,
              kind: "score",
              score: 0.9,
              at: job.at,
              ...overrides
            })

            let customScorer: Runner.ScoreBatchRunner | undefined
            if (mode === "customBatchOk") {
              customScorer = { runBatch: (jobs) => Effect.succeed(jobs.map((j) => makeObservation(j))) }
            } else if (mode === "customCorrelatedOk") {
              customScorer = {
                runBatch: () => Effect.succeed([]),
                runBatchCorrelated: (jobs) =>
                  Effect.succeed(jobs.map((j) => ({ identity: j.identity, observation: makeObservation(j) })))
              }
            } else if (mode === "customCorrelatedRecordFailed") {
              customScorer = {
                runBatch: () => Effect.succeed([]),
                runBatchCorrelated: (jobs) =>
                  Effect.succeed(
                    jobs.map((j) => ({
                      identity: j.identity,
                      observation: ScorerRunner.inconclusive(j, new ScorerError({ code: "store", message: "lost" })),
                      recorded: "failed" as const
                    }))
                  )
              }
            } else if (mode === "protocolNull") {
              customScorer = {
                runBatch: () => Effect.succeed([null as unknown as Runner.ScoreObservation])
              }
            } else if (mode === "protocolLengthMismatch") {
              customScorer = { runBatch: () => Effect.succeed([]) }
            } else if (mode === "protocolDuplicateIdentity") {
              customScorer = {
                runBatch: () => Effect.succeed([]),
                runBatchCorrelated: (jobs) =>
                  Effect.succeed(
                    jobs.length >= 2
                      ? [
                        { identity: jobs[0]!.identity, observation: makeObservation(jobs[0]!) },
                        { identity: jobs[0]!.identity, observation: makeObservation(jobs[1]!) },
                        ...jobs.slice(2).map((j) => ({ identity: j.identity, observation: makeObservation(j) }))
                      ]
                      : [
                        { identity: jobs[0]!.identity, observation: makeObservation(jobs[0]!) },
                        { identity: jobs[0]!.identity, observation: makeObservation(jobs[0]!) }
                      ]
                  )
              }
            } else if (mode === "protocolMissingIdentity") {
              customScorer = {
                runBatch: () => Effect.succeed([]),
                runBatchCorrelated: (jobs) =>
                  Effect.succeed(jobs.map((j) => ({ identity: "wrong-id", observation: makeObservation(j) })))
              }
            } else if (mode === "protocolUnsafeKey") {
              customScorer = {
                runBatch: (jobs) =>
                  Effect.succeed(
                    jobs.map((j) => makeObservation(j, { scorerKey: "bad\nkey", targetStepKey: "bad\rstep" }))
                  )
              }
            } else if (mode === "customBadScore") {
              customScorer = {
                runBatch: (jobs) => Effect.succeed(jobs.map((j) => makeObservation(j, { score: 2.5 })))
              }
            } else if (mode === "customBadKind") {
              customScorer = {
                runBatch: (jobs) => Effect.succeed(jobs.map((j) => makeObservation(j, { kind: "bogus" })))
              }
            } else if (mode === "customInconclusiveNoReason") {
              customScorer = {
                runBatch: (jobs) =>
                  Effect.succeed(jobs.map((j) => makeObservation(j, { kind: "inconclusive", reason: "" })))
              }
            }

            const result = yield* Effect.result(
              Runner.run(suite, { ...runOpts, ...(customScorer ? { scorer: customScorer } : {}) }).pipe(
                Effect.provide(Layer.mergeAll(execLayer, Runner.layerInline, silentLogger))
              )
            )

            if (mode === "inlineBadSampling") {
              return Result.isFailure(result) && result.failure.code === "invalid_suite"
            }
            if (mode === "customCorrelatedRecordFailed") {
              return Result.isFailure(result) && result.failure.code === "scorer_unavailable"
            }
            if (mode.startsWith("protocol")) {
              return Result.isFailure(result) && result.failure.code === "scorer_protocol"
            }
            if (Result.isFailure(result)) return false

            const run = result.success
            if (mode === "executorFail" || mode === "executorDie" || mode === "executorTimeout") {
              return run.cases.every((c) => c.error !== undefined)
            }
            if (mode === "inlineUnbound") {
              return run.cases.every((c) => c.ungraded === "unbound")
            }
            if (mode === "inlineSampledOut") {
              return run.cases.every((c) => c.ungraded === "sampled_out")
            }
            if (
              mode === "inlineScorerFail" || mode === "inlineScorerDie" ||
              mode === "customBadScore" || mode === "customBadKind" || mode === "customInconclusiveNoReason"
            ) {
              return run.observations.every((o) => o.kind === "inconclusive")
            }

            // Full pipeline: Baseline.fromRun -> write -> load -> Regression.compare -> Report -> Gate
            const baseline = yield* Baseline.fromRun(run)
            const serialized = Baseline.write(baseline)
            const loaded = yield* Baseline.load(serialized)
            const compared = yield* Regression.compare(loaded, run, { absolute: 0, relative: 0 })
            const md = Report.markdown(compared)
            const js = Report.json(compared)
            const verdict = yield* Gate.check(compared, { mean: 0.5, min: 0.5, perCase: { c0: 0.5 } })
            const ci = Gate.ciGrade(verdict)
            return md.length > 0 && js.length > 0 && ci.exitCode === 0
          }),
        { seed: seed + 12, executions: Math.min(executions, 60) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })

  it("Baseline, Regression, Report, and Gate handle regressions, nondeterminism, missing/inconclusive observations, and error paths", async () => {
    const scoreArb = Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 })))
    const arb = Arbitrary.schema(
      Schema.Struct({
        s1: scoreArb,
        s2: scoreArb,
        cur1: scoreArb,
        cur2: scoreArb,
        sameStep: Schema.Boolean,
        includeMissing: Schema.Boolean,
        includeInconclusive: Schema.Boolean,
        includeFailedCase: Schema.Boolean,
        includeUnboundCase: Schema.Boolean,
        absTol: Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 0.5 }))),
        relTol: Schema.Number.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 0.5 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({
          s1,
          s2,
          cur1,
          cur2,
          sameStep,
          includeMissing,
          includeInconclusive,
          includeFailedCase,
          includeUnboundCase,
          absTol,
          relTol
        }) =>
          Effect.gen(function*() {
            const r1 = { suite: "demo", case: "c1", scorer: "sc", scorerName: "sc", stepKey: "k1", score: s1 }
            const r2 = { suite: "demo", case: "c2", scorer: "sc", scorerName: "sc", stepKey: "k2", score: s2 }
            const b1 = yield* Baseline.make({ suite: "demo", records: [r1, r2] })
            const b2 = yield* Baseline.make({ suite: "demo", records: [r2, r1] })
            const w1 = Baseline.write(b1)
            const w2 = Baseline.write(b2)
            if (w1 !== w2 || !w1.endsWith("\n")) return false
            const loaded = yield* Baseline.load(w1)
            if (loaded.suite !== "demo" || loaded.records.length !== 2) return false

            // Baseline error paths: corrupt JSON, bad version, out-of-range score
            const badLoad1 = yield* Effect.result(Baseline.load("{bad"))
            const badLoad2 = yield* Effect.result(
              Baseline.load(JSON.stringify({ version: 99, suite: "demo", records: [] }))
            )
            const badScore = yield* Effect.result(Baseline.make({ suite: "demo", records: [{ ...r1, score: 1.5 }] }))
            if (Result.isSuccess(badLoad1) || Result.isSuccess(badLoad2) || Result.isSuccess(badScore)) return false

            const obs: Array<Runner.Observation> = [
              {
                kind: "score",
                case: "c1",
                scorer: "sc",
                scorerName: "sc",
                stepKey: sameStep ? "k1" : "k1-new",
                at: "2026-11-22T00:00:00Z",
                score: cur1
              }
            ]
            if (!includeMissing) {
              obs.push({
                kind: "score",
                case: "c2",
                scorer: "sc",
                scorerName: "sc",
                stepKey: sameStep ? "k2" : "k2-new",
                at: "2026-11-22T00:00:00Z",
                score: cur2
              })
            }
            if (includeInconclusive) {
              obs.push({
                kind: "inconclusive",
                case: "c3",
                scorer: "sc",
                scorerName: "sc",
                stepKey: "k3",
                at: "2026-11-22T00:00:00Z",
                reason: "judge\noffline"
              })
            }
            const cases: Array<Runner.CaseResult> = []
            if (includeFailedCase) {
              cases.push({
                case: "c-fail",
                observations: [],
                error: new EvalError.EvalError({ code: "executor", message: "boom\nline" })
              })
            }
            if (includeUnboundCase) {
              cases.push({
                case: "c-unbound",
                observations: [],
                execution: { output: 1, stepKey: "ku", latencyMs: 1, target: otherTarget },
                ungraded: "unbound"
              })
            }

            const runResult: Runner.RunResult = {
              runId: "run-1",
              suite: "demo",
              cases,
              observations: obs
            }
            const regReport = yield* Regression.compare(loaded, runResult, { absolute: absTol, relative: relTol })
            const repData = Report.data(regReport)
            const repJson = Report.json(regReport)
            const repMd = Report.markdown(regReport)
            if (repJson.length === 0 || repMd.length === 0 || typeof repData !== "object") return false

            // Suite mismatch in Regression.compare
            const mismatch = yield* Effect.result(
              Regression.compare(loaded, { ...runResult, suite: "other" })
            )
            if (Result.isSuccess(mismatch)) return false

            const verdict = yield* Gate.check(regReport)
            const graded = Gate.ciGrade(verdict)
            if (/[\u0000-\u001f\u007f]/.test(graded.summary)) return false
            if ((regReport.regressions.length > 0 || regReport.nondeterminism.length > 0) && graded.exitCode !== 1) {
              return false
            }
            if (
              regReport.regressions.length === 0 &&
              regReport.nondeterminism.length === 0 &&
              (regReport.missing.length > 0 || includeInconclusive || includeFailedCase || includeUnboundCase) &&
              graded.exitCode !== 5
            ) {
              return false
            }
            return true
          }),
        { seed: seed + 3, executions: Math.min(executions, 120) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
