import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { Closure, Command, Inventory, Parts, Plan, ReplayReport, RunRecord, Selection, Shard } from "../src/index.ts"

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"))

describe("contract 1: run record", () => {
  it("decodes the real rc.18 workspace-targets run: 721 targets, no cache hits", () => {
    const record = Schema.decodeUnknownSync(RunRecord.RunRecord)(fixture("run-record.rc18-workspace-targets.json"))
    expect(record.ok).toBe(false)
    expect(record.results).toHaveLength(721)
    expect(record.counts).toEqual({ hit: 0, ran: 692, failed: 22, skipped: 7 })
    expect(record.results.filter((result) => RunRecord.verdictOf(result) === "fail")).toHaveLength(22)
  })

  it("refuses a status outside hit, ran, failed and skipped", () => {
    const result = { label: "//a:test", status: "passed", key: "k", durationMs: 1 }
    expect(() => Schema.decodeUnknownSync(RunRecord.TargetResult)(result)).toThrow()
  })

  it("labels a target from its attempts as the paper does", () => {
    const base = { label: "//a:test", key: "k", durationMs: 1 }
    const attempt = (passed: boolean) => ({ passed, durationMs: 1 })
    expect(RunRecord.verdictOf({ ...base, status: "skipped", skipReason: "predicted-safe" })).toBe("skipped")
    expect(RunRecord.verdictOf({ ...base, status: "ran" })).toBe("pass")
    expect(RunRecord.verdictOf({ ...base, status: "hit" })).toBe("pass")
    expect(RunRecord.verdictOf({ ...base, status: "failed" })).toBe("fail")
    expect(RunRecord.verdictOf({ ...base, status: "ran", attempts: [attempt(true)] })).toBe("pass")
    expect(RunRecord.verdictOf({ ...base, status: "failed", attempts: [attempt(false), attempt(false)] })).toBe("fail")
    expect(RunRecord.verdictOf({ ...base, status: "ran", attempts: [attempt(false), attempt(true)] })).toBe("flaky")
  })
})

describe("contract 2: plan", () => {
  it("decodes the plan `smthrs generate package --plan` printed", () => {
    const plan = Schema.decodeUnknownSync(Plan.Plan)(fixture("plan.generate-package.json"))
    expect(plan.targets.map((target) => target.label)).toEqual(plan.roots)
    expect(plan.targets[0]?.cacheable).toBe(false)
  })
})

describe("contract 4: inventory", () => {
  it("holds a Zig repository driven by a Justfile and a Bun monorepo driven by GitHub Actions in one shape", () => {
    const decode = Schema.decodeUnknownSync(Inventory.Inventory)
    const zig = decode(fixture("inventory.justfile-zig.json"))
    const bun = decode(fixture("inventory.github-actions-bun.json"))
    expect(zig.jobs.map((job) => job.source)).toEqual(["justfile", "justfile"])
    expect(zig.jobs[0]?.needs).toEqual(["justfile:build"])
    expect(bun.jobs[0]?.matrix).toHaveLength(2)
    expect(bun.jobs[0]?.steps[1]?.secrets).toEqual(["CODECOV_TOKEN"])
    expect(JSON.stringify(bun)).not.toContain("secretValue")
  })

  it("refuses a source it does not know", () => {
    const zig = fixture("inventory.justfile-zig.json") as { jobs: Array<{ source: string }> }
    zig.jobs[0]!.source = "jenkins"
    expect(() => Schema.decodeUnknownSync(Inventory.Inventory)(zig)).toThrow()
  })
})

describe("contract 5: replay report", () => {
  it("decodes a report whose fast mode skipped a target that failed in the baseline", () => {
    const report = Schema.decodeUnknownSync(ReplayReport.ReplayReport)(fixture("replay-report.example.json"))
    expect(report.speedup).toBeCloseTo(report.baselineWallMs / report.normalWallMs)
    expect(report.mismatches).toBe(report.commits.flatMap((commit) => commit.mismatches).length)
    expect(report.commits[1]?.mismatches[0]).toEqual({
      label: "//packages/core:test",
      mode: "fast",
      baseline: "fail",
      got: "skipped"
    })
  })
})

