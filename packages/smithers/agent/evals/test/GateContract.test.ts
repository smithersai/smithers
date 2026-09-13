import * as ScoreGate from "@smthrs/scorers/ScoreGate"
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as Gate from "../src/Gate.ts"
import type * as Regression from "../src/Regression.ts"
import type * as Runner from "../src/Runner.ts"

const report = (observations: ReadonlyArray<Runner.Observation>): Regression.Report => ({
  suite: "contract",
  baseline: { version: 1, suite: "contract", records: [] },
  run: { runId: "run", suite: "contract", cases: [], observations },
  regressions: [],
  nondeterminism: [],
  missing: [],
  samples: [],
  inconclusive: []
})

describe("evals runtime grading contract", () => {
  it.each(
    [
      [0.49, {
        _tag: "Failed",
        reasons: [
          "mean_below_threshold: threshold 0.5, actual 0.49",
          "min_below_threshold: threshold 0.5, actual 0.49",
          "case_below_threshold: case 'first', threshold 0.5, actual 0.49"
        ],
        inconclusive: []
      }, {
        exitCode: 1,
        summary:
          "failed: mean_below_threshold: threshold 0.5, actual 0.49; min_below_threshold: threshold 0.5, actual 0.49; case_below_threshold: case 'first', threshold 0.5, actual 0.49"
      }],
      [0.5, { _tag: "Passed", inconclusive: [] }, { exitCode: 0, summary: "passed" }],
      [0.51, { _tag: "Passed", inconclusive: [] }, { exitCode: 0, summary: "passed" }]
    ] satisfies ReadonlyArray<
      readonly [number, ScoreGate.Verdict, { readonly exitCode: number; readonly summary: string }]
    >
  )("preserves all threshold verdicts at score %s", async (score, expected, grade) => {
    const verdict: ScoreGate.Verdict = await Effect.runPromise(Gate.check(
      report([{
        case: "first",
        scorer: "quality",
        stepKey: "key",
        kind: "score",
        score,
        at: "now"
      }]),
      { mean: 0.5, min: 0.5, perCase: { first: 0.5 } }
    ))
    expect(verdict).toEqual(expected)
    expect(Gate.ciGrade(verdict)).toEqual(grade)
  })

  it("keeps empty runs undecidable through the default gate", async () => {
    const verdict = await Effect.runPromise(Gate.check(report([])))
    expect(verdict).toEqual({ _tag: "Inconclusive", reasons: ["No score samples for mean gate"] })
    expect(Gate.ciGrade(verdict)).toEqual({ exitCode: 5, summary: "inconclusive: No score samples for mean gate" })
  })

  it("preserves findings alongside unresolved observations", async () => {
    const verdict = await Effect.runPromise(Gate.check(
      report([
        { case: "first", scorer: "quality", stepKey: "key", kind: "score", score: 0.25, at: "now" },
        { case: "second", scorer: "quality", stepKey: "other", kind: "inconclusive", reason: "offline", at: "now" }
      ]),
      { mean: 0.5 }
    ))
    expect(verdict).toEqual({
      _tag: "Failed",
      reasons: ["mean_below_threshold: threshold 0.5, actual 0.25"],
      inconclusive: ["offline"]
    })
    expect(Gate.ciGrade(verdict)).toEqual({
      exitCode: 1,
      summary: "failed: mean_below_threshold: threshold 0.5, actual 0.25; unresolved: offline"
    })
  })

  it("exposes the scorers error class for invalid thresholds and observations", async () => {
    const threshold = await Effect.runPromise(Effect.flip(Gate.check(report([]), { min: 2 })))
    expect(threshold).toBeInstanceOf(ScoreGate.ScoreGateError)
    expect(threshold._tag).toBe("ScoreGateError")
    expect(threshold.code).toBe("invalid_threshold")
    expect(threshold.threshold).toBe(2)
    expect(threshold.actual).toBeUndefined()
    const score = await Effect.runPromise(Effect.flip(Gate.check(report([{
      case: "bad",
      scorer: "quality",
      stepKey: "key",
      kind: "score",
      score: -0.01,
      at: "now"
    }]))))
    expect(score).toBeInstanceOf(ScoreGate.ScoreGateError)
    expect(score.code).toBe("invalid_score")
    expect(score.actual).toBe(-0.01)
    expect(score.threshold).toBeUndefined()
    expect(score.samples).toEqual([{ case: "bad", scorer: "quality", stepKey: "key", value: -0.01 }])
  })
})
