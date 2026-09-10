import * as ScoreGate from "@smthrs/scorers/ScoreGate"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"

const sample = (value: number, caseName = "first"): ScoreGate.ScoreSample => ({
  case: caseName,
  stepKey: `${caseName}-key`,
  scorer: "quality",
  kind: "score",
  value
})
const fault: ScoreGate.ScoreSample = {
  case: "missing",
  stepKey: "missing-key",
  scorer: "quality",
  kind: "inconclusive",
  reason: "judge unavailable"
}

describe("runtime score gates", () => {
  // N = 50 percentage points. These expectations do not call another grader.
  it.each(
    [
      [0.49, "Failed"],
      [0.5, "Passed"],
      [0.51, "Passed"]
    ] as const
  )("grades N-1/N/N+1 at score %s", async (value, tag) => {
    const gates = ScoreGate.expectScores([sample(value)])
    for (
      const [effect, code] of [
        [gates.mean(0.5), "mean_below_threshold"],
        [gates.min(0.5), "min_below_threshold"],
        [gates.perCase({ first: 0.5 }), "case_below_threshold"]
      ] as const
    ) {
      const reason = code === "case_below_threshold"
        ? `${code}: case 'first', threshold 0.5, actual 0.49`
        : `${code}: threshold 0.5, actual 0.49`
      expect(await Effect.runPromise(effect)).toEqual(
        tag === "Passed"
          ? { _tag: "Passed", inconclusive: [] }
          : { _tag: "Failed", reasons: [reason], inconclusive: [] }
      )
    }
  })

  it("averages all observations and takes each case's minimum", async () => {
    const gates = ScoreGate.expectScores([sample(0.75), sample(0.25), sample(1, "second")])
    expect(await Effect.runPromise(gates.mean(0.7))).toEqual({
      _tag: "Failed",
      reasons: ["mean_below_threshold: threshold 0.7, actual 0.666667"],
      inconclusive: []
    })
    expect(await Effect.runPromise(gates.min(0.5))).toEqual({
      _tag: "Failed",
      reasons: ["min_below_threshold: threshold 0.5, actual 0.25"],
      inconclusive: []
    })
    expect(await Effect.runPromise(gates.perCase({ first: 0.5, second: 1 }))).toEqual({
      _tag: "Failed",
      reasons: ["case_below_threshold: case 'first', threshold 0.5, actual 0.25"],
      inconclusive: []
    })
  })

  it("keeps empty measurements undecidable and an empty per-case gate vacuously passed", async () => {
    const gates = ScoreGate.expectScores([])
    expect(await Effect.runPromise(gates.mean(0))).toEqual({
      _tag: "Inconclusive",
      reasons: ["No score samples for mean gate"]
    })
    expect(await Effect.runPromise(gates.min(0))).toEqual({
      _tag: "Inconclusive",
      reasons: ["No score samples for min gate"]
    })
    expect(await Effect.runPromise(gates.perCase({ first: 0, second: 1 }))).toEqual({
      _tag: "Inconclusive",
      reasons: ["No score samples for case first", "No score samples for case second"]
    })
    expect(await Effect.runPromise(gates.perCase({}))).toEqual({ _tag: "Passed", inconclusive: [] })
  })

  it("reports faults once beside findings or passes without suppressing measurements", async () => {
    const gates = ScoreGate.expectScores([sample(0.5), fault, fault])
    expect(await Effect.runPromise(gates.mean(0.6))).toEqual({
      _tag: "Failed",
      reasons: ["mean_below_threshold: threshold 0.6, actual 0.5"],
      inconclusive: ["judge unavailable"]
    })
    expect(await Effect.runPromise(gates.min(0.5))).toEqual({
      _tag: "Passed",
      inconclusive: ["judge unavailable"]
    })
    expect(await Effect.runPromise(gates.perCase({ first: 0.5, missing: 1 }))).toEqual({
      _tag: "Passed",
      inconclusive: ["judge unavailable", "No score samples for case missing"]
    })
    expect(await Effect.runPromise(gates.perCase({ first: 0.6, missing: 1 }))).toEqual({
      _tag: "Failed",
      reasons: ["case_below_threshold: case 'first', threshold 0.6, actual 0.5"],
      inconclusive: ["judge unavailable", "No score samples for case missing"]
    })
    expect(await Effect.runPromise(ScoreGate.expectScores([fault]).mean(0))).toEqual({
      _tag: "Inconclusive",
      reasons: ["judge unavailable", "No score samples for mean gate"]
    })
  })

  it.each([-0.01, 1.01, Number.NaN, Infinity, -Infinity])("rejects threshold %s on every gate", async (threshold) => {
    const gates = ScoreGate.expectScores([sample(1)])
    for (const effect of [gates.mean(threshold), gates.min(threshold), gates.perCase({ first: threshold })]) {
      const error = await Effect.runPromise(Effect.flip(effect))
      expect(error).toBeInstanceOf(ScoreGate.ScoreGateError)
      expect(error._tag).toBe("ScoreGateError")
      expect(error.code).toBe("invalid_threshold")
      expect(error.threshold).toBe(threshold)
      expect(error.actual).toBeUndefined()
      expect(error.samples).toBeUndefined()
    }
  })

  it("accepts both score and threshold endpoints", async () => {
    for (const value of [0, 1]) {
      const gates = ScoreGate.expectScores([sample(value)])
      for (const effect of [gates.mean(value), gates.min(value), gates.perCase({ first: value })]) {
        expect(await Effect.runPromise(effect)).toEqual({ _tag: "Passed", inconclusive: [] })
      }
    }
  })

  it("names all invalid samples in input order and validates even an empty per-case gate", async () => {
    const samples = [
      sample(-0.01),
      sample(0),
      sample(1),
      fault,
      sample(1.01, "high"),
      sample(NaN, "nan"),
      sample(Infinity, "infinite"),
      sample(-Infinity, "negative-infinite")
    ]
    const gates = ScoreGate.expectScores(samples)
    for (const effect of [ScoreGate.validateSamples(samples), gates.mean(0), gates.min(0), gates.perCase({})]) {
      const error = await Effect.runPromise(Effect.flip(effect))
      expect(error).toBeInstanceOf(ScoreGate.ScoreGateError)
      expect(error._tag).toBe("ScoreGateError")
      expect(error.code).toBe("invalid_score")
      expect(error.actual).toBe(-0.01)
      expect(error.threshold).toBeUndefined()
      expect(error.samples).toEqual([
        { case: "first", stepKey: "first-key", scorer: "quality", value: -0.01 },
        { case: "high", stepKey: "high-key", scorer: "quality", value: 1.01 },
        { case: "nan", stepKey: "nan-key", scorer: "quality", value: NaN },
        { case: "infinite", stepKey: "infinite-key", scorer: "quality", value: Infinity },
        { case: "negative-infinite", stepKey: "negative-infinite-key", scorer: "quality", value: -Infinity }
      ])
    }
  })

  it("validates thresholds before samples and keeps the error schema unchanged", async () => {
    const error = await Effect.runPromise(Effect.flip(ScoreGate.expectScores([sample(NaN)]).mean(2)))
    expect(Schema.encodeSync(ScoreGate.ScoreGateError)(error)).toEqual({
      _tag: "ScoreGateError",
      code: "invalid_threshold",
      threshold: 2
    })
    expect(ScoreGate.ScoreGateCode.members.map((member) => member.literal)).toEqual([
      "invalid_threshold",
      "invalid_score",
      "mean_below_threshold",
      "min_below_threshold",
      "case_below_threshold"
    ])
  })

  it("names the case in every per-case breach so equal misses stay distinct", async () => {
    const verdict = await Effect.runPromise(
      ScoreGate.expectScores([sample(0.2, "translation"), sample(0.2, "summarization")])
        .perCase({ translation: 0.8, summarization: 0.8 })
    )
    expect(verdict).toEqual({
      _tag: "Failed",
      reasons: [
        "case_below_threshold: case 'translation', threshold 0.8, actual 0.2",
        "case_below_threshold: case 'summarization', threshold 0.8, actual 0.2"
      ],
      inconclusive: []
    })
    const summary = ScoreGate.grade(ScoreGate.combine([verdict])).summary
    expect(summary).toContain("case 'translation'")
    expect(summary).toContain("case 'summarization'")
  })

  it("grades grouped cases exactly as a per-case rescan of every sample does", async () => {
    const names = Array.from({ length: 40 }, (_, index) => `case-${index}`)
    const samples = [
      ...names.flatMap((caseName, index) => [sample((index % 10) / 10, caseName), sample(1, caseName)]),
      fault
    ]
    const thresholds = Object.fromEntries([
      ...names.map((caseName, index) => [caseName, index % 2 === 0 ? 0.5 : 0] as const),
      ["absent", 1] as const,
      ["missing", 1] as const
    ])
    const rescan = (caseName: string): ReadonlyArray<number> =>
      samples.flatMap((candidate) => candidate.case === caseName && candidate.kind === "score" ? [candidate.value] : [])
    const reasons = Object.entries(thresholds).flatMap(([caseName, threshold]) => {
      const values = rescan(caseName)
      if (values.length === 0) return []
      const actual = Math.min(...values)
      return actual < threshold
        ? [`case_below_threshold: case '${caseName}', threshold ${threshold}, actual ${actual}`]
        : []
    })
    expect(reasons.length).toBeGreaterThan(1)
    expect(await Effect.runPromise(ScoreGate.expectScores(samples).perCase(thresholds))).toEqual({
      _tag: "Failed",
      reasons,
      inconclusive: [
        "judge unavailable",
        "No score samples for case absent",
        "No score samples for case missing"
      ]
    })
  })

  it("reads each sample once however many cases a gate names", async () => {
    // A complexity pin, not a stopwatch: counting the reads of `case` is
    // stable under the load a timing assertion would misread. A gate that
    // rescans the sample list per named case reads every sample once per
    // name, so the two counts below diverge by a factor of `names.length`.
    let reads = 0
    const counted = (caseName: string, value: number): ScoreGate.ScoreSample => ({
      get case() {
        reads += 1
        return caseName
      },
      stepKey: `${caseName}-key`,
      scorer: "quality",
      kind: "score",
      value
    })
    const names = Array.from({ length: 50 }, (_, index) => `case-${index}`)
    const samples = names.flatMap((caseName) =>
      Array.from({ length: 20 }, (_, index) => counted(caseName, (index + 1) / 20))
    )
    const readsToGrade = async (named: ReadonlyArray<string>): Promise<number> => {
      reads = 0
      const thresholds = Object.fromEntries(named.map((caseName) => [caseName, 0] as const))
      expect(await Effect.runPromise(ScoreGate.expectScores(samples).perCase(thresholds))).toEqual({
        _tag: "Passed",
        inconclusive: []
      })
      return reads
    }
    const one = await readsToGrade(names.slice(0, 1))
    const every = await readsToGrade(names)
    expect(every).toEqual(one)
    // Bucketing reads a sample's case to look its bucket up, and once more to
    // create the bucket the first time a case is seen.
    expect(every).toBeLessThanOrEqual(samples.length + names.length)
  })

  it("takes minima beyond JavaScript's argument-count limit", async () => {
    const samples = Array.from({ length: 200_000 }, (_, index) => sample(index === 199_999 ? 0.25 : 0.75))
    const gates = ScoreGate.expectScores(samples)
    expect(await Effect.runPromise(gates.min(0.5))).toEqual({
      _tag: "Failed",
      reasons: ["min_below_threshold: threshold 0.5, actual 0.25"],
      inconclusive: []
    })
    expect(await Effect.runPromise(gates.perCase({ first: 0.5 }))).toEqual({
      _tag: "Failed",
      reasons: ["case_below_threshold: case 'first', threshold 0.5, actual 0.25"],
      inconclusive: []
    })
  })
})

