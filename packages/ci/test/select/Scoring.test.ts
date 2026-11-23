import { describe, expect, it } from "vitest"
import type { Features, Row } from "../../src/contract/Selection.vibe"
import * as Scoring from "../../src/select/Scoring.vibe"

const features = (overrides: Partial<Features> = {}): Features => ({
  extensions: [".ts"],
  fileChanges: { d3: 1, d14: 2, d56: 3 },
  failureRates: { d7: 0, d14: 0, d28: 0, d56: 0 },
  project: "packages/a",
  testCount: 4,
  graphDistance: 0,
  ...overrides
})

const row = (commit: string, target: string, overrides: Partial<Features> = {}): Row => ({
  commit,
  target,
  features: features(overrides),
  attempts: [true],
  failed: false,
  flaky: false
})

describe("keyOf", () => {
  it("is equal for equal features and differs when any feature differs", () => {
    const base = Scoring.keyOf(features())
    expect(Scoring.keyOf(features())).toBe(base)
    const changed: ReadonlyArray<Partial<Features>> = [
      { extensions: [".md"] },
      { fileChanges: { d3: 1, d14: 2, d56: 4 } },
      { failureRates: { d7: 0, d14: 0, d28: 0, d56: 0.1 } },
      { project: "packages/b" },
      { testCount: 5 },
      { graphDistance: 1 }
    ]
    expect(new Set([base, ...changed.map((each) => Scoring.keyOf(features(each)))]).size).toBe(7)
  })
})

describe("batches", () => {
  it("asks once for rows with equal features, in an order that does not depend on the rows' order", () => {
    const rows = [
      row("c1", "//a:test", { graphDistance: 2 }),
      row("c1", "//a:lint", { graphDistance: 2 }),
      row("c1", "//b:test", { graphDistance: 0 }),
      row("c2", "//b:test", { graphDistance: 0 })
    ]
    const asked = Scoring.batches(rows)
    expect(asked).toEqual([[features({ graphDistance: 0 }), features({ graphDistance: 2 })]])
    expect(Scoring.batches([...rows].reverse())).toEqual(asked)
  })

  it("cuts the distinct feature sets into batches of at most batchSize", () => {
    const rows = Array.from(
      { length: Scoring.batchSize * 2 + 3 },
      (_, index) => row("c1", `//t${index}:test`, { testCount: index })
    )
    expect(Scoring.batches(rows).map((batch) => batch.length)).toEqual([Scoring.batchSize, Scoring.batchSize, 3])
    expect(Scoring.batches([])).toEqual([])
  })
})

describe("stateOf", () => {
  it("names each item and gives the six features plain names", () => {
    const state = Scoring.stateOf([
      features({ failureRates: { d7: 0.5, d14: 0.25, d28: 0.2, d56: 0.1 } }),
      features({ graphDistance: -1 })
    ])
    expect(state.about).toBe(Scoring.about)
    expect(state.items).toEqual([
      {
        item: 0,
        changedFileExtensions: [".ts"],
        commitsToTheChangedFiles: { last3Days: 1, last14Days: 2, last56Days: 3 },
        targetFailureRate: { last7Days: 0.5, last14Days: 0.25, last28Days: 0.2, last56Days: 0.1 },
        targetProject: "packages/a",
        testsInTarget: 4,
        dependencyDistance: 0
      },
      {
        item: 1,
        changedFileExtensions: [".ts"],
        commitsToTheChangedFiles: { last3Days: 1, last14Days: 2, last56Days: 3 },
        targetFailureRate: { last7Days: 0, last14Days: 0, last28Days: 0, last56Days: 0 },
        targetProject: "packages/a",
        testsInTarget: 4,
        dependencyDistance: "no known path"
      }
    ])
  })
})

describe("classifier", () => {
  it("asks two questions per item, each naming its item", () => {
    const declared = Scoring.classifier(2)
    expect(Object.keys(declared.questions)).toEqual(["fails0", "why0", "fails1", "why1"])
    expect(declared.questions["fails1"]).toMatchObject({
      type: "boolean",
      instructions: "Item 1: does this target fail on this change?"
    })
    expect(declared.questions["why0"]).toMatchObject({ type: "choice", criteria: Scoring.reasons })
    expect(declared.questions["why0"]!.instructions).toContain("Item 0:")
  })

  it("has one digest per batch size, so a changed question is never answered from an old record", () => {
    expect(Scoring.classifier(2).digest).toBe(Scoring.classifier(2).digest)
    expect(Scoring.classifier(2).digest).not.toBe(Scoring.classifier(3).digest)
  })
})

