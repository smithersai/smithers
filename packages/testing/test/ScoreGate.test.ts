import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { ScriptTarget, transpileModule } from "typescript"
import { describe, expect, it } from "vitest"
import * as ScoreGate from "../src/ScoreGate.ts"
import { ScoreGateError } from "../src/TestingError.vibe"

const samples: ReadonlyArray<ScoreGate.ScoreSample> = [
  { case: "first", stepKey: "first-key", scorer: "quality", kind: "score", value: 0.9 },
  { case: "second", stepKey: "second-key", scorer: "quality", kind: "score", value: 0.8 }
]

const expectFailure = async (
  effect: Effect.Effect<unknown, ScoreGateError>,
  code: string,
  threshold: number
) => {
  const error = await Effect.runPromise(effect.pipe(Effect.flip))
  expect(error).toBeInstanceOf(ScoreGateError)
  expect(error.code).toBe(code)
  expect(error.threshold).toBe(threshold)
}

// A gate the scores missed is a finding in the success channel, not a raised
// error: the report has to survive it.
const expectMiss = async (effect: Effect.Effect<ScoreGate.Verdict, ScoreGateError>, reason: string) => {
  expect(await Effect.runPromise(effect)).toMatchObject({ _tag: "Failed", reasons: [reason] })
}

