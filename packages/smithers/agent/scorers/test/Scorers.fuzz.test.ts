import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Cause, Effect, Layer, Logger, Result, Schema, Stream } from "effect"
import { describe, expect, it } from "vitest"
import {
  Binding,
  Checks,
  Rubric,
  Sampling,
  ScoreGate,
  Scorer,
  ScorerError,
  Scorers,
  ScoreStore,
  Scoring,
  SqlScoreStore
} from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "1000" : "200"))
const dbExecutions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "200" : "40"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const silentLayer = Logger.layer([])
const sqlStoreLayer = SqlScoreStore.layer.pipe(
  Layer.provideMerge(TestDatabase.layer),
  Layer.provideMerge(silentLayer)
)

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

const isWellFormed = (s: string): boolean => {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) i++
      else return false
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

const assertPassed = (report: Parameters<typeof Fuzz.formatReport>[0]): void => {
  const failure = Fuzz.formatReport(report)
  if (failure !== undefined) throw new Error(failure)
  expect(report._tag).toBe("Passed")
}

describe("@smthrs/scorers ScoreGate, Sampling & Binding fuzz invariants", () => {
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
    assertPassed(report)
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
    assertPassed(report)
  })

  it("ScoreGate.expectScores mean, min, and perCase agree with exact oracle and validate thresholds", async () => {
    const sampleArb = Schema.Struct({
      caseName: Schema.Literals(["c0", "c1", "c2", "c3"]),
      isScore: Schema.Boolean,
      value: Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
      reason: Schema.Literals(["timeout", "oom"])
    })
    const arb = Arbitrary.schema(
      Schema.Struct({
        items: Schema.Array(sampleArb).pipe(Schema.check(Schema.isMaxLength(10))),
        thresholdIdx: Schema.Int.pipe(
          Schema.check(Schema.isBetween({ minimum: 0, maximum: specialValues.length - 1 }))
        ),
        meanT: Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
        minT: Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
        cases: Schema.Array(Schema.Literals(["c0", "c1", "c2", "c3", "missing"])).pipe(
          Schema.check(Schema.isMaxLength(4))
        )
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ items, thresholdIdx, meanT, minT, cases }) =>
          Effect.gen(function*() {
            const samples: Array<ScoreGate.ScoreSample> = items.map((item, idx) =>
              item.isScore
                ? { case: item.caseName, stepKey: `s${idx}`, scorer: "sc", kind: "score", value: item.value }
                : { case: item.caseName, stepKey: `s${idx}`, scorer: "sc", kind: "inconclusive", reason: item.reason }
            )
            const gate = ScoreGate.expectScores(samples)
            const scores = samples.flatMap((s) => (s.kind === "score" ? [s.value] : []))

            // Special threshold validation
            const badOrGoodT = specialValues[thresholdIdx]!
            const tValid = Number.isFinite(badOrGoodT) && badOrGoodT >= 0 && badOrGoodT <= 1
            const meanSpecial = yield* Effect.result(gate.mean(badOrGoodT))
            if (Result.isSuccess(meanSpecial) !== tValid) return false
            if (Result.isFailure(meanSpecial) && meanSpecial.failure.code !== "invalid_threshold") return false

            // Valid mean gate
            const meanVerdict = yield* gate.mean(meanT)
            if (scores.length === 0) {
              if (meanVerdict._tag !== "Inconclusive") return false
            } else {
              const avg = scores.reduce((a, b) => a + b, 0) / scores.length
              const expectFail = avg < meanT - 1e-9
              if (meanVerdict._tag !== (expectFail ? "Failed" : "Passed")) return false
            }

            // Valid min gate
            const minVerdict = yield* gate.min(minT)
            if (scores.length === 0) {
              if (minVerdict._tag !== "Inconclusive") return false
            } else {
              const low = Math.min(...scores)
              if (minVerdict._tag !== (low < minT ? "Failed" : "Passed")) return false
            }

            // perCase gate (empty and populated)
            const emptyPerCase = yield* gate.perCase({})
            if (emptyPerCase._tag !== "Passed") return false

            const thresholds: Record<string, number> = {}
            for (const c of cases) thresholds[c] = minT
            const perCaseVerdict = yield* gate.perCase(thresholds)
            const named = Object.keys(thresholds)
            if (named.length === 0) {
              if (perCaseVerdict._tag !== "Passed") return false
            } else {
              const measured = named.filter((name) => samples.some((s) => s.kind === "score" && s.case === name))
              if (measured.length === 0) {
                if (perCaseVerdict._tag !== "Inconclusive") return false
              } else {
                const anyBelow = measured.some((name) => {
                  const vals = samples.filter((s) => s.kind === "score" && s.case === name).map((s) =>
                    s.kind === "score" ? s.value : 1
                  )
                  return Math.min(...vals) < minT
                })
                if (perCaseVerdict._tag !== (anyBelow ? "Failed" : "Passed")) return false
              }
            }

            // Also cover shown() rounding-collision branch where actual is just below threshold
            const nearMiss = yield* ScoreGate.expectScores([
              { case: "c0", stepKey: "s0", scorer: "sc", kind: "score", value: 0.5 - 1e-8 }
            ]).min(0.5)
            if (nearMiss._tag !== "Failed") return false

            return true
          }),
        { seed: seed + 2, executions }
      )
    )
    assertPassed(report)
  })

  it("Sampling.decide is deterministic, rejects invalid policies, and Binding.make defaults to 'all'", async () => {
    const badRatios = [-1, 0, 1, 2, Number.NaN, Number.POSITIVE_INFINITY] as const
    const arb = Arbitrary.schema(
      Schema.Struct({
        stepKey: Schema.String.pipe(Schema.check(Schema.isMaxLength(32))),
        scorerKey: Schema.String.pipe(Schema.check(Schema.isMaxLength(32))),
        seedStr: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(20))),
        ratio: Schema.Finite.pipe(Schema.check(Schema.isGreaterThan(0), Schema.isLessThan(1))),
        badRatioIdx: Schema.Int.pipe(
          Schema.check(Schema.isBetween({ minimum: 0, maximum: badRatios.length - 1 }))
        )
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ stepKey, scorerKey, seedStr, ratio, badRatioIdx }) =>
          Effect.gen(function*() {
            const badRatio = badRatios[badRatioIdx]!
            const allD = yield* Sampling.decide("all", stepKey, scorerKey)
            const noneD = yield* Sampling.decide("none", stepKey, scorerKey)
            if (!allD || noneD) return false
            const r1 = yield* Sampling.decide({ ratio, seed: seedStr }, stepKey, scorerKey)
            const r2 = yield* Sampling.decide({ ratio, seed: seedStr }, stepKey, scorerKey)
            if (r1 !== r2) return false

            // Invalid ratio or empty seed or throwing getter must fail with invalid_sampling
            const bad1 = yield* Effect.result(Sampling.decide({ ratio: badRatio, seed: seedStr }, stepKey, scorerKey))
            const bad2 = yield* Effect.result(Sampling.decide({ ratio, seed: "" }, stepKey, scorerKey))
            const bad3 = yield* Effect.result(
              Sampling.decide("invalid" as unknown as Sampling.Sampling, stepKey, scorerKey)
            )
            const throwingObj = Object.defineProperty({}, "ratio", {
              enumerable: true,
              get() {
                throw new Error("boom")
              }
            }) as unknown as Sampling.Sampling
            const bad4 = yield* Effect.result(Sampling.decide(throwingObj, stepKey, scorerKey))
            if (
              Result.isSuccess(bad1) || bad1.failure.code !== "invalid_sampling" ||
              Result.isSuccess(bad2) || bad2.failure.code !== "invalid_sampling" ||
              Result.isSuccess(bad3) || bad3.failure.code !== "invalid_sampling" ||
              Result.isSuccess(bad4) || bad4.failure.code !== "invalid_sampling"
            ) {
              return false
            }

            // Binding.make default and explicit sampling
            const sc = Scorers.exact()
            const b1 = Binding.make({ scorer: sc, appliesTo: { name: stepKey || "flow" } })
            const b2 = Binding.make({
              scorer: sc,
              appliesTo: { name: stepKey || "flow" },
              sampling: { ratio, seed: seedStr },
              groundTruth: "x",
              context: { k: 1 }
            })
            return b1.sampling === "all" && typeof b2.sampling === "object"
          }),
        { seed: seed + 3, executions }
      )
    )
    assertPassed(report)
  })
})

