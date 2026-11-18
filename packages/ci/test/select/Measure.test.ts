import { describe, expect, it } from "vitest"
import type { Row, Score } from "../../src/contract/Selection.ts"
import { day, type Observation } from "../../src/select/Features.ts"
import * as Measure from "../../src/select/Measure.ts"

const now = Date.UTC(2026, 10, 14)

const row = (commit: string, target: string, failed = false, flaky = false): Row => ({
  commit,
  target,
  features: {
    extensions: [".ts"],
    fileChanges: { d3: 0, d14: 0, d56: 0 },
    failureRates: { d7: 0, d14: 0, d28: 0, d56: 0 },
    project: "packages/a",
    testCount: 1,
    graphDistance: 0
  },
  attempts: [!failed],
  failed,
  flaky
})

const seen = (at: number, commit: string, target: string): Observation => ({ at, row: row(commit, target) })

const score = (commit: string, target: string, value: number): Score => ({ commit, target, score: value })

// Three changes. c1 fails a and b, c2 fails a, c3 fails nothing; c is flaky once.
const rows = [
  row("c1", "//a:test", true),
  row("c1", "//b:test", true),
  row("c1", "//c:test"),
  row("c2", "//a:test", true),
  row("c2", "//b:test"),
  row("c2", "//c:test", false, true),
  row("c3", "//a:test"),
  row("c3", "//b:test"),
  row("c3", "//c:test")
]
const scores = [
  score("c1", "//a:test", 0.9),
  score("c1", "//b:test", 0.04),
  score("c1", "//c:test", 0.01),
  score("c2", "//a:test", 0.3),
  score("c2", "//b:test", 0.2),
  score("c2", "//c:test", 0.01),
  score("c3", "//a:test", 0.02),
  score("c3", "//b:test", 0.01),
  score("c3", "//c:test", 0.01)
]

describe("split", () => {
  it("takes the newest week as the test set and everything before it as history", () => {
    const observations = [
      seen(now - 30 * day, "c1", "//a:test"),
      seen(now - 7 * day, "c2", "//a:test"),
      seen(now - 7 * day + 1, "c3", "//a:test"),
      seen(now, "c4", "//a:test")
    ]
    const split = Measure.split(observations)
    expect(split.to).toBe(now)
    expect(split.from).toBe(now - Measure.testDays * day)
    expect(split.history.map((observation) => observation.row.commit)).toEqual(["c1", "c2"])
    expect(split.test.map((observation) => observation.row.commit)).toEqual(["c3", "c4"])
  })

  it("splits nothing into nothing", () => {
    expect(Measure.split([])).toEqual({ from: -Measure.testDays * day, to: 0, history: [], test: [] })
  })
})

describe("sample", () => {
  const test = ["c1", "c2", "c3", "c4", "c5", "c6"].flatMap((commit, index) => [
    seen(now - (6 - index) * 1000, commit, "//a:test"),
    seen(now - (6 - index) * 1000, commit, "//b:test")
  ])

  it("keeps evenly spaced changes with all of their rows", () => {
    const kept = Measure.sample(test, 3)
    expect(kept.map((observation) => [observation.row.commit, observation.row.target])).toEqual([
      ["c1", "//a:test"],
      ["c1", "//b:test"],
      ["c3", "//a:test"],
      ["c3", "//b:test"],
      ["c5", "//a:test"],
      ["c5", "//b:test"]
    ])
    expect(Measure.sample([...test].reverse(), 3).map((observation) => observation.row.commit).sort()).toEqual(
      ["c1", "c1", "c3", "c3", "c5", "c5"]
    )
  })

  it("keeps the whole test set when it holds no more changes than asked for", () => {
    expect(Measure.sample(test, 6)).toBe(test)
    expect(Measure.sample(test, 100)).toBe(test)
    expect(Measure.sample(test, 0)).toEqual([])
  })

  it("orders changes made at the same instant by commit", () => {
    const tied = [seen(now, "b", "//a:test"), seen(now, "a", "//a:test"), seen(now, "c", "//a:test")]
    expect(Measure.sample(tied, 1).map((observation) => observation.row.commit)).toEqual(["a"])
  })
})