describe("ScoreGate", () => {
  it("passes mean, minimum, and per-case gates", async () => {
    const clean = { _tag: "Passed", inconclusive: [] }
    await expect(Effect.runPromise(ScoreGate.expectScores(samples).mean(0.8))).resolves.toEqual(clean)
    await expect(Effect.runPromise(ScoreGate.expectScores(samples).min(0.8))).resolves.toEqual(clean)
    await expect(Effect.runPromise(ScoreGate.expectScores(samples).perCase({ first: 0.9, second: 0.8 }))).resolves
      .toEqual(clean)
  })

  it("reports a mean threshold miss", async () => {
    await expectMiss(ScoreGate.expectScores(samples).mean(0.86), "mean_below_threshold: threshold 0.86, actual 0.85")
  })

  it("reports a minimum threshold miss", async () => {
    await expectMiss(ScoreGate.expectScores(samples).min(0.85), "min_below_threshold: threshold 0.85, actual 0.8")
  })

  it("reports a per-case threshold miss", async () => {
    await expectMiss(
      ScoreGate.expectScores(samples).perCase({ second: 0.85 }),
      "case_below_threshold: case 'second', threshold 0.85, actual 0.8"
    )
  })

  it("grades inconclusive observations without turning them into score failures", async () => {
    const verdict = await Effect.runPromise(
      ScoreGate.expectScores([
        { case: "first", stepKey: "first-key", scorer: "quality", kind: "inconclusive", reason: "judge unavailable" }
      ]).mean(0.9)
    )
    expect(verdict).toEqual({ _tag: "Inconclusive", reasons: ["judge unavailable", "No score samples for mean gate"] })
  })

  it("keeps an empty gate set with an environment fault inconclusive", () => {
    expect(ScoreGate.combine([], ["runner unavailable"])).toEqual({
      _tag: "Inconclusive",
      reasons: ["runner unavailable"]
    })
  })

  it("reports an unmeasurable minimum gate", async () => {
    const verdict = await Effect.runPromise(
      ScoreGate.expectScores([
        { case: "first", stepKey: "first-key", scorer: "quality", kind: "inconclusive", reason: "judge unavailable" }
      ]).min(0.9)
    )
    expect(verdict).toEqual({ _tag: "Inconclusive", reasons: ["judge unavailable", "No score samples for min gate"] })
  })

  it("passes an empty per-case gate and grades unresolved passes as inconclusive", async () => {
    const verdict = await Effect.runPromise(
      ScoreGate.expectScores([
        { case: "first", stepKey: "first-key", scorer: "quality", kind: "inconclusive", reason: "judge unavailable" }
      ]).perCase({})
    )
    expect(verdict).toEqual({ _tag: "Passed", inconclusive: ["judge unavailable"] })
    expect(ScoreGate.grade(verdict)).toEqual({
      exitCode: 5,
      summary: "passed every gate with unresolved: judge unavailable"
    })
  })

  // One unavailable judge used to disable every gate: the early return fired
  // before the arithmetic ran, so 99 good scores went ungated.
  it("evaluates gates over the scores that exist and reports the fault alongside", async () => {
    const withFault: ReadonlyArray<ScoreGate.ScoreSample> = [
      ...samples,
      { case: "third", stepKey: "third-key", scorer: "quality", kind: "inconclusive", reason: "judge unavailable" }
    ]
    await expect(Effect.runPromise(ScoreGate.expectScores(withFault).mean(0.8))).resolves.toEqual({
      _tag: "Passed",
      inconclusive: ["judge unavailable"]
    })
    await expect(Effect.runPromise(ScoreGate.expectScores(withFault).min(0.7))).resolves.toEqual({
      _tag: "Passed",
      inconclusive: ["judge unavailable"]
    })
  })

  it("fails a gate the surviving scores miss instead of grading it inconclusive", async () => {
    const withFault: ReadonlyArray<ScoreGate.ScoreSample> = [
      ...samples,
      { case: "third", stepKey: "third-key", scorer: "quality", kind: "inconclusive", reason: "judge unavailable" }
    ]
    await expect(Effect.runPromise(ScoreGate.expectScores(withFault).mean(0.95))).resolves.toEqual({
      _tag: "Failed",
      reasons: ["mean_below_threshold: threshold 0.95, actual 0.85"],
      inconclusive: ["judge unavailable"]
    })
    await expect(Effect.runPromise(ScoreGate.expectScores(withFault).perCase({ second: 0.85 }))).resolves
      .toMatchObject({
        _tag: "Failed",
        reasons: ["case_below_threshold: case 'second', threshold 0.85, actual 0.8"]
      })
  })

  // The error used to carry `threshold: 0`, a placeholder with no meaning for
  // this code, and nothing at all identifying which sample was invalid.
  it("rejects invalid scores and names every offending sample", async () => {
    const error = await Effect.runPromise(
      ScoreGate.expectScores([
        { case: "first", stepKey: "first-key", scorer: "quality", kind: "score", value: Number.NaN },
        { case: "second", stepKey: "second-key", scorer: "safety", kind: "score", value: 1.5 },
        { case: "third", stepKey: "third-key", scorer: "quality", kind: "score", value: 0.5 }
      ]).mean(0.5).pipe(Effect.flip)
    )
    expect(error).toBeInstanceOf(ScoreGateError)
    expect(error.code).toBe("invalid_score")
    expect(error.threshold).toBeUndefined()
    expect(error.samples).toEqual([
      { case: "first", stepKey: "first-key", scorer: "quality", value: Number.NaN },
      { case: "second", stepKey: "second-key", scorer: "safety", value: 1.5 }
    ])
  })

  it("rejects invalid thresholds without echoing the threshold as an observation", async () => {
    for (
      const effect of [
        ScoreGate.expectScores(samples).mean(1.1),
        ScoreGate.expectScores(samples).min(Number.NaN),
        ScoreGate.expectScores(samples).perCase({ first: -0.1 })
      ]
    ) {
      const error = await Effect.runPromise(effect.pipe(Effect.flip))
      expect(error.code).toBe("invalid_threshold")
      expect(error.actual).toBeUndefined()
    }
    await expectFailure(ScoreGate.expectScores(samples).mean(1.1), "invalid_threshold", 1.1)
  })

  // `Math.min(...values)` throws a RangeError above the engine's
  // argument-count limit, out of a module whose failures are otherwise a
  // closed code union.
  it("takes a minimum over more samples than an argument list can hold", async () => {
    const many: ReadonlyArray<ScoreGate.ScoreSample> = Array.from({ length: 200_000 }, (_, index) => ({
      case: "bulk",
      stepKey: `bulk-${index}`,
      scorer: "quality",
      kind: "score",
      value: index === 199_999 ? 0.2 : 0.9
    }))
    await expect(Effect.runPromise(ScoreGate.expectScores(many).min(0.5))).resolves.toMatchObject({
      _tag: "Failed",
      reasons: ["min_below_threshold: threshold 0.5, actual 0.2"]
    })
    await expect(Effect.runPromise(ScoreGate.expectScores(many).perCase({ bulk: 0.5 }))).resolves.toMatchObject({
      _tag: "Failed"
    })
  })
})