describe("verdict composition and CI grades", () => {
  it("deduplicates in first-seen order and keeps findings ahead of undecidability", () => {
    expect(ScoreGate.combine([
      { _tag: "Passed", inconclusive: ["offline", "offline"] },
      { _tag: "Inconclusive", reasons: ["missing", "missing"] },
      { _tag: "Failed", reasons: ["low", "low"], inconclusive: ["offline", "late"] },
      { _tag: "Failed", reasons: ["low", "regression"], inconclusive: [] }
    ], ["external", "offline"])).toEqual({
      _tag: "Failed",
      reasons: ["low", "regression"],
      inconclusive: ["external", "offline", "late", "missing"]
    })
    expect(ScoreGate.combine([
      { _tag: "Passed", inconclusive: ["offline"] },
      { _tag: "Inconclusive", reasons: ["missing"] }
    ], ["external", "missing"])).toEqual({
      _tag: "Inconclusive",
      reasons: ["missing", "external", "offline"]
    })
    expect(ScoreGate.combine([], ["offline", "offline"])).toEqual({ _tag: "Inconclusive", reasons: ["offline"] })
    expect(ScoreGate.combine([])).toEqual({ _tag: "Passed", inconclusive: [] })
    expect(ScoreGate.combine([{ _tag: "Passed", inconclusive: ["offline"] }])).toEqual({
      _tag: "Passed",
      inconclusive: ["offline"]
    })
  })

  it("takes precedence from the verdict tag, not the length of its reason list", () => {
    const emptyFailure = ScoreGate.combine([{ _tag: "Failed", reasons: [], inconclusive: [] }])
    expect(emptyFailure).toEqual({
      _tag: "Failed",
      reasons: ["A gate failed without a stated reason"],
      inconclusive: []
    })
    expect(ScoreGate.grade(emptyFailure).exitCode).toBe(1)
    const emptyUndecidable = ScoreGate.combine([{ _tag: "Inconclusive", reasons: [] }])
    expect(emptyUndecidable).toEqual({
      _tag: "Inconclusive",
      reasons: ["A gate was undecidable without a stated reason"]
    })
    expect(ScoreGate.grade(emptyUndecidable).exitCode).toBe(5)
    // A stated failure outranks a stated undecidable gate even with no reason
    // of its own, and observed faults still stand in for absent reasons.
    expect(ScoreGate.combine([
      { _tag: "Failed", reasons: [], inconclusive: [] },
      { _tag: "Inconclusive", reasons: ["missing"] }
    ])).toEqual({
      _tag: "Failed",
      reasons: ["A gate failed without a stated reason"],
      inconclusive: ["missing"]
    })
    expect(ScoreGate.combine([{ _tag: "Inconclusive", reasons: [] }], ["offline"])).toEqual({
      _tag: "Inconclusive",
      reasons: ["offline"]
    })
  })

  it.each(
    [
      [{ _tag: "Passed", inconclusive: [] }, { exitCode: 0, summary: "passed" }],
      [{ _tag: "Passed", inconclusive: ["offline", "missing"] }, {
        exitCode: 5,
        summary: "passed every gate with unresolved: offline; missing"
      }],
      [{ _tag: "Failed", reasons: ["low", "regression"], inconclusive: [] }, {
        exitCode: 1,
        summary: "failed: low; regression"
      }],
      [{ _tag: "Failed", reasons: ["low"], inconclusive: ["offline", "missing"] }, {
        exitCode: 1,
        summary: "failed: low; unresolved: offline; missing"
      }],
      [{ _tag: "Inconclusive", reasons: ["offline", "missing"] }, {
        exitCode: 5,
        summary: "inconclusive: offline; missing"
      }]
    ] satisfies ReadonlyArray<readonly [ScoreGate.Verdict, { readonly exitCode: number; readonly summary: string }]>
  )("renders the complete grade for %j", (verdict, expected) => {
    expect(ScoreGate.grade(verdict)).toEqual(expected)
  })
})