describe("selected", () => {
  it("applies the two settings to each change on its own", () => {
    expect(Object.fromEntries(Measure.selected(scores, { scoreCutoff: 0.25, countCutoff: 0 }))).toEqual({
      c1: ["//a:test"],
      c2: ["//a:test"],
      c3: []
    })
    expect(Object.fromEntries(Measure.selected(scores, { scoreCutoff: 1, countCutoff: 1 }))).toEqual({
      c1: ["//a:test"],
      c2: ["//a:test"],
      c3: ["//a:test"]
    })
  })
})

describe("measure", () => {
  it("reports the three metrics with the counts behind them", () => {
    expect(Measure.measure(rows, scores, { scoreCutoff: 0.25, countCutoff: 0 })).toEqual({
      settings: { scoreCutoff: 0.25, countCutoff: 0 },
      metrics: {
        rows: 9,
        selected: 2,
        failures: 3,
        failedChanges: 2,
        selectionRate: 2 / 9,
        testRecall: 2 / 3,
        changeRecall: 1
      }
    })
  })

  it("never counts a flaky row as a failure", () => {
    expect(Measure.measure(rows, scores, { scoreCutoff: 0, countCutoff: 0 }).metrics).toMatchObject({
      failures: 3,
      selected: 9,
      testRecall: 1
    })
  })
})

describe("lowerBound", () => {
  it("is what a count supports at 95% confidence: little for few, more for many", () => {
    expect(Measure.lowerBound(10, 10)).toBeCloseTo(0.787, 3)
    expect(Measure.lowerBound(100, 100)).toBeCloseTo(0.9737, 3)
    expect(Measure.lowerBound(2703, 2703)).toBeCloseTo(0.999, 5)
    expect(Measure.lowerBound(999, 1000)).toBeLessThan(0.999)
    expect(Measure.lowerBound(0, 10)).toBe(0)
  })
})

describe("report", () => {
  it("sweeps each setting alone, checks the weekly bar, and calibrates the two cutoffs together", () => {
    const measured = Measure.report(rows, scores)
    expect(measured).toMatchObject({ rows: 9, changes: 3, failures: 3, failedChanges: 2, flaky: 1, recall: "measured" })
    expect(measured.byScore.map((point) => point.settings)).toEqual(
      Measure.scoreCutoffs.map((scoreCutoff) => ({ scoreCutoff, countCutoff: 0 }))
    )
    expect(measured.byCount.map((point) => point.settings)).toEqual(
      Measure.countCutoffs.map((countCutoff) => ({ scoreCutoff: 1, countCutoff }))
    )
    expect(measured.byScore.map((point) => point.metrics.testRecall)).toEqual(
      [0, 1 / 3, 1 / 3, 1 / 3, 2 / 3, 2 / 3, 2 / 3, 2 / 3, 1, 1, 1]
    )
    expect(measured.byCount.map((point) => point.metrics.changeRecall)).toEqual([0, 1, 1, 1, 1, 1, 1, 1])
    // Test recall first reaches 0.9, and first passes 0.95, at score >= 0.02; there change recall already passes.
    expect(measured.weekly).toEqual(Measure.measure(rows, scores, { scoreCutoff: 0.02, countCutoff: 0 }))
    expect(measured.calibrated).toEqual(measured.weekly)
    expect(measured.calibrated!.metrics).toMatchObject({
      testRecall: 1,
      changeRecall: 1,
      selected: 5,
      selectionRate: 5 / 9
    })
    expect(measured.start).toEqual(Measure.measure(rows, scores, Measure.defaults))
  })

  it("adds the highest-scoring targets when the score cutoff alone leaves a failed change unseen", () => {
    // c1 fails a (scored high) and b (scored low). c2's only failure is scored below every passing target's cutoff.
    const split = [
      ...Array.from({ length: 40 }, (_, index) => row("c1", `//a${index}:test`, true)),
      row("c1", "//p:test"),
      row("c2", "//z:test", true),
      row("c2", "//y:test")
    ]
    const judged = split.map((each) =>
      score(each.commit, each.target, each.target === "//z:test" ? 0.015 : each.failed ? 0.9 : 0.01)
    )
    const measured = Measure.report(split, judged)
    // 40 of 41 failures score 0.9, so test recall passes 0.95 at score >= 0.9, but c2 is unseen until its top 1 is added.
    expect(measured.weekly!.settings).toEqual({ scoreCutoff: 0.9, countCutoff: 0 })
    expect(measured.byScore[1]!.metrics).toMatchObject({ testRecall: 40 / 41, changeRecall: 0.5 })
    expect(measured.calibrated!.settings).toEqual({ scoreCutoff: 0.9, countCutoff: 1 })
    expect(measured.calibrated!.metrics).toMatchObject({ testRecall: 1, changeRecall: 1, selected: 41 })
  })

  it("calibrates to running everything when the scores carry no signal", () => {
    // The judge scored the one failure 0 and every pass 1.
    const hidden = [
      ...Array.from({ length: 101 }, (_, index) => row("c1", `//p${index}:test`)),
      row("c1", "//z:test", true)
    ]
    const measured = Measure.report(hidden, hidden.map((each) => score(each.commit, each.target, each.failed ? 0 : 1)))
    expect(measured.byCount.every((point) => point.metrics.changeRecall === 0)).toBe(true)
    expect(measured.calibrated!.settings).toEqual({ scoreCutoff: 0, countCutoff: 0 })
    expect(measured.calibrated!.metrics.selectionRate).toBe(1)
    expect(measured.weekly!.metrics.selectionRate).toBe(1)
  })

  it("refuses to report a recall when no row failed, and still reports the selection rate", () => {
    const passing = rows.map((each) => ({ ...each, failed: false }))
    const measured = Measure.report(passing, scores)
    expect(measured.recall).toBe("refused: no row failed, so there is no failure to recall")
    expect(measured.calibrated).toBeUndefined()
    expect(measured.weekly).toBeUndefined()
    expect(measured.failures).toBe(0)
    for (const point of [...measured.byScore, ...measured.byCount, measured.start]) {
      expect(point.metrics).not.toHaveProperty("testRecall")
      expect(point.metrics).not.toHaveProperty("changeRecall")
    }
    expect(measured.byScore.at(-1)!.metrics.selectionRate).toBe(1)
  })
})