describe("contract 6: selection", () => {
  const rows = Schema.decodeUnknownSync(Schema.Array(Selection.Row))(fixture("selection-rows.example.json"))
  const score = (commit: string, target: string, value: number): Selection.Score => ({ commit, target, score: value })

  it("refuses a score outside 0 to 1", () => {
    expect(() => Schema.decodeUnknownSync(Selection.Score)(score("c1", "//a:test", 1.5))).toThrow()
    expect(() => Schema.decodeUnknownSync(Selection.Settings)({ scoreCutoff: 0.5, countCutoff: -1 })).toThrow()
  })

  it("selects every target at or above the cutoff, plus the highest-scoring few", () => {
    const scores = [score("c1", "//a:test", 0.9), score("c1", "//b:test", 0.2), score("c1", "//c:test", 0.2)]
    expect(Selection.select(scores, { scoreCutoff: 0.5, countCutoff: 0 })).toEqual(["//a:test"])
    expect(Selection.select(scores, { scoreCutoff: 0.2, countCutoff: 0 })).toEqual(["//a:test", "//b:test", "//c:test"])
    expect(Selection.select(scores, { scoreCutoff: 1, countCutoff: 2 })).toEqual(["//a:test", "//b:test"])
    expect(Selection.select([...scores].reverse(), { scoreCutoff: 1, countCutoff: 2 })).toEqual([
      "//a:test",
      "//b:test"
    ])
    expect(Selection.select(scores, { scoreCutoff: 1, countCutoff: 0 })).toEqual([])
  })

  it("computes test recall, change recall and selection rate as the paper defines them", () => {
    const caughtOne = new Map([["c1", ["//a:test", "//c:test"]]])
    expect(Selection.metrics(rows, caughtOne)).toEqual({
      rows: 5,
      selected: 2,
      failures: 2,
      failedChanges: 2,
      selectionRate: 2 / 5,
      testRecall: 1 / 2,
      changeRecall: 1 / 2
    })
    const everything = new Map([["c1", ["//a:test", "//b:test", "//c:test"]], ["c2", ["//a:test"]], ["c3", [
      "//b:test"
    ]]])
    expect(Selection.metrics(rows, everything)).toMatchObject({ selectionRate: 1, testRecall: 1, changeRecall: 1 })
  })

  it("never counts a flaky row as a failure, and reports no recall when nothing failed", () => {
    const flakyOnly = rows.filter((row) => row.flaky || row.commit === "c2")
    expect(Selection.metrics(flakyOnly, new Map())).toEqual({
      rows: 2,
      selected: 0,
      failures: 0,
      failedChanges: 0,
      selectionRate: 0
    })
    expect(Selection.metrics([], new Map())).toMatchObject({ rows: 0, selectionRate: 0 })
  })
})

describe("contract 7: command surface", () => {
  it("runs a read-only report with no command, and lists every flag on a command that exists", () => {
    expect(Command.name).toBe("smithers-ci")
    expect(Command.commands[""]).toContain("Writes nothing")
    const known = Object.keys(Command.commands)
    for (const flag of Object.values(Command.flags)) {
      for (const command of flag.on) expect(known).toContain(command)
    }
    expect(new Set(Object.values(Command.exitCodes)).size).toBe(Object.keys(Command.exitCodes).length)
  })
})

describe("contract 8: shards", () => {
  const labels = Array.from({ length: 200 }, (_, index) => `//packages/p${index}:test`)

  it("puts every label in exactly one shard, the same one on every call", () => {
    const shards = [0, 1, 2, 3].map((index) => Shard.labelsOf(labels, { index, count: 4 }))
    expect(shards.flat().sort()).toEqual([...labels].sort())
    expect(shards.every((shard) => shard.length > 20)).toBe(true)
    expect(Shard.shardOf("//packages/smithers:test", 4)).toBe(Shard.shardOf("//packages/smithers:test", 4))
    expect(Shard.labelsOf(labels, { index: 0, count: 1 })).toEqual(labels)
  })

  it("refuses a shard count below one", () => {
    expect(() => Schema.decodeUnknownSync(Shard.Shard)({ index: 0, count: 0 })).toThrow()
  })
})

describe("contract 9: dependency closure", () => {
  const closure: Closure.Closure = {
    strategy: "typescript",
    entries: ["src/a.test.ts"],
    files: [{ path: "src/a.test.ts", digest: "d1" }, { path: "src/a.ts", digest: "d2" }],
    packages: ["effect"],
    unresolved: [],
    dynamic: []
  }

  it("is affected only by a change to a file it reaches", () => {
    expect(Schema.decodeUnknownSync(Closure.Closure)(closure)).toEqual(closure)
    expect(Closure.isAffectedBy(closure, ["src/a.ts"])).toBe(true)
    expect(Closure.isAffectedBy(closure, ["src/b.ts", "README.md"])).toBe(false)
    expect(Closure.isAffectedBy(closure, [])).toBe(false)
  })

  it("is affected by every change when an import could not be followed", () => {
    const open = { from: "src/a.ts", specifier: "./plugins/" }
    expect(Closure.isComplete(closure)).toBe(true)
    expect(Closure.isAffectedBy({ ...closure, dynamic: [open] }, ["README.md"])).toBe(true)
    expect(Closure.isAffectedBy({ ...closure, unresolved: [open] }, ["README.md"])).toBe(true)
  })
})

describe("contract 10: parts", () => {
  it("names the part and a known reason in every failure", () => {
    const failure = { code: "unsupported", message: "bun install is not supported yet", part: "replay" }
    expect(Schema.decodeUnknownSync(Parts.Failure)(failure)).toEqual(failure)
    expect(() => Schema.decodeUnknownSync(Parts.Failure)({ ...failure, code: "oops" })).toThrow()
    expect(() => Schema.decodeUnknownSync(Parts.Failure)({ ...failure, part: "billing" })).toThrow()
  })
})
