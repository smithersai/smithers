import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { describe, expect, it } from "vitest"
import * as CaseExecutor from "../src/CaseExecutor.ts"
import { EvalError } from "../src/EvalError.ts"
import * as Gate from "../src/Gate.ts"
import * as Regression from "../src/Regression.ts"
import * as Runner from "../src/Runner.ts"
import * as Suite from "../src/Suite.ts"

const report = (
  observations: ReadonlyArray<Runner.Observation>
): Regression.Report => ({
  suite: "s",
  baseline: { version: 1 as const, suite: "s", records: [] },
  run: { runId: "run", suite: "s", cases: [], observations },
  regressions: [],
  nondeterminism: [],
  missing: [],
  samples: observations.filter((entry): entry is Extract<Runner.Observation, { kind: "score" }> =>
    entry.kind === "score"
  ),
  inconclusive: observations.filter((entry): entry is Extract<Runner.Observation, { kind: "inconclusive" }> =>
    entry.kind === "inconclusive"
  )
})

const scored = (score: number, caseName = "c"): Runner.Observation => ({
  case: caseName,
  scorer: "s",
  stepKey: "k",
  kind: "score",
  score,
  at: "t"
})

const undecided: Runner.Observation = {
  case: "c",
  scorer: "s",
  stepKey: "k",
  kind: "inconclusive",
  reason: "unavailable",
  at: "t"
}

