/**
 * The measured-duration split behind `ci --shard`: parsing, reading a results
 * file's durations, balancing, and the plan one part runs.
 */
import { describe, expect, it } from "vitest"
import type * as Executor from "../src/Executor.ts"
import * as Shards from "../src/internal/Shards.ts"
import type * as Planner from "../src/Planner.ts"

const target = (label: string, dependencies: ReadonlyArray<string> = []): Planner.PlannedTarget => ({
  label,
  target: "ShardTest",
  kinds: ["test"],
  attrs: {},
  dependencies,
  declaredInputs: [],
  declaredOutputs: undefined,
  cacheable: false,
  cacheLookup: "not-wired",
  wouldRun: true,
  keyMaterial: { body: label, inputs: null, layers: [], capabilities: [] },
  keyPreview: label
})

const results = (rows: ReadonlyArray<Readonly<Record<string, unknown>>>): string =>
  JSON.stringify({ ok: true, results: rows, version: 1 })

describe("Shards.parse", () => {
  it.each([["1/1", 1, 1], ["2/6", 2, 6], ["1024/1024", 1024, 1024]])("reads %s", (text, index, count) => {
    expect(Shards.parse(text)).toEqual({ index, count })
  })

  it.each(["", "2", "0/2", "3/2", "1/0", "1/1025", "01/2", "1/2/3", "a/b", "-1/2", "1.5/2", " 1/2"])(
    "refuses %j",
    (text) => {
      expect(() => Shards.parse(text)).toThrow(
        `--shard expects <index>/<count> with 1 <= index <= count <= 1024, received ${JSON.stringify(text)}`
      )
    }
  )
})

