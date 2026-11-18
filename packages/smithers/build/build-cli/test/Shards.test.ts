/**
 * The rule behind `--shard`: parsing, the label hash both `smthrs` and
 * `smithers-ci` use, and the plan one shard runs; and the measured-duration
 * split behind `ci --remote`.
 */
import { readFileSync } from "node:fs"
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

/**
 * The label and shard pairs `smithers-ci` tests its `Shard` contract with.
 * Both packages read this one file, so the two rules cannot disagree.
 */
const pairs = (JSON.parse(
  readFileSync(new URL("../../../../ci/test/fixtures/shard-labels.json", import.meta.url), "utf8")
) as {
  readonly cases: ReadonlyArray<{ readonly label: string; readonly count: number; readonly shard: number }>
}).cases

describe("Shards.parse", () => {
  it.each([["0/1", 0, 1], ["2/6", 2, 6], ["1023/1024", 1023, 1024]])("reads %s", (text, index, count) => {
    expect(Shards.parse(text)).toEqual({ index, count })
  })

  it.each(["", "2", "2/2", "3/2", "0/0", "1/0", "0/1025", "01/2", "0/02", "1/2/3", "a/b", "-1/2", "1.5/2", " 0/2"])(
    "refuses %j",
    (text) => {
      expect(() => Shards.parse(text)).toThrow(
        `--shard expects <index>/<count> with 0 <= index < count <= 1024, received ${JSON.stringify(text)}`
      )
    }
  )
})

describe("Shards.shardOf", () => {
  it("covers labels of several counts, including ones outside ASCII", () => {
    expect(new Set(pairs.map((pair) => pair.count)).size).toBeGreaterThanOrEqual(5)
    expect(pairs.some((pair) => pair.label.includes("🚀"))).toBe(true)
  })

  it.each(pairs)("puts $label in shard $shard of $count", ({ count, label, shard }) => {
    expect(Shards.shardOf(label, count)).toBe(shard)
  })
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
  // Among two shards, shard 0 owns //:shared, //:lib, //:a and //:c; shard 1 owns //:b and //:only-c.
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
  const labels = plan.targets.map((entry) => entry.label)

  it("keeps the targets a shard owns and exactly their dependency closure, in plan order", () => {
    expect(labels.map((label) => Shards.shardOf(label, 2))).toEqual([0, 0, 0, 1, 1, 0])
    // Shard 0 also builds //:only-c for //:c: shard 1 owns it, and only the cache can spare the work.
    const first = Shards.select(plan, { index: 0, count: 2 })
    expect(first.roots).toEqual(["//:shared", "//:lib", "//:a", "//:c"])
    expect(first.targets.map((entry) => entry.label)).toEqual(["//:shared", "//:lib", "//:a", "//:only-c", "//:c"])
    expect(first.edges).toEqual([
      { from: "//:shared", to: "//:lib" },
      { from: "//:lib", to: "//:a" },
      { from: "//:only-c", to: "//:c" }
    ])
    expect(first.warnings).toEqual(["kept"])

    const second = Shards.select(plan, { index: 1, count: 2 })
    expect(second.roots).toEqual(["//:b", "//:only-c"])
    expect(second.targets.map((entry) => entry.label)).toEqual(["//:shared", "//:b", "//:only-c"])
    expect(second.edges).toEqual([{ from: "//:shared", to: "//:b" }])
  })

  it.each([1, 2, 3, 5, 8, 64])("gives every planned label exactly one of %i shards", (count) => {
    const owned = Array.from({ length: count }, (_, index) => Shards.select(plan, { index, count }).roots).flat()
    expect(owned.sort()).toEqual([...labels].sort())
  })

  it("is the whole plan as one shard of one, and nothing as a shard that owns no label", () => {
    expect(Shards.select(plan, { index: 0, count: 1 })).toEqual({ ...plan, roots: labels })
    const empty = Array.from({ length: 64 }, (_, index) => index).find((index) =>
      labels.every((label) => Shards.shardOf(label, 64) !== index)
    )!
    expect(Shards.select(plan, { index: empty, count: 64 })).toEqual({
      roots: [],
      targets: [],
      edges: [],
      warnings: ["kept"]
    })
  })
})