describe("Gate", () => {
  it("delegates threshold arithmetic and leaves an unobservable run undecided", async () => {
    const failed = await Effect.runPromise(Gate.check(report([scored(0.2)]), { min: 0.5 }))
    expect(failed).toMatchObject({ _tag: "Failed", reasons: ["min_below_threshold: threshold 0.5, actual 0.2"] })

    const inconclusive = await Effect.runPromise(Gate.check(report([undecided]), { min: 0.5 }))
    expect(inconclusive._tag).toBe("Inconclusive")
  })

  it("applies the mean and per-case gates it was given", async () => {
    const mean = await Effect.runPromise(Gate.check(report([scored(0.2), scored(0.4, "d")]), { mean: 0.9 }))
    expect(mean).toMatchObject({ _tag: "Failed", reasons: [expect.stringContaining("mean_below_threshold")] })

    const perCase = await Effect.runPromise(
      Gate.check(report([scored(0.2), scored(0.9, "d")]), { perCase: { c: 0.5 } })
    )
    expect(perCase).toMatchObject({ _tag: "Failed", reasons: [expect.stringContaining("case_below_threshold")] })

    const passed = await Effect.runPromise(Gate.check(report([scored(1)]), { mean: 1, min: 1, perCase: { c: 1 } }))
    expect(Gate.ciGrade(passed)).toEqual({ exitCode: 0, summary: "passed" })
  })

  it("propagates a gate misuse through the error channel", async () => {
    const exit = await Effect.runPromiseExit(Gate.check(report([scored(1)]), { mean: 2 }))
    expect(exit._tag).toBe("Failure")
  })

  it("preserves inconclusive without configured thresholds", async () => {
    const verdict = await Effect.runPromise(Gate.check(report([undecided])))
    expect(Gate.ciGrade(verdict).exitCode).toBe(5)
  })

  // A regression is a measurement: the run scored lower than the baseline it
  // is gated on. Folding it in with the environment faults reported exit 5,
  // which the CI convention treats as a harness to repair rather than a red.
  it("fails a run that regressed or moved against its baseline", async () => {
    const observation = scored(0) as Extract<Runner.Observation, { kind: "score" }>
    const baselineRecord = { suite: "s", case: "c", scorer: "s", stepKey: "baseline", score: 1 }
    const verdict = await Effect.runPromise(
      Gate.check({
        ...report([observation]),
        regressions: [{ case: "c", scorer: "s", baseline: baselineRecord, actual: observation, drop: 1 }],
        nondeterminism: [{ case: "c", scorer: "s", baseline: baselineRecord, actual: observation, delta: -1 }]
      }, { mean: 0 })
    )
    expect(verdict).toMatchObject({
      _tag: "Failed",
      reasons: [expect.stringContaining("regression for c/s"), expect.stringContaining("nondeterminism for c/s")]
    })
    expect(Gate.ciGrade(verdict).exitCode).toBe(1)
  })

  it("runs the threshold gates when an observation is missing, and reports both", async () => {
    const verdict = await Effect.runPromise(
      Gate.check({
        ...report([scored(0.1)]),
        missing: [{ side: "run" as const, case: "other", scorer: "s", stepKey: "k" }]
      }, { mean: 0.9 })
    )
    expect(verdict).toMatchObject({
      _tag: "Failed",
      reasons: [expect.stringContaining("mean_below_threshold")],
      inconclusive: [expect.stringContaining("missing run")]
    })
    expect(Gate.ciGrade(verdict).exitCode).toBe(1)
  })

  it("uses readable scorer labels in findings and faults, with a key fallback", async () => {
    const named = {
      ...scored(0),
      scorer: "0123456789abcdef",
      scorerName: "exact"
    } as Extract<Runner.Observation, { kind: "score" }>
    const baselineRecord = {
      suite: "s",
      case: "c",
      scorer: named.scorer,
      scorerName: named.scorerName,
      stepKey: "baseline",
      score: 1
    }
    const verdict = await Effect.runPromise(
      Gate.check({
        ...report([named]),
        regressions: [{ case: "c", scorer: named.scorer, baseline: baselineRecord, actual: named, drop: 1 }],
        nondeterminism: [{ case: "c", scorer: named.scorer, baseline: baselineRecord, actual: named, delta: -1 }],
        missing: [
          { side: "run", case: "named", scorer: named.scorer, scorerName: "exact", stepKey: "k" },
          { side: "baseline", case: "bare", scorer: "bare-key", stepKey: "k" }
        ]
      }, { mean: 0 })
    )
    const summary = Gate.ciGrade(verdict).summary
    expect(summary).toContain("regression for c/exact (01234567)")
    expect(summary).toContain("nondeterminism for c/exact (01234567)")
    expect(summary).toContain("missing run observation for named/exact (01234567)/k")
    expect(summary).toContain("missing baseline observation for bare/bare-key/k")
  })

  // The gate summary used to print only the message, which the runner had
  // already replaced with a fixed sentence, so CI printed a tautology.
  it("names the code and the original message of a case the target failed", async () => {
    const suite = await Effect.runPromise(
      Suite.make({ name: "s", concurrency: 1, cases: [{ name: "c", input: 1 }] })
    )
    const executor = Layer.succeed(CaseExecutor.CaseExecutor)(
      CaseExecutor.make(() =>
        Effect.fail(
          new EvalError({
            code: "invalid_suite",
            message: "the fixture file evals/x.jsonl is missing its expected column"
          })
        )
      )
    )
    const run = await Effect.runPromise(
      Runner.run(suite, { runId: "run", at: "2026-01-01T00:00:00.000Z" }).pipe(Effect.provide(executor))
    )
    const healthy = { ...run, cases: [...run.cases, { case: "healthy", observations: [] }] }
    const comparison = await Effect.runPromise(Regression.compare({ version: 1, suite: "s", records: [] }, healthy))
    const verdict = await Effect.runPromise(Gate.check(comparison))
    expect(verdict._tag).toBe("Inconclusive")
    expect(Gate.ciGrade(verdict).summary).toContain(
      "case 'c' failed: invalid_suite: Target failed for case 'c': the fixture file evals/x.jsonl is missing its expected column"
    )
    expect(Gate.ciGrade(verdict).exitCode).toBe(5)
  })

  it("never lets a verdict reason print its own CI log line", async () => {
    // A verdict reason is text from a baseline, a step key or a target's failure.
    // The summary goes to stdout, where a newline is a forged workflow command
    // on GitHub Actions and an ESC sequence rewrites the visible log.
    const verdict = await Effect.runPromise(
      Gate.check({
        ...report([]),
        run: {
          runId: "run",
          suite: "s",
          cases: [{
            case: "d",
            error: new EvalError({ code: "executor", message: "boom\n::error::forged from target" }),
            observations: []
          }],
          observations: []
        },
        missing: [
          { side: "run" as const, case: "c\n::stop-commands::x\n\u001b[2Kpassed", scorer: "s", stepKey: "k" },
          { side: "baseline" as const, case: "d", scorer: "s", stepKey: "step\n::warning::forged\u007f" }
        ]
      })
    )
    const { summary } = Gate.ciGrade(verdict)

    expect(summary).not.toMatch(/[\u0000-\u001F\u007F]/u)
    expect(summary.split("\n")).toHaveLength(1)
    expect(summary).toContain("boom ::error::forged from target")
    expect(summary).toContain("c ::stop-commands::x  [2Kpassed/s/k")
    expect(summary).toContain("d/s/step ::warning::forged ")
  })

  it("stays undecided on incomplete regression evidence", async () => {
    const missing = await Effect.runPromise(
      Gate.check({ ...report([]), missing: [{ side: "run" as const, case: "c", scorer: "s", stepKey: "k" }] })
    )
    expect(missing).toMatchObject({
      _tag: "Inconclusive",
      reasons: expect.arrayContaining([expect.stringContaining("missing run")])
    })
  })
})
