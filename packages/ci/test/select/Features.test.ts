import { describe, expect, it } from "vitest"
import type { Plan } from "../../src/contract/Plan.ts"
import type { RunRecord, TargetResult } from "../../src/contract/RunRecord.ts"
import type { Row } from "../../src/contract/Selection.ts"
import * as Features from "../../src/select/Features.ts"

const day = Features.day
const now = Date.UTC(2026, 10, 14)

const result = (label: string, status: TargetResult["status"], attempts?: ReadonlyArray<boolean>): TargetResult => ({
  label,
  status,
  key: "k",
  durationMs: 1,
  ...(attempts === undefined ? {} : { attempts: attempts.map((passed) => ({ passed, durationMs: 1 })) })
})

const record = (results: ReadonlyArray<TargetResult>): RunRecord => ({
  ok: results.every((each) => each.status !== "failed"),
  counts: { hit: 0, ran: 0, failed: 0, skipped: 0 },
  results
})

const observed = (
  target: string,
  at: number,
  failed: boolean,
  commit = "old",
  flaky = false
): Features.Observation => ({
  at,
  row: {
    commit,
    target,
    features: {
      extensions: [],
      fileChanges: { d3: 0, d14: 0, d56: 0 },
      failureRates: { d7: 0, d14: 0, d28: 0, d56: 0 },
      project: Features.projectOf(target),
      testCount: 0,
      graphDistance: 0
    },
    attempts: [!failed],
    failed,
    flaky
  }
})

const plan = (targets: Readonly<Record<string, ReadonlyArray<string>>>): Plan => ({
  verb: "ci",
  pattern: "//...",
  roots: [],
  targets: Object.entries(targets).map(([label, dependencies]) => ({
    label,
    rule: "test",
    key: "k",
    cacheable: true,
    dependencies
  }))
})

describe("projectOf", () => {
  it("is the directory of the label, and `.` for the root package", () => {
    expect(Features.projectOf("//packages/a:test")).toBe("packages/a")
    expect(Features.projectOf("//:docs")).toBe(".")
    expect(Features.projectOf("packages/b")).toBe("packages/b")
  })
})

describe("extensionsOf", () => {
  it("lowercases, removes repeats and sorts", () => {
    expect(Features.extensionsOf(["a/b.TS", "c.ts", "d/e.test.vibe", "x.md"])).toEqual([".md", ".ts", ".vibe"])
  })

  it("counts a file with no extension, or only a leading dot, by its name", () => {
    expect(Features.extensionsOf(["Justfile", "tools/Makefile", ".gitignore"])).toEqual([
      ".gitignore",
      "Justfile",
      "Makefile"
    ])
    expect(Features.extensionsOf([])).toEqual([])
  })
})

describe("fileChanges", () => {
  it("counts earlier commits that touched a changed file, per window", () => {
    const history = [
      { at: now - 1 * day, files: ["a.ts"] },
      { at: now - 3 * day, files: ["b.ts", "a.ts"] },
      { at: now - 10 * day, files: ["a.ts"] },
      { at: now - 56 * day, files: ["a.ts"] },
      { at: now - 57 * day, files: ["a.ts"] },
      { at: now - 2 * day, files: ["other.ts"] }
    ]
    expect(Features.fileChanges(["a.ts"], now, history)).toEqual({ d3: 2, d14: 3, d56: 4 })
  })

  it("leaves out the change itself and anything after it", () => {
    const history = [{ at: now, files: ["a.ts"] }, { at: now + day, files: ["a.ts"] }]
    expect(Features.fileChanges(["a.ts"], now, history)).toEqual({ d3: 0, d14: 0, d56: 0 })
  })
})