describe("Shards.measure", () => {
  it("keeps the durations of targets that ran, and lets a later document win", () => {
    const measured = new Map<string, number>()
    Shards.measure(
      "first.json",
      results([
        { label: "//:ran", status: "ran", durationMs: 40 },
        { label: "//:failed", status: "failed", durationMs: 30 },
        { label: "//:hit", status: "hit", durationMs: 1 },
        { label: "//:skipped", status: "skipped", durationMs: 0 },
        { label: "//:cancelled", status: "cancelled" }
      ]),
      measured
    )
    Shards.measure("second.json", results([{ label: "//:ran", status: "ran", durationMs: 90 }]), measured)
    expect([...measured]).toEqual([["//:ran", 90], ["//:failed", 30]])
  })

  it.each([
    ["{", /^t\.json: timings are not JSON \(/],
    ["[]", /^t\.json: timings need a results array, as --results-file writes$/],
    ["null", /^t\.json: timings need a results array, as --results-file writes$/],
    [JSON.stringify({ results: {} }), /^t\.json: timings need a results array, as --results-file writes$/],
    [results([1 as never]), /^t\.json: results\[0\] is not an object$/],
    [results([{ label: 1, status: "ran" }]), /^t\.json: results\[0\] needs a label and a status$/],
    [results([{ label: "//:a", status: 1 }]), /^t\.json: results\[0\] needs a label and a status$/],
    [
      results([{ label: "//:ok", status: "ran", durationMs: 1 }, { label: "//:a", status: "ran" }]),
      /^t\.json: results\[1\] \(\/\/:a\) needs a duration in milliseconds$/
    ],
    [
      results([{ label: "//:a", status: "failed", durationMs: -1 }]),
      /^t\.json: results\[0\] \(\/\/:a\) needs a duration in milliseconds$/
    ],
    [
      `{"results":[{"label":"//:a","status":"ran","durationMs":1e999}]}`,
      /^t\.json: results\[0\] \(\/\/:a\) needs a duration in milliseconds$/
    ]
  ])("refuses %j", (content, message) => {
    expect(() => Shards.measure("t.json", content, new Map())).toThrow(message)
  })
})

describe("Shards.split", () => {
  it("places the longest roots first, each on the lightest part, and keeps plan order within a part", () => {
    const measured = new Map([["//:a", 10], ["//:b", 70], ["//:c", 30], ["//:d", 40], ["//:e", 20]])
    // 70 alone, then 40 and 30 together; 20 meets a 70-70 tie, which the first part wins; 10 goes to the second.
    expect(Shards.split(["//:a", "//:b", "//:c", "//:d", "//:e"], measured, 2)).toEqual([
      ["//:b", "//:e"],
      ["//:a", "//:c", "//:d"]
    ])
  })

  it("weighs an unmeasured root as the measured roots' median", () => {
    const measured = new Map([["//:long", 100], ["//:mid", 50], ["//:short", 10], ["//:elsewhere", 100_000]])
    // //:new weighs 50, the median of this plan's three measured roots; a label outside the plan moves nothing.
    expect(Shards.split(["//:new", "//:short", "//:mid", "//:long"], measured, 2)).toEqual([
      ["//:short", "//:long"],
      ["//:new", "//:mid"]
    ])
  })

  it("splits unmeasured roots evenly by label, and gives a zero duration a weight", () => {
    expect(Shards.split(["//:d", "//:c", "//:b", "//:a"], new Map(), 2)).toEqual([["//:c", "//:a"], ["//:d", "//:b"]])
    const zeros = new Map([["//:a", 0], ["//:b", 0], ["//:c", 0], ["//:d", 0]])
    expect(Shards.split(["//:a", "//:b", "//:c", "//:d"], zeros, 2)).toEqual([["//:a", "//:c"], ["//:b", "//:d"]])
  })

  it("leaves parts empty when there are fewer roots than parts", () => {
    expect(Shards.split(["//:a"], new Map(), 3)).toEqual([["//:a"], [], []])
    expect(Shards.split([], new Map(), 2)).toEqual([[], []])
  })

  it("covers every root exactly once", () => {
    const roots = Array.from({ length: 37 }, (_, index) => `//pkg:t${index}`)
    const measured = new Map(roots.map((root, index) => [root, (index * 7919) % 101]))
    const parts = Shards.split(roots, measured, 5)
    expect(parts.flat().sort()).toEqual([...roots].sort())
    const totals = parts.map((part) => part.reduce((sum, root) => sum + Math.max(1, measured.get(root)!), 0))
    // Longest-first placement never leaves two parts further apart than the longest root.
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(100)
  })
})

describe("Shards.select", () => {
  const plan: Executor.MergedPlan = {
    roots: ["//:a", "//:b", "//:c"],
    targets: [
      target("//:shared"),
      target("//:lib", ["//:shared"]),
      target("//:a", ["//:lib"]),
      target("//:b", ["//:shared"]),
      target("//:only-c"),
      target("//:c", ["//:only-c"])
    ],
    edges: [
      { from: "//:shared", to: "//:lib" },
      { from: "//:lib", to: "//:a" },
      { from: "//:shared", to: "//:b" },
      { from: "//:only-c", to: "//:c" }
    ],
    warnings: ["kept"]
  }
  const measured = new Map([["//:a", 50], ["//:b", 20], ["//:c", 20]])

  it("keeps a part's roots and exactly their dependency closure, in plan order", () => {
    const first = Shards.select(plan, { index: 1, count: 2 }, measured)
    expect(first.roots).toEqual(["//:a"])
    expect(first.targets.map((entry) => entry.label)).toEqual(["//:shared", "//:lib", "//:a"])
    expect(first.edges).toEqual([{ from: "//:shared", to: "//:lib" }, { from: "//:lib", to: "//:a" }])
    expect(first.warnings).toEqual(["kept"])

    const second = Shards.select(plan, { index: 2, count: 2 }, measured)
    expect(second.roots).toEqual(["//:b", "//:c"])
    expect(second.targets.map((entry) => entry.label)).toEqual(["//:shared", "//:b", "//:only-c", "//:c"])
    expect(second.edges).toEqual([{ from: "//:shared", to: "//:b" }, { from: "//:only-c", to: "//:c" }])
  })

  it("is the whole plan as one part of one, and nothing as a part past the roots", () => {
    expect(Shards.select(plan, { index: 1, count: 1 }, measured)).toEqual(plan)
    expect(Shards.select(plan, { index: 4, count: 4 }, measured)).toEqual({
      roots: [],
      targets: [],
      edges: [],
      warnings: ["kept"]
    })
  })
})