describe("@smthrs/scorers Scorer, internal/json & built-in Scorers fuzz invariants", () => {
  it("Scorer.make produces key-order-independent scorerKeys, rejects lossy configs, and Scorer.validate enforces [0,1]", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        id: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(20))),
        version: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(10))),
        a: Schema.Int,
        b: Schema.String.pipe(Schema.check(Schema.isMaxLength(16))),
        caps: Schema.Array(Schema.Literals(["net", "fs", "read", "net"])).pipe(Schema.check(Schema.isMaxLength(5))),
        scoreVal: Schema.Number
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ id, version, a, b, caps, scoreVal }) =>
          Effect.gen(function*() {
            if (!isWellFormed(id) || !isWellFormed(version) || !isWellFormed(b)) return true
            const cleanId = id.trim().length === 0 ? "id" : id
            const cleanVer = version.trim().length === 0 ? "1" : version
            const s1 = Scorer.make({
              id: cleanId,
              version: cleanVer,
              config: { a, b, nested: [1, b, null, true] },
              capabilities: caps,
              score: () => Effect.succeed({ score: 1 })
            })
            const s2 = Scorer.make({
              id: cleanId,
              version: cleanVer,
              config: { nested: [1, b, null, true], b, a },
              capabilities: [...caps].reverse(),
              score: () => Effect.succeed({ score: 1 })
            })
            if (s1.scorerKey !== s2.scorerKey) return false
            if (s1.name !== cleanId) return false
            if (JSON.stringify(s1.capabilities) !== JSON.stringify(s2.capabilities)) return false

            // Validation invariant
            const validated = yield* Effect.result(Scorer.validate({ score: scoreVal }))
            const ok = Number.isFinite(scoreVal) && scoreVal >= 0 && scoreVal <= 1
            if (Result.isSuccess(validated) !== ok) return false
            if (Result.isFailure(validated) && validated.failure.code !== "invalid_score") return false

            return true
          }),
        { seed: seed + 4, executions }
      )
    )
    assertPassed(report)

    // Verify all invalid_declaration and lossyPath branches throw ScorerError
    const expectDeclErr = (fn: () => unknown) => {
      try {
        fn()
        throw new Error("expected throw")
      } catch (e) {
        expect(e).toBeInstanceOf(ScorerError.ScorerError)
        expect((e as ScorerError.ScorerError).code).toBe("invalid_declaration")
      }
    }
    const baseScore = () => Effect.succeed({ score: 1 })
    expectDeclErr(() =>
      Scorer.make({ id: "x", version: "1", score: baseScore, body: undefined } as unknown as Scorer.MakeOptions)
    )
    expectDeclErr(() =>
      Scorer.make({ id: "x", version: "1", score: baseScore, model: "m" } as unknown as Scorer.MakeOptions)
    )
    expectDeclErr(() =>
      Scorer.make({ id: "x", version: "1", score: baseScore, flows: {} } as unknown as Scorer.MakeOptions)
    )
    expectDeclErr(() => Scorer.make({ id: 123 as unknown as string, version: "1", score: baseScore }))
    expectDeclErr(() => Scorer.make({ id: "x", version: 123 as unknown as string, score: baseScore }))
    expectDeclErr(() => Scorer.make({ id: "   ", version: "1", score: baseScore }))
    expectDeclErr(() => Scorer.make({ id: "x", version: "   ", score: baseScore }))

    // Lossy config variants
    const circular: Record<string, unknown> = {}
    circular.self = circular
    let deep: Record<string, unknown> = {}
    for (let i = 0; i < 1005; i++) deep = { next: deep }
    const withSymProp: Record<PropertyKey, unknown> = { [Symbol("k")]: 1 }
    const arrWithSym: Array<unknown> = [1]
    ;(arrWithSym as unknown as Record<PropertyKey, unknown>)[Symbol("s")] = 2
    const arrWithExtra: Array<unknown> = [1]
    ;(arrWithExtra as unknown as Record<string, unknown>).extra = 2
    const arrWithThrowing = Object.defineProperty([1], "0", {
      enumerable: true,
      get() {
        throw new Error("boom")
      }
    })
    const nonEnum = Object.defineProperty({}, "hidden", { value: 1, enumerable: false })
    const throwingGetter = Object.defineProperty({}, "k", {
      enumerable: true,
      get() {
        throw new Error("boom")
      }
    })
    const throwingKeys = new Proxy({}, {
      ownKeys() {
        throw new Error("boom")
      }
    })

    for (
      const badConfig of [
        () => 1,
        Symbol("x"),
        1n,
        { u: undefined },
        { n: Number.NaN },
        circular,
        deep,
        { toJSON: () => 1 },
        withSymProp,
        arrWithSym,
        arrWithExtra,
        arrWithThrowing,
        nonEnum,
        throwingGetter,
        throwingKeys,
        { loneSurrogate: "\ud800" }
      ]
    ) {
      expectDeclErr(() => Scorer.make({ id: "x", version: "1", config: badConfig, score: baseScore }))
    }

    // Scorer.validate with throwing score getter and non-object
    const badResult = Object.defineProperty({}, "score", {
      enumerable: true,
      get() {
        throw new Error("boom")
      }
    })
    const r1 = await Effect.runPromise(Effect.result(Scorer.validate(badResult)))
    const r2 = await Effect.runPromise(Effect.result(Scorer.validate("nope")))
    expect(Result.isFailure(r1)).toBe(true)
    expect(Result.isFailure(r2)).toBe(true)
  })

  it("Scorers.exact, contains, testsPass, diffSize & touchedFiles satisfy exact scoring & failure invariants", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        words: Schema.Array(Schema.Literals(["alpha", "beta", "gamma", "delta"])).pipe(
          Schema.check(Schema.isMinLength(1), Schema.isMaxLength(4))
        ),
        other: Schema.Literals(["alpha", "beta", "zzz"]),
        exitCode: Schema.Literals([-1, 0, 1, 2, 127]),
        spawnFail: Schema.Boolean,
        addedLines: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5 }))),
        removedLines: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5 }))),
        contextLines: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 3 }))),
        maxBudget: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 10 }))),
        useOctalPath: Schema.Boolean,
        includeMetadataOnly: Schema.Boolean,
        crlf: Schema.Boolean,
        garbage: Schema.String.pipe(Schema.check(Schema.isMaxLength(60)))
      })
    )
    const exact = Scorers.exact()
    const contains = Scorers.contains()

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({
          words,
          other,
          exitCode,
          spawnFail,
          addedLines,
          removedLines,
          contextLines,
          maxBudget,
          useOctalPath,
          includeMetadataOnly,
          crlf,
          garbage
        }) =>
          Effect.gen(function*() {
            // exact & contains
            const spaced = `  ${words.join("  \t\n ")}  `
            const joined = words.join(" ")
            const ex1 = yield* exact.score({ input: null, output: spaced, groundTruth: joined })
            const ex2 = yield* exact.score({ input: null, output: spaced, groundTruth: "never-matches" })
            const exBad = yield* Effect.result(exact.score({ input: null, output: 123, groundTruth: "a" }))
            if (ex1.score !== 1 || ex2.score !== 0 || Result.isSuccess(exBad)) return false

            const ct1 = yield* contains.score({ input: null, output: joined, groundTruth: other })
            if (ct1.score !== (joined.includes(other) ? 1 : 0)) return false

            // testsPass
            const tp = Scorers.testsPass({
              command: "pnpm test",
              timeoutMs: 1000,
              sandbox: {
                spawn: () =>
                  spawnFail
                    ? Effect.fail(new Error("spawn failed") as never)
                    : Effect.succeed({
                      exitCode: Effect.succeed(exitCode),
                      stdout: Stream.empty,
                      stderr: Stream.empty
                    } as never)
              }
            })
            const tpRes = yield* Effect.result(tp.score({ input: null, output: null }))
            if (spawnFail || exitCode < 0) {
              if (Result.isSuccess(tpRes) || tpRes.failure.code !== "inconclusive") return false
            } else {
              if (Result.isFailure(tpRes) || tpRes.success.score !== (exitCode === 0 ? 1 : 0)) return false
            }

            // Build valid unified diff
            const eol = crlf ? "\r\n" : "\n"
            const lines: Array<string> = []
            let expectedFiles = 0
            if (addedLines + removedLines + contextLines > 0) {
              expectedFiles++
              const filePath = useOctalPath ? "\"b/caf\\303\\251\\t\\\\\\\"😀file.ts\"" : "b/src/a.ts"
              const oldPath = useOctalPath ? "\"a/caf\\303\\251\\t\\\\\\\"😀file.ts\"" : "a/src/a.ts"
              lines.push(`diff --git ${oldPath} ${filePath}`)
              lines.push("index 111..222 100644")
              lines.push(useOctalPath ? `--- ${oldPath}` : `--- ${oldPath}\t2026-01-01`)
              lines.push(useOctalPath ? `+++ ${filePath}` : `+++ ${filePath}\t2026-01-01`)
              const oldCount = removedLines + contextLines
              const newCount = addedLines + contextLines
              lines.push(`@@ -1,${oldCount} +1,${newCount} @@`)
              for (let i = 0; i < contextLines; i++) lines.push(" ctx")
              for (let i = 0; i < removedLines; i++) lines.push("-old")
              for (let i = 0; i < addedLines; i++) lines.push("+new")
              lines.push("\\ No newline at end of file")
            }
            if (includeMetadataOnly) {
              expectedFiles += 2
              lines.push("diff --git a/empty.ts b/empty.ts")
              lines.push("new file mode 100644")
              lines.push("diff --git a/old.ts b/renamed.ts")
              lines.push("similarity index 100%")
              lines.push("rename from old.ts")
              lines.push("rename to renamed.ts")
            }
            const diffText = lines.join(eol)
            const ds = Scorers.diffSize({ max: maxBudget })
            const tf = Scorers.touchedFiles({ max: maxBudget })
            const dsRes = yield* ds.score({ input: null, output: diffText })
            const tfRes = yield* tf.score({ input: null, output: diffText })
            if (dsRes.score !== (addedLines + removedLines <= maxBudget ? 1 : 0)) return false
            if (tfRes.score !== (expectedFiles <= maxBudget ? 1 : 0)) return false

            // Arbitrary garbage diff must never throw a defect
            const gRes = yield* Effect.result(ds.score({ input: null, output: garbage }))
            if (Result.isFailure(gRes) && gRes.failure.code !== "inconclusive") return false

            return true
          }),
        { seed: seed + 5, executions }
      )
    )
    assertPassed(report)

    // Cover invalid declarations & malformed diff edge cases
    expect(() => Scorers.testsPass({ command: "  ", sandbox: { spawn: () => Effect.die("no") } })).toThrow()
    expect(() => Scorers.testsPass({ command: "ok", timeoutMs: 0, sandbox: { spawn: () => Effect.die("no") } }))
      .toThrow()
    expect(() => Scorers.diffSize({ max: -1 })).toThrow()
    const ds = Scorers.diffSize({ max: 5 })
    for (
      const badDiff of [
        "diff --git a/x b/x\n", // no metadata or unified headers
        "@@ -1,2 +1,2 @@\n+a\n", // hunk with no file headers
        "--- a/x\n+++ b/x\n@@ invalid @@\n",
        "--- a/x\n+++ b/x\n@@ -1,2 +1,1 @@\n-a\n", // incomplete hunk
        "--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n!bad\n", // bad hunk line
        "--- \"a/\\z\"\n+++ b/x\n", // invalid escape in quoted path
        "--- \"a/unterminated\n+++ b/x\n", // unterminated quoted path
        "--- a/del.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n", // valid deletion (passes)
        "--- /dev/null\n+++ /dev/null\n@@ -1 +1 @@\n-a\n+b\n", // both /dev/null
        "diff --git a/x b/y\nnew file mode 100644\n" // mismatched git header without rename
      ]
    ) {
      const r = await Effect.runPromise(Effect.result(ds.score({ input: null, output: badDiff })))
      if (badDiff.includes("del.ts")) expect(Result.isSuccess(r)).toBe(true)
      else expect(Result.isFailure(r)).toBe(true)
    }
  })
})