describe("failureRates", () => {
  it("is the share of earlier runs that failed in each window", () => {
    const runs = [
      observed("//a:test", now - 1 * day, true),
      observed("//a:test", now - 2 * day, false),
      observed("//a:test", now - 10 * day, false),
      observed("//a:test", now - 10 * day, false),
      observed("//a:test", now - 20 * day, true),
      observed("//a:test", now - 50 * day, true),
      observed("//a:test", now - 60 * day, true)
    ]
    expect(Features.failureRates(now, runs)).toEqual({ d7: 1 / 2, d14: 1 / 4, d28: 2 / 5, d56: 3 / 6 })
  })

  it("counts a flaky run as a run that did not fail", () => {
    const runs = [observed("//a:test", now - day, false, "old", true), observed("//a:test", now - day, true)]
    expect(Features.failureRates(now, runs).d7).toBe(0.5)
  })

  it("is 0 for a window with no run, and never reads the change's own time or later", () => {
    expect(Features.failureRates(now, [])).toEqual({ d7: 0, d14: 0, d28: 0, d56: 0 })
    expect(Features.failureRates(now, [observed("//a:test", now, true), observed("//a:test", now + 1, true)]))
      .toEqual({ d7: 0, d14: 0, d28: 0, d56: 0 })
  })
})

describe("testCount", () => {
  const tree = [
    "packages/a/src/index.ts",
    "packages/a/test/one.test.ts",
    "packages/a/test/fixtures/data.json",
    "packages/a/src/parser_test.go",
    "packages/a/src/__tests__/x.ts",
    "packages/a/src/latest.ts",
    "packages/ab/test/other.test.ts",
    "spec/root.zig"
  ]

  it("counts test files inside the project only", () => {
    expect(Features.testCount(tree, "packages/a")).toBe(4)
    expect(Features.testCount(tree, "packages/ab")).toBe(1)
    expect(Features.testCount(tree, "packages/none")).toBe(0)
  })

  it("counts the whole repository for the root package", () => {
    expect(Features.testCount(tree, ".")).toBe(6)
  })
})

describe("graphDistances", () => {
  const graph = plan({
    "//packages/a:lib": [],
    "//packages/a:test": ["//packages/a:lib"],
    "//packages/b:test": ["//packages/a:lib"],
    "//packages/c:test": ["//packages/b:test", "//packages/a:lib"],
    "//packages/d:test": []
  })
  const targets = ["//packages/a:test", "//packages/b:test", "//packages/c:test", "//packages/d:test"]

  it("is the fewest dependency edges from a changed file's project to the target", () => {
    const distances = Features.graphDistances(["packages/a/src/x.ts"], targets, graph)
    expect(Object.fromEntries(distances)).toEqual({
      "//packages/a:lib": 0,
      "//packages/a:test": 0,
      "//packages/b:test": 1,
      "//packages/c:test": 1,
      "//packages/d:test": Features.unreachable
    })
  })

  it("takes the nearest of several changed files", () => {
    const distances = Features.graphDistances(["packages/a/src/x.ts", "packages/c/README.md"], targets, graph)
    expect(distances.get("//packages/c:test")).toBe(0)
    expect(distances.get("//packages/b:test")).toBe(1)
  })

  it("gives a file to the deepest project that holds it, and to the root package when no other does", () => {
    const nested = plan({ "//:all": [], "//packages/a:test": [], "//packages/a/inner:test": [] })
    const inner = Features.graphDistances(["packages/a/inner/x.ts"], [], nested)
    expect(Object.fromEntries(inner)).toEqual({
      "//:all": Features.unreachable,
      "//packages/a:test": Features.unreachable,
      "//packages/a/inner:test": 0
    })
    const root = Features.graphDistances(["pnpm-lock.yaml"], [], nested)
    expect(root.get("//:all")).toBe(0)
    expect(root.get("//packages/a:test")).toBe(Features.unreachable)
  })

  it("reaches only a changed file's own project when there is no plan", () => {
    const distances = Features.graphDistances(["packages/a/src/x.ts", "docs/readme.md"], targets, undefined)
    expect(Object.fromEntries(distances)).toEqual({
      "//packages/a:test": 0,
      "//packages/b:test": Features.unreachable,
      "//packages/c:test": Features.unreachable,
      "//packages/d:test": Features.unreachable
    })
  })
})