describe("readingsOf", () => {
  it("reads each item's chance of failure and the fact the judge chose", () => {
    const readings = Scoring.readingsOf(2, {
      fails0: { value: true, probability: 0.9 },
      why0: { value: "history", probabilities: {}, confidence: 1 },
      fails1: { value: false, probability: 0.02 },
      why1: { value: "none", probabilities: {}, confidence: 1 }
    })
    expect(readings).toEqual([{ score: 0.9, fact: "history" }, { score: 0.02, fact: "none" }])
  })
})

describe("scoresOf", () => {
  it("gives every row the reading of its feature set, across batches", () => {
    const rows = [
      row("c1", "//a:test", { testCount: 1 }),
      row("c1", "//b:test", { testCount: 2 }),
      row("c2", "//a:test", { testCount: 1 })
    ]
    const asked = [[features({ testCount: 1 })], [features({ testCount: 2 })]]
    const answered = [[{ score: 0.7, fact: "history" as const }], [{ score: 0.1, fact: "size" as const }]]
    // No failure in any window is a reason to skip; the number of tests never is.
    expect(Scoring.scoresOf(rows, asked, answered)).toEqual([
      { commit: "c1", target: "//a:test", score: 0.7, reason: Scoring.skipReasons.history },
      { commit: "c1", target: "//b:test", score: 0.1 },
      { commit: "c2", target: "//a:test", score: 0.7, reason: Scoring.skipReasons.history }
    ])
  })
})

describe("skipReason", () => {
  it("says why a skip is safe from what the features measured of the fact the judge named", () => {
    expect(Scoring.skipReason("history", features())).toBe("No failure on record in the last 56 days.")
    expect(Scoring.skipReason("distance", features({ graphDistance: -1 }))).toBe(
      "No known path leads from the change to it in the dependency graph."
    )
    expect(Scoring.skipReason("churn", features({ fileChanges: { d3: 0, d14: 0, d56: 0 } }))).toBe(
      "The changed files had no other change in the 56 days before."
    )
    expect(Scoring.skipReason("kind", features({ extensions: [".md"] }))).toBe("Only .md files changed.")
    expect(Scoring.skipReason("kind", features({ extensions: [".md", ".txt"] }))).toBe("Only .md, .txt files changed.")
    expect(Scoring.skipReason("kind", features({ extensions: ["(none)"] }))).toBe(
      "Only files with no extension changed."
    )
    expect(Scoring.skipReason("kind", features({ extensions: ["(none)", ".md"] }))).toBe(
      "Only .md files and files with no extension changed."
    )
    expect(Scoring.skipReason("none", features())).toBe("Safe to skip on what was measured; no one fact decided it.")
  })

  it("gives no reason where the fact, as measured, points to a failure", () => {
    // A MacBook replay printed "The change is close to the target in the dependency graph." for a skip.
    expect(Scoring.skipReason("distance", features({ graphDistance: 1 }))).toBeUndefined()
    expect(Scoring.skipReason("distance", features({ graphDistance: 0 }))).toBeUndefined()
    expect(Scoring.skipReason("history", features({ failureRates: { d7: 0, d14: 0, d28: 0, d56: 0.1 } })))
      .toBeUndefined()
    expect(Scoring.skipReason("churn", features())).toBeUndefined()
    expect(Scoring.skipReason("kind", features({ extensions: [] }))).toBeUndefined()
    expect(Scoring.skipReason("size", features({ testCount: 0 }))).toBeUndefined()
  })

  it("never says why a target could fail, whatever the judge named", () => {
    const risky = features({ failureRates: { d7: 0.5, d14: 0.5, d28: 0.5, d56: 0.5 }, graphDistance: 1 })
    for (const fact of ["history", "distance", "churn", "size"] as const) {
      expect(Scoring.skipReason(fact, risky)).toBeUndefined()
    }
    for (const fact of Object.keys(Scoring.reasons) as ReadonlyArray<keyof typeof Scoring.reasons>) {
      expect(Object.values(Scoring.reasons)).not.toContain(Scoring.skipReason(fact, features()))
    }
  })
})