describe("@smthrs/scorers Checks & Rubric fuzz invariants", () => {
  it("Checks.* enforce bounds, link extraction, references, paths, tool counts, leakage redaction & scorer fold", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        bodyWords: Schema.Array(Schema.Literals(["alpha", "beta", "hello", "world", "hasn’t", "code"])).pipe(
          Schema.check(Schema.isMaxLength(8))
        ),
        minWords: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 5 }))),
        maxWords: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 3, maximum: 10 }))),
        issueNum: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 999 }))),
        linkIssue: Schema.Boolean,
        usePullUrl: Schema.Boolean,
        addPath: Schema.Boolean,
        addOpener: Schema.Boolean,
        addEllipsis: Schema.Boolean,
        unclosedFence: Schema.Boolean,
        secret: Schema.Literals(["tok_secret_999", "api-key-abc", "   "]),
        leakSecret: Schema.Boolean,
        toolCalls: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 4 })))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({
          bodyWords,
          minWords,
          maxWords,
          issueNum,
          linkIssue,
          usePullUrl,
          addPath,
          addOpener,
          addEllipsis,
          unclosedFence,
          secret,
          leakSecret,
          toolCalls
        }) =>
          Effect.gen(function*() {
            const parts: Array<string> = []
            if (addOpener) parts.push("🎉 Sure! ")
            parts.push(bodyWords.join(" "))
            const urlKind = usePullUrl ? "pull" : "issues"
            const issueUrl = `https://github.com/org/repo/${urlKind}/${issueNum}`
            if (linkIssue) {
              parts.push(`<${issueUrl}|#${issueNum}>`)
            } else {
              parts.push(`see #${issueNum}`)
            }
            parts.push("[docs](https://example.com/docs/page#top)")
            parts.push("(https://example.org/path_(v1).)")
            parts.push("`https://example.net/wrapped`")
            if (addPath) parts.push("see /Users/alice/file.ts and src/foo.md")
            parts.push("Is this clear? Really?")
            if (addEllipsis) parts.push("cut...")
            if (unclosedFence) parts.push("\n```ts\nconst x = 1\n")
            else parts.push("\n```ts\nconst ellipsis = \"ok...\"\n```\n`inline...`")

            const text = parts.join(" ")
            const wc = Checks.words(text)
            const len = Checks.length(text, { min: minWords, max: maxWords })
            if (len.pass !== (wc >= minWords && wc <= maxWords)) return false

            const inc = Checks.includes(text, [
              ["alpha", "beta", "hello", "world", "hasn't", "code", "docs"],
              /github|see/i,
              ""
            ])
            const exc = Checks.excludes(text, ["forbidden_xyz", /nevermatch/g, ""])
            if (!exc.pass) return false

            const op = Checks.opener(text, ["", "sure", "certainly"])
            if (op.pass === addOpener) return false

            const tr = Checks.truncated(text)
            if (tr.pass !== (!addEllipsis && !unclosedFence)) return false

            const extracted = Checks.links(text)
            if (extracted.length < 2) return false
            const reqLinks = Checks.requiredLinks(text, [
              "https://EXAMPLE.com/docs",
              ["https://example.org/path_(v1)", "https://other.invalid"],
              "not a url://bad"
            ])
            if (reqLinks.pass) return false // "not a url://bad" is missing

            const reqLinksOk = Checks.requiredLinks(text, ["https://example.com/docs"])
            if (!reqLinksOk.pass) return false

            const refs = Checks.linkedReferences(text, [
              { pattern: "#(\\d+)", url: "https://github.com/org/repo/issues/$1" }
            ])
            if (refs.pass !== linkIssue) return false

            const bp = Checks.barePaths(text)
            if (bp.pass === addPath) return false

            const q = Checks.questions(text)
            if (q < 2) return false

            // Tool call counts
            const actions: Array<Checks.Action> = [
              ...Array.from({ length: toolCalls }, (_, i) => ({
                tool: "search",
                input: { mode: i % 2 === 0 ? "FAST" : "deep", n: 1, ok: true }
              })),
              { tool: "search", input: "non-object" }
            ]
            const c1 = Checks.count(actions, {
              tool: "search",
              where: { mode: ["fast", "deep"], n: 1, ok: true },
              min: 1,
              max: 3
            })
            if (c1.pass !== (toolCalls >= 1 && toolCalls <= 3)) return false
            const c2 = Checks.count(actions, { tool: "search", max: 2, id: "custom-count" })
            if (c2.id !== "custom-count") return false

            // Leakage check: never copies secret value into detail!
            const emissions: Array<Checks.Emission> = [
              { sink: "stdout", text: leakSecret ? `prefix ${secret} suffix` : "clean output" }
            ]
            const leak = Checks.leakage(emissions, [secret, /never_secret/i])
            const nonBlankSecret = secret.trim().length > 0
            if (leak.pass !== (!leakSecret || !nonBlankSecret)) return false
            if (nonBlankSecret && leak.detail.includes(secret.trim())) return false

            // Checks.all + Checks.scorer + detail clipping
            const list = [len, inc, exc, op, tr, reqLinksOk, refs, bp, c1, leak]
            const summary = Checks.all(list)
            if (summary.score < 0 || summary.score > 1) return false
            if (Checks.all([]).score !== 1) return false
            if (list.some((item) => item.detail.length > 200)) return false

            const checkScorer = Checks.scorer({
              id: "fuzz/checks",
              version: "1",
              name: "fuzz-checks",
              config: { minWords, maxWords },
              checks: () => list
            })
            const scored = yield* checkScorer.score({ input: null, output: text })
            return Math.abs(scored.score - summary.score) < 1e-12
          }),
        { seed: seed + 6, executions }
      )
    )
    assertPassed(report)
  })

  it("Rubric.render fences backticks safely, parse rejects forged/malformed replies, decide & agreement obey laws", async () => {
    const criteria: ReadonlyArray<Rubric.Criterion> = [
      { id: "clarity", question: "Clear?", low: "Muddy", high: "Crystal" },
      { id: "__proto__", question: "Safe proto key?", low: "No", high: "Yes" }
    ]
    const arb = Arbitrary.schema(
      Schema.Struct({
        s1: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 5 }))),
        s2: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 5 }))),
        backticks: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 6 }))),
        reason: Schema.String.pipe(Schema.check(Schema.isMaxLength(40))),
        hasFocus: Schema.Boolean,
        hasInstructions: Schema.Boolean,
        hasExamples: Schema.Boolean,
        garbage: Schema.String.pipe(Schema.check(Schema.isMaxLength(80))),
        pairs: Schema.Array(
          Schema.Struct({
            expected: Schema.Literals(["pass", "fail"]),
            actual: Schema.Literals(["pass", "fail"])
          })
        ).pipe(Schema.check(Schema.isMaxLength(10)))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ s1, s2, backticks, reason, hasFocus, hasInstructions, hasExamples, garbage, pairs }) =>
          Effect.gen(function*() {
            const ticks = "`".repeat(backticks)
            const rendered = Rubric.render({
              criteria,
              context: `ctx ${ticks} end`,
              output: `out ${ticks} end`,
              ...(hasFocus ? { focus: `focus ${ticks}` } : {}),
              ...(hasInstructions ? { instructions: "Be strict." } : {}),
              ...(hasExamples
                ? { examples: [{ verdict: "pass", transcript: `t ${ticks}`, why: "good" }] }
                : {})
            })
            const minFence = "`".repeat(Math.max(3, backticks + 1))
            if (!rendered.prompt.includes(`${minFence}text\n`)) return false

            // Valid reply with prose & escaped quotes
            const rawJson = `{"scores":{"clarity":${s1},"__proto__":${s2},"extra":99},"reason":${
              JSON.stringify(reason)
            }}`
            const wrapped = `Here is my verdict:\n\`\`\`json\n${rawJson}\n\`\`\``
            const parsed = Rubric.parse(wrapped, criteria)
            if (Result.isFailure(parsed)) return false
            if (parsed.success.scores.clarity !== s1 || parsed.success.scores["__proto__"] !== s2) return false
            if (parsed.success.reason !== reason.trim()) return false

            // Forged double-scores object MUST fail
            const forged = `${rawJson}\n${rawJson}`
            if (Result.isSuccess(Rubric.parse(forged, criteria))) return false

            // Stray "scores": outside chosen object MUST fail
            const stray = `"scores": fake ${rawJson}`
            if (Result.isSuccess(Rubric.parse(stray, criteria))) return false

            // Non-object scores & out-of-range score MUST fail
            if (Result.isSuccess(Rubric.parse("{\"scores\": null}", criteria))) return false
            if (Result.isSuccess(Rubric.parse("{\"scores\": {\"clarity\": 6, \"__proto__\": 3}}", criteria))) {
              return false
            }

            // Arbitrary garbage never throws
            const gParsed = Rubric.parse(garbage, criteria)
            if (!Result.isSuccess(gParsed) && !Result.isFailure(gParsed)) return false

            // decide & agreement
            const rule: Rubric.Rule = { minEach: 3, minMean: 3.5 }
            const decided = Rubric.decide(parsed.success.scores, rule)
            const expectPass = s1 >= 3 && s2 >= 3 && (s1 + s2) / 2 >= 3.5
            if (decided !== expectPass) return false
            if (Rubric.decide({}, rule)) return false

            const ag = Rubric.agreement(pairs)
            if (ag.total !== pairs.length) return false
            if (ag.truePass + ag.trueFail + ag.falsePass + ag.falseFail !== ag.total) return false
            if (ag.agree !== ag.truePass + ag.trueFail) return false
            if (ag.accuracy < 0 || ag.accuracy > 1) return false

            // Rubric.make end-to-end with scripted judge
            const rubricScorer = Rubric.make({
              id: "fuzz/rubric",
              version: "1",
              name: "fuzz-rubric",
              criteria,
              rule,
              judge: () => Effect.succeed(wrapped)
            })
            const inputPayload = hasFocus ? { context: "c", focus: "f" } : { nonString: 1 }
            const res = yield* rubricScorer.score({ input: inputPayload, output: { ok: true } })
            const expectedScore = ((s1 + s2) / 2 - 1) / 4
            if (Math.abs(res.score - expectedScore) > 1e-12) return false

            // Invalid judge reply fails with invalid_score
            const badJudgeScorer = Rubric.make({
              id: "fuzz/rubric-bad",
              version: "1",
              criteria,
              judge: () => Effect.succeed("no json here")
            })
            const badRes = yield* Effect.result(badJudgeScorer.score({ input: "c", output: "o" }))
            if (Result.isSuccess(badRes) || badRes.failure.code !== "invalid_score") return false

            return true
          }),
        { seed: seed + 7, executions }
      )
    )
    assertPassed(report)

    // Invalid rubric declarations (empty or duplicate criterion ids)
    expect(() => Rubric.make({ id: "r", version: "1", criteria: [], judge: () => Effect.succeed("") })).toThrow()
    expect(() =>
      Rubric.make({
        id: "r",
        version: "1",
        criteria: [criteria[0]!, criteria[0]!],
        judge: () => Effect.succeed("")
      })
    ).toThrow()
  })
})