describe("outcomes", () => {
  it("labels a target failed only when every attempt failed, and flaky when attempts disagree", () => {
    const ten = Array.from({ length: 10 }, () => false)
    expect(Features.outcomes(record([
      result("//a:test", "failed", ten),
      result("//b:test", "ran", [false, false, true]),
      result("//c:test", "ran", [true]),
      result("//d:test", "failed", [false, true, false])
    ]))).toEqual([
      { target: "//a:test", attempts: ten, failed: true, flaky: false },
      { target: "//b:test", attempts: [false, false, true], failed: false, flaky: true },
      { target: "//c:test", attempts: [true], failed: false, flaky: false },
      { target: "//d:test", attempts: [false, true, false], failed: false, flaky: true }
    ])
  })

  it("reads a target with no recorded attempts by its status", () => {
    expect(Features.outcomes(record([result("//a:test", "failed"), result("//b:test", "ran")]))).toEqual([
      { target: "//a:test", attempts: [false], failed: true, flaky: false },
      { target: "//b:test", attempts: [true], failed: false, flaky: false }
    ])
  })

  it("has no outcome for a target that never ran", () => {
    expect(Features.outcomes(record([
      result("//a:test", "hit"),
      { ...result("//b:test", "skipped"), skipReason: "dependency-failed" },
      { ...result("//c:test", "skipped"), skipReason: "predicted-safe" }
    ]))).toEqual([])
  })
})

describe("build", () => {
  const change: Features.Change = {
    commit: "c9",
    at: now,
    files: ["packages/a/src/x.ts", "packages/a/README.md"],
    history: [{ at: now - 2 * day, files: ["packages/a/src/x.ts"] }, {
      at: now - 20 * day,
      files: ["packages/a/README.md"]
    }],
    tree: [
      "packages/a/test/x.test.ts",
      "packages/a/test/y.test.ts",
      "packages/b/test/z.test.ts",
      "packages/b/src/z.ts"
    ],
    past: [
      observed("//packages/b:test", now - day, true),
      observed("//packages/b:test", now - 2 * day, false),
      observed("//packages/b:test", now - 3 * day, true, "c9"),
      observed("//packages/a:test", now - 30 * day, true)
    ],
    plan: plan({ "//packages/a:test": [], "//packages/a:lint": [], "//packages/b:test": ["//packages/a:test"] })
  }

  it("builds one row per target that ran, with the six features and the label", () => {
    const rows = Features.build(
      record([
        result("//packages/a:test", "ran"),
        result("//packages/a:lint", "hit"),
        result("//packages/b:test", "failed", [false, false]),
        result("//packages/c:test", "ran", [false, true])
      ]),
      change
    )
    const shared = { extensions: [".md", ".ts"], fileChanges: { d3: 1, d14: 1, d56: 2 } }
    expect(rows).toEqual<ReadonlyArray<Row>>([
      {
        commit: "c9",
        target: "//packages/a:test",
        features: {
          ...shared,
          failureRates: { d7: 0, d14: 0, d28: 0, d56: 1 },
          project: "packages/a",
          testCount: 2,
          graphDistance: 0
        },
        attempts: [true],
        failed: false,
        flaky: false
      },
      {
        commit: "c9",
        target: "//packages/b:test",
        features: {
          ...shared,
          failureRates: { d7: 0.5, d14: 0.5, d28: 0.5, d56: 0.5 },
          project: "packages/b",
          testCount: 1,
          graphDistance: 1
        },
        attempts: [false, false],
        failed: true,
        flaky: false
      },
      {
        commit: "c9",
        target: "//packages/c:test",
        features: {
          ...shared,
          failureRates: { d7: 0, d14: 0, d28: 0, d56: 0 },
          project: "packages/c",
          testCount: 0,
          graphDistance: Features.unreachable
        },
        attempts: [false, true],
        failed: false,
        flaky: true
      }
    ])
  })

  it("counts a project's tests once for all of its targets, and works with no plan", () => {
    const rows = Features.build(
      record([result("//packages/a:test", "ran"), result("//packages/a:check", "ran")]),
      { ...change, plan: undefined, past: [] }
    )
    expect(rows.map((row) => [row.target, row.features.testCount, row.features.graphDistance])).toEqual([
      ["//packages/a:test", 2, 0],
      ["//packages/a:check", 2, 0]
    ])
  })
})