describe("render", () => {
  it("prints every recall and rate with the counts behind it", () => {
    const text = Measure.render("example", Measure.report(rows, scores))
    expect(text.split("\n")[0]).toBe("Fast mode eval: example")
    expect(text).toContain(
      "Test set: 9 rows in 3 changes; 3 failures in 2 changes; 1 flaky rows, which are not failures"
    )
    expect(text).toContain(
      "  score >= 0.3, top 0: test recall 0.667 (2 of 3), change recall 1.000 (2 of 2), selection rate 0.222 (2 of 9)"
    )
    expect(text).toContain(
      "Weekly check: at a test recall of at least 0.9 with count cutoff 0, the selection rate must be below 0.3: not passed"
    )
    expect(text).toContain("Calibrated to test recall above 0.95 and change recall above 0.999")
    expect(
      text.split("\n").filter((each) =>
        each ===
          "  score >= 0.02, top 0: test recall 1.000 (3 of 3), change recall 1.000 (2 of 2), selection rate 0.556 (5 of 9)"
      )
    ).toHaveLength(3)
    expect(text).toContain(
      "Failed changes: 2. With every one caught, the most that supports at 95% confidence is a change recall above 0.425. A change recall above 0.999 needs about 2,700 failed changes, all caught; a history with fewer than 1,000 cannot show it."
    )
  })

  it("says the weekly check passed when few targets reach a test recall of 0.9", () => {
    const many = [
      row("c1", "//z:test", true),
      ...Array.from({ length: 9 }, (_, index) => row("c1", `//p${index}:test`))
    ]
    const text = Measure.render(
      "sharp",
      Measure.report(many, many.map((each) => score(each.commit, each.target, each.failed ? 0.9 : 0.001)))
    )
    expect(text).toContain("the selection rate must be below 0.3: passed")
    expect(text).toContain(
      "  score >= 0.9, top 0: test recall 1.000 (1 of 1), change recall 1.000 (1 of 1), selection rate 0.100 (1 of 10)"
    )
  })

  it("prints no recall for rows with no failure, and says why", () => {
    const text = Measure.render("green", Measure.report(rows.map((each) => ({ ...each, failed: false })), scores))
    expect(text).toContain("  score >= 0.3, top 0: selection rate 0.222 (2 of 9)")
    expect(text).toContain("Recall refused: no row failed, so there is no failure to recall.")
    expect(text).not.toContain("test recall")
    expect(text).not.toContain("Calibrated")
    expect(text).not.toContain("Weekly check")
  })
})