describe("ScoreGate.suite", () => {
  const cases: ReadonlyArray<ScoreGate.SuiteCase<string>> = [
    { name: "first", input: "a", minScore: 0.7 },
    { name: "second", input: "b" }
  ]
  const sampleFor = (name: string, value: number): ScoreGate.ScoreSample => ({
    case: name,
    stepKey: `${name}-key`,
    scorer: "quality",
    kind: "score",
    value
  })

  it("runs every case, applies gates, and passes", async () => {
    const report = await Effect.runPromise(
      ScoreGate.suite({
        cases,
        run: (suiteCase) => Effect.succeed([sampleFor(suiteCase.name, 0.9)]),
        gates: { mean: 0.8, min: 0.7 }
      })
    )
    expect(report.verdict).toEqual({ _tag: "Passed", inconclusive: [] })
    expect(report.cases).toHaveLength(2)
    expect(report.samples).toHaveLength(2)
    expect(ScoreGate.ciGrade(report).exitCode).toBe(0)
  })

  it("reports a gate miss as a failed verdict on a complete report", async () => {
    const report = await Effect.runPromise(
      ScoreGate.suite({
        cases,
        run: (suiteCase) => Effect.succeed([sampleFor(suiteCase.name, 0.6)]),
        gates: { mean: 0.8 }
      })
    )
    // Every declared gate is reported, not just the first one to break.
    expect(report.verdict).toMatchObject({
      _tag: "Failed",
      reasons: [
        "mean_below_threshold: threshold 0.8, actual 0.6",
        "case_below_threshold: case 'first', threshold 0.7, actual 0.6"
      ]
    })
    expect(report.cases).toHaveLength(2)
    expect(ScoreGate.ciGrade(report).exitCode).toBe(1)
  })

  it("still raises a typed error when a threshold is misused", async () => {
    const error = await Effect.runPromise(
      ScoreGate.suite({
        cases,
        run: (suiteCase) => Effect.succeed([sampleFor(suiteCase.name, 0.6)]),
        gates: { mean: 42 }
      }).pipe(Effect.flip)
    )
    expect(error).toBeInstanceOf(ScoreGateError)
    expect(error.code).toBe("invalid_threshold")
  })

  // One environment fault used to return before the gates were built, so a
  // suite whose every finished case scored far below its gate reported
  // "inconclusive" and CI read exit 5 rather than a red.
  it("fails the suite the finished cases missed, and still reports the fault", async () => {
    const many = Array.from({ length: 49 }, (_, index) => ({ name: `case-${index}`, input: "a" }))
    const report = await Effect.runPromise(
      ScoreGate.suite({
        cases: [...many, { name: "unavailable", input: "b" }],
        run: (suiteCase) =>
          suiteCase.name === "unavailable"
            ? Effect.fail(new Error("judge unavailable"))
            : Effect.succeed([sampleFor(suiteCase.name, 0.1)]),
        gates: { mean: 0.9 }
      })
    )
    expect(report.verdict._tag).toBe("Failed")
    expect(report.samples).toHaveLength(49)
    const grade = ScoreGate.ciGrade(report)
    expect(grade.exitCode).toBe(1)
    expect(grade.summary).toContain("mean_below_threshold")
    expect(grade.summary).toContain("judge unavailable")
  })

  // Validation used to live inside the individual gates, so a suite that
  // declared none never checked its samples and a NaN reached the report under
  // a passing verdict.
  it("validates samples even when the suite declares no gates", async () => {
    const error = await Effect.runPromise(
      ScoreGate.suite({
        cases: [{ name: "first", input: "a" }],
        run: () => Effect.succeed([sampleFor("first", Number.NaN)])
      }).pipe(Effect.flip)
    )
    expect(error.code).toBe("invalid_score")
    expect(error.samples).toHaveLength(1)
  })

  it("grades a suite with no cases inconclusive rather than passed", async () => {
    const report = await Effect.runPromise(ScoreGate.suite({ cases: [], run: () => Effect.succeed([]) }))
    expect(report.verdict).toEqual({ _tag: "Inconclusive", reasons: ["The suite declared no cases"] })
    expect(ScoreGate.ciGrade(report).exitCode).toBe(5)
  })

  it("keeps inconclusive observations in a mixed ungated suite", async () => {
    const report = await Effect.runPromise(
      ScoreGate.suite({
        cases: [{ name: "first", input: "a" }],
        run: () =>
          Effect.succeed([
            sampleFor("first", 0.9),
            {
              case: "first",
              stepKey: "first-key",
              scorer: "safety",
              kind: "inconclusive",
              reason: "judge unavailable"
            } as const
          ])
      })
    )
    expect(report.samples).toHaveLength(2)
    expect(ScoreGate.ciGrade(report)).toEqual({
      exitCode: 5,
      summary: "inconclusive: judge unavailable"
    })
    expect(report.verdict).toEqual({ _tag: "Inconclusive", reasons: ["judge unavailable"] })
  })

  it("counts only score observations in a clean-pass summary", () => {
    expect(ScoreGate.ciGrade({
      cases: [],
      samples: [
        sampleFor("first", 0.9),
        { case: "first", stepKey: "first-key", scorer: "safety", kind: "inconclusive", reason: "judge unavailable" }
      ],
      verdict: { _tag: "Passed", inconclusive: [] }
    })).toEqual({ exitCode: 0, summary: "passed: 0 case(s), 1 sample(s)" })
  })

  it("runs the guide's suite before grading it for CI", async () => {
    const guide = readFileSync(new URL("../docs/guides/gate-a-scored-suite.md", import.meta.url), "utf8")
    const recipe = guide.slice(guide.indexOf("## Run a whole suite"), guide.indexOf("## Validate samples"))
    const source = [...recipe.matchAll(/```ts\n([\s\S]*?)```/g)]
      .map((match) => match[1])
      .join("\n")
      .replace(/^import .*$/gm, "")
    const { outputText } = transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2022 } })
    const output: Array<string> = []
    const process = { exitCode: undefined as number | undefined }
    const run = new Function("ScoreGate", "Effect", "console", "process", `return (async () => {${outputText}})()`)
    await run(ScoreGate, Effect, { log: (line: string) => output.push(line) }, process)
    expect(process.exitCode).toBe(0)
    expect(output).toEqual(["passed: 2 case(s), 2 sample(s)"])
  })

  it("grades a wholly inconclusive ungated suite inconclusive rather than passed", async () => {
    const report = await Effect.runPromise(
      ScoreGate.suite({
        cases: [{ name: "first", input: "a" }],
        run: () =>
          Effect.succeed([
            {
              case: "first",
              stepKey: "first-key",
              scorer: "quality",
              kind: "inconclusive",
              reason: "judge unavailable"
            } as const
          ])
      })
    )
    expect(report.verdict._tag).toBe("Inconclusive")
    expect(ScoreGate.ciGrade(report).exitCode).toBe(5)
  })

  // A runner bug used to attribute a sample to another case, and the per-case
  // gate then measured the wrong one.
  it("binds every sample to the case that produced it", async () => {
    const report = await Effect.runPromise(
      ScoreGate.suite({
        cases: [{ name: "first", input: "a", minScore: 0.8 }, { name: "second", input: "b" }],
        run: (suiteCase) => Effect.succeed([sampleFor(suiteCase.name === "second" ? "first" : "first", 0.1)])
      })
    )
    expect(report.samples.map((sample) => sample.case)).toEqual(["first", "second"])
    expect(report.verdict).toMatchObject({
      _tag: "Failed",
      reasons: ["case_below_threshold: case 'first', threshold 0.8, actual 0.1"]
    })
  })

  // Nothing was measured here, so there is no finding to report: an unusable
  // harness stays exit 5.
  it("grades environment faults inconclusive with CI exit code 5, never failed", async () => {
    const report = await Effect.runPromise(
      ScoreGate.suite({
        cases,
        run: () => Effect.fail(new Error("judge unavailable")),
        gates: { mean: 0.99 }
      })
    )
    expect(report.verdict._tag).toBe("Inconclusive")
    const grade = ScoreGate.ciGrade(report)
    expect(grade.exitCode).toBe(5)
    expect(grade.summary).toContain("judge unavailable")
  })
})