describe("@smthrs/scorers SqlScoreStore, ScoreStore & Scoring fuzz invariants", () => {
  it("SqlScoreStore record/recordOnce/observations/aggregate/prune match in-memory oracle and enforce bounds", async () => {
    const opArb = Schema.Union([
      Schema.Struct({
        op: Schema.Literal("record"),
        target: Schema.Literals(["t1", "t2"]),
        scorer: Schema.Literals(["s1", "s2"]),
        isScore: Schema.Boolean,
        score: Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
        at: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20 }))),
        withMeta: Schema.Boolean,
        withSecret: Schema.Boolean
      }),
      Schema.Struct({
        op: Schema.Literal("recordOnce"),
        identity: Schema.Literals(["j1", "j2", "j3", "j4"]),
        target: Schema.Literals(["t1", "t2"]),
        scorer: Schema.Literals(["s1", "s2"]),
        score: Schema.Finite.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
        at: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 20 })))
      }),
      Schema.Struct({
        op: Schema.Literal("prune"),
        olderThan: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 25 })))
      })
    ])
    const arb = Arbitrary.schema(
      Schema.Array(opArb).pipe(Schema.check(Schema.isMinLength(1), Schema.isMaxLength(15)))
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (ops) =>
          Effect.gen(function*() {
            const store = yield* ScoreStore.ScoreStore
            interface OracleRow {
              readonly id: number
              readonly target: string
              readonly scorer: string
              readonly kind: "score" | "inconclusive"
              readonly score?: number
              readonly at: number
            }
            let nextId = 1
            let rows: Array<OracleRow> = []
            const claims = new Map<string, number>()

            for (const op of ops) {
              if (op.op === "record") {
                const reason = op.withSecret ? "Bearer super_secret_token_12345" : "ok reason"
                const obs: ScoreStore.Observation = op.isScore
                  ? {
                    kind: "score",
                    targetStepKey: op.target,
                    scorerKey: op.scorer,
                    score: op.score,
                    reason,
                    ...(op.withMeta ? { meta: { k: "v", secret: "Bearer abcdef123456" } } : {}),
                    at: op.at
                  }
                  : {
                    kind: "inconclusive",
                    targetStepKey: op.target,
                    scorerKey: op.scorer,
                    reason,
                    code: "inconclusive",
                    at: op.at
                  }
                yield* store.record(obs)
                rows.push({
                  id: nextId++,
                  target: op.target,
                  scorer: op.scorer,
                  kind: op.isScore ? "score" : "inconclusive",
                  ...(op.isScore ? { score: op.score } : {}),
                  at: op.at
                })
              } else if (op.op === "recordOnce") {
                const obs: ScoreStore.Observation = {
                  kind: "score",
                  targetStepKey: op.target,
                  scorerKey: op.scorer,
                  score: op.score,
                  at: op.at
                }
                const recorded = yield* store.recordOnce(op.identity, obs)
                const alreadyClaimed = claims.has(op.identity)
                if (recorded === alreadyClaimed) return false
                if (!alreadyClaimed) {
                  claims.set(op.identity, op.at)
                  rows.push({
                    id: nextId++,
                    target: op.target,
                    scorer: op.scorer,
                    kind: "score",
                    score: op.score,
                    at: op.at
                  })
                }
              } else {
                const pruned = yield* store.prune({ olderThan: op.olderThan })
                const removedObs = rows.filter((r) => r.at < op.olderThan).length
                rows = rows.filter((r) => r.at >= op.olderThan)
                let removedJobs = 0
                for (const [k, createdAt] of [...claims.entries()]) {
                  if (createdAt < op.olderThan) {
                    claims.delete(k)
                    removedJobs++
                  }
                }
                if (pruned.observations !== removedObs || pruned.jobs !== removedJobs) return false
              }
            }

            // Verify observations, pagination, and aggregate against oracle
            for (const target of ["t1", "t2"] as const) {
              const allObs = yield* store.observations(target)
              const oracleAll = rows.filter((r) => r.target === target).sort((a, b) => a.at - b.at || a.id - b.id)
              if (allObs.length !== oracleAll.length) return false
              for (let i = 0; i < allObs.length; i++) {
                if (allObs[i]!.at !== oracleAll[i]!.at || allObs[i]!.kind !== oracleAll[i]!.kind) return false
              }

              // Paginated read with scorerKey, before, limit, offset
              const page = yield* store.observations(target, "s1", { limit: 2, offset: 1, before: 15 })
              const oraclePage = oracleAll.filter((r) => r.scorer === "s1" && r.at < 15).slice(1, 3)
              if (page.length !== oraclePage.length) return false

              // Aggregate check
              const agg = yield* store.aggregate(target)
              if (oracleAll.length === 0) {
                if (agg !== undefined) return false
              } else {
                if (agg === undefined) return false
                const scores = oracleAll.filter((r) => r.kind === "score").map((r) => r.score!)
                const inc = oracleAll.filter((r) => r.kind === "inconclusive").length
                if (agg.count !== scores.length || agg.inconclusive !== inc) return false
                if (scores.length === 0) {
                  if (agg.mean !== undefined || agg.min !== undefined) return false
                } else {
                  const mean = scores.reduce((a, b) => a + b, 0) / scores.length
                  const min = Math.min(...scores)
                  if (Math.abs((agg.mean ?? -1) - mean) > 1e-9 || Math.abs((agg.min ?? -1) - min) > 1e-9) return false
                }
              }
            }

            return true
          }).pipe(Effect.provide(sqlStoreLayer)),
        { seed: seed + 8, executions: dbExecutions }
      )
    )
    assertPassed(report)

    // Verify StoreStore.makeNoop, SqlScoreStore validation bounds, and Scoring.runBatchCorrelated
    await Effect.runPromise(
      Effect.gen(function*() {
        // Noop store coverage
        const noop = ScoreStore.makeNoop()
        expect(yield* noop.recordOnce("id", { kind: "score", targetStepKey: "t", scorerKey: "s", score: 1, at: 0 }))
          .toBe(true)
        yield* noop.record({ kind: "score", targetStepKey: "t", scorerKey: "s", score: 1, at: 0 })
        expect(yield* noop.observations("t")).toEqual([])
        expect(yield* noop.aggregate("t")).toBeUndefined()
        expect(yield* noop.prune({ olderThan: 10 })).toEqual({ observations: 0, jobs: 0 })

        // SqlScoreStore invalid request/observation errors
        const store = yield* ScoreStore.ScoreStore
        expect(Result.isFailure(
          yield* Effect.result(store.recordOnce("   ", {
            kind: "score",
            targetStepKey: "t",
            scorerKey: "s",
            score: 1,
            at: 1
          }))
        )).toBe(true)
        expect(Result.isFailure(
          yield* Effect.result(store.recordOnce("x".repeat(600), {
            kind: "score",
            targetStepKey: "t",
            scorerKey: "s",
            score: 1,
            at: 1
          }))
        )).toBe(true)
        expect(Result.isFailure(
          yield* Effect.result(store.record({
            kind: "score",
            targetStepKey: "t",
            scorerKey: "s",
            score: 1,
            reason: "a".repeat(2000),
            at: 1
          }))
        )).toBe(true)
        expect(Result.isFailure(
          yield* Effect.result(store.record({
            kind: "score",
            targetStepKey: "t",
            scorerKey: "s",
            score: 1,
            meta: { huge: "x".repeat(70_000) },
            at: 1
          }))
        )).toBe(true)
        expect(Result.isFailure(
          yield* Effect.result(store.record({
            kind: "score",
            targetStepKey: "t",
            scorerKey: "s",
            score: 1,
            meta: { bad: () => 1 },
            at: 1
          }))
        )).toBe(true)
        expect(Result.isFailure(yield* Effect.result(store.observations("t", undefined, { limit: 0 })))).toBe(true)
        expect(Result.isFailure(yield* Effect.result(store.observations("t", undefined, { before: -1 })))).toBe(true)
        expect(Result.isFailure(yield* Effect.result(store.observations("t", undefined, { offset: -1 })))).toBe(true)
        expect(Result.isFailure(yield* Effect.result(store.prune({ olderThan: Number.NaN })))).toBe(true)

        // Throwing observation getter & observationLabel branches
        const hostileObs = Object.defineProperty({}, "kind", {
          enumerable: true,
          get() {
            throw new Error("boom")
          }
        }) as unknown as ScoreStore.Observation
        expect(Result.isFailure(yield* Effect.result(store.record(hostileObs)))).toBe(true)
        expect(Result.isFailure(
          yield* Effect.result(ScoreStore.validate({
            kind: "inconclusive",
            targetStepKey: "",
            scorerKey: "s",
            reason: "",
            code: "inconclusive",
            at: 1
          }))
        )).toBe(true)
        let kindReads = 0
        const trickyKind = Object.defineProperty({ score: 99 }, "kind", {
          enumerable: true,
          get() {
            kindReads++
            if (kindReads > 2) throw new Error("label boom")
            return "score"
          }
        }) as unknown as ScoreStore.Observation
        expect(Result.isFailure(yield* Effect.result(ScoreStore.validate(trickyKind)))).toBe(true)

        // Scoring.jobIdentity, Scoring.inconclusive, Scoring.runBatch, Scoring.runBatchCorrelated
        const id1 = Scoring.jobIdentity(["a:b", "c"])
        const id2 = Scoring.jobIdentity(["a", "b:c"])
        expect(id1).not.toBe(id2)

        const uncoercible = {
          toString() {
            throw new Error("no string")
          }
        }
        const incObs = Scoring.inconclusive({
          identity: "k",
          observation: { targetStepKey: "t", scorerKey: "s" },
          score: Effect.succeed({ score: 1 }),
          at: 5
        }, uncoercible)
        expect(incObs.kind).toBe("inconclusive")

        const jobs: ReadonlyArray<Scoring.Job> = [
          {
            identity: Scoring.jobIdentity(["batch", "1"]),
            observation: { targetStepKey: "tb", scorerKey: "sb" },
            score: Effect.succeed({ score: 0.9, reason: "Bearer tok1234567890", meta: { ok: true } }),
            at: 10
          },
          {
            identity: Scoring.jobIdentity(["batch", "1"]), // duplicate
            observation: { targetStepKey: "tb", scorerKey: "sb" },
            score: Effect.succeed({ score: 0.9 }),
            at: 10
          },
          {
            identity: Scoring.jobIdentity(["batch", "2"]),
            observation: { targetStepKey: "tb", scorerKey: "sb" },
            score: Effect.fail(new ScorerError.ScorerError({ code: "inconclusive", message: "judge down" })),
            at: 11
          },
          {
            identity: Scoring.jobIdentity(["batch", "3"]),
            observation: { targetStepKey: "tb", scorerKey: "sb" },
            score: Effect.succeed({ score: 2 }), // invalid score -> inconclusive
            at: 12
          },
          {
            identity: Scoring.jobIdentity(["batch", "4"]),
            observation: { targetStepKey: "tb", scorerKey: "sb" },
            score: Effect.succeed({ score: 0.5, meta: { fn: () => 1 } }), // lossy meta -> inconclusive
            at: 13
          }
        ]
        const outcomes = yield* Scoring.runBatchCorrelated(jobs, { concurrency: 2 })
        expect(outcomes.map((o) => o.recorded)).toEqual([
          "persisted",
          "duplicate",
          "persisted",
          "persisted",
          "persisted"
        ])
        expect(outcomes[2]!.observation.kind).toBe("inconclusive")
        expect(outcomes[3]!.observation.kind).toBe("inconclusive")
        expect(outcomes[4]!.observation.kind).toBe("inconclusive")

        // runBatch & failing store -> recorded: "failed"
        const failingStore = Layer.succeed(ScoreStore.ScoreStore)(
          ScoreStore.ScoreStore.of({
            ...noop,
            recordOnce: () => Effect.fail(new ScorerError.ScorerError({ code: "store", message: "disk full" }))
          })
        )
        const failedOutcomes = yield* Scoring.runBatchCorrelated([jobs[0]!]).pipe(
          Effect.provide(failingStore)
        )
        expect(failedOutcomes[0]!.recorded).toBe("failed")

        const batchObs = yield* Scoring.runBatch([jobs[0]!], { concurrency: 0 })
        expect(batchObs.length).toBe(1)

        // Cover Cause.isCause in inconclusive
        const causeObs = Scoring.inconclusive(jobs[0]!, Cause.fail(new Error("boom")))
        expect(causeObs.kind).toBe("inconclusive")
      }).pipe(Effect.provide(sqlStoreLayer))
    )
  })
})
