import * as Effect from "effect/Effect"
import { describe, test } from "vitest"
import * as Baseline from "../src/Baseline.ts"
import * as Gate from "../src/Gate.ts"
import * as Regression from "../src/Regression.ts"
import * as Report from "../src/Report.ts"
import type * as Runner from "../src/Runner.ts"

const caseCount = 200

const baselineRecords: Baseline.Baseline["records"] = Array.from({ length: caseCount }, (_, i) => ({
  suite: "bench-suite",
  case: `case-${i}`,
  scorer: i % 2 === 0 ? "exact" : "semantic",
  stepKey: "step-1",
  score: 0.9
}))

const baseline: Baseline.Baseline = {
  version: 1,
  suite: "bench-suite",
  records: baselineRecords
}

const observations: ReadonlyArray<Runner.Observation> = Array.from({ length: caseCount }, (_, i) => ({
  case: `case-${i}`,
  scorer: i % 2 === 0 ? "exact" : "semantic",
  stepKey: "step-1",
  kind: "score",
  score: i % 25 === 0 ? 0.85 : 0.92,
  at: "2026-11-22T00:00:00Z"
}))

const runResult: Runner.RunResult = {
  runId: "run-bench-1",
  suite: "bench-suite",
  cases: [],
  observations
}

const serializedBaseline = Baseline.write(baseline)
const sampleReport = Effect.runSync(Regression.compare(baseline, runResult, { absolute: 0.02 }))

describe("evals hot paths", () => {
  test("Baseline.load and write", async ({ bench }) => {
    await bench("load 200-record baseline JSON", () => {
      Effect.runSync(Baseline.load(serializedBaseline))
    }).run({ time: 120, warmupTime: 30 })
  })

  test("Regression.compare", async ({ bench }) => {
    await bench("compare 200 observations against baseline", () => {
      Effect.runSync(Regression.compare(baseline, runResult, { absolute: 0.02 }))
    }).run({ time: 120, warmupTime: 30 })
  })

  test("Gate.check", async ({ bench }) => {
    await bench("evaluate mean/min/perCase gate over 200 observations", () => {
      Effect.runSync(Gate.check(sampleReport, { mean: 0.85, min: 0.8, perCase: { "case-0": 0.8 } }))
    }).run({ time: 120, warmupTime: 30 })
  })

  test("Report.markdown and Report.json", async ({ bench }) => {
    await bench("render 200-case markdown + JSON report", () => {
      Report.markdown(sampleReport)
      Report.json(sampleReport)
    }).run({ time: 120, warmupTime: 30 })
  })
})
