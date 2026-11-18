import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  Closure,
  Command,
  Inventory,
  Parts,
  Plan,
  ReplayReport,
  RunRecord,
  Selection,
  Shard,
  TargetMap
} from "../src/index.ts"

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

  it("names the variable a secret arrives in, and holds what belongs to a file and to no job", () => {
    const bun = Schema.decodeUnknownSync(Inventory.Inventory)(fixture("inventory.github-actions-bun.json"))
    expect(bun.jobs[0]?.steps[1]?.secretEnv).toEqual({ CODECOV_TOKEN: "CODECOV_TOKEN" })
    expect(bun.unsupported?.map((entry) => entry.feature)).toEqual(["malformed-file"])
    const zig = Schema.decodeUnknownSync(Inventory.Inventory)(fixture("inventory.justfile-zig.json"))
    expect(zig.unsupported).toBeUndefined()
    expect(Inventory.shell).toEqual(["bash", "-e", "-c"])
  })

  it("fills one matrix variant into a step's command, directory and environment values", () => {
    const step: Inventory.Step = {
      id: "ci.yml:test:1",
      command: "bun test --shard=${{ matrix.shard }}/4 # ${{matrix.node.version}} ${{ matrix.absent }}",
      cwd: "packages/${{ matrix.package }}",
      env: { NODE: "${{ matrix.node.version }}", PLAIN: "${{ secrets.TOKEN }}" },
      secrets: []
    }
    const variant = { shard: "2", "node.version": "22", package: "core" }
    expect(Inventory.withVariant(step, variant)).toEqual({
      ...step,
      command: "bun test --shard=2/4 # 22 ${{ matrix.absent }}",
      cwd: "packages/core",
      env: { NODE: "22", PLAIN: "${{ secrets.TOKEN }}" }
    })
    expect(Inventory.expand("${{ matrix.constructor }} ${{ matrix.toString }}", {}))
      .toBe("${{ matrix.constructor }} ${{ matrix.toString }}")
    expect(Inventory.withVariant(step, {})).toEqual(step)
  })

  it("runs a job only when it has a step and exits", () => {
    const zig = Schema.decodeUnknownSync(Inventory.Inventory)(fixture("inventory.justfile-zig.json"))
    const job = zig.jobs[0]!
    expect(Inventory.isRunnable(job)).toBe(true)
    expect(Inventory.isRunnable({ ...job, steps: [] })).toBe(false)
    const server = { feature: Inventory.longRunning, detail: "bun run dev never exits" }
    expect(Inventory.isRunnable({ ...job, unsupported: [server] })).toBe(false)
    expect(Inventory.isRunnable({ ...job, unsupported: [{ feature: "uses", detail: "actions/cache" }] })).toBe(true)
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

  it("has default settings that decode", () => {
    expect(Schema.decodeUnknownSync(Selection.Settings)(Selection.defaultSettings)).toEqual({
      scoreCutoff: 0.1,
      countCutoff: 5
    })
  })

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

  it("gives every exit code a meaning and every part failure an exit code that is never ok or mismatch", () => {
    expect(Object.keys(Command.exitCodeHelp)).toEqual(Object.keys(Command.exitCodes))
    const codes = Object.values(Command.exitCodes) as ReadonlyArray<number>
    for (const code of Parts.Failure.fields.code.literals) {
      const exit = Command.failureExitCodes[code]
      expect(codes).toContain(exit)
      expect(exit).toBeGreaterThan(Command.exitCodes.mismatch)
    }
    expect(Command.failureExitCodes["command-failed"]).toBe(Command.exitCodes.failed)
  })

  it("names the document --json prints for exactly the commands that accept --json", () => {
    expect(Object.keys(Command.documents).sort()).toEqual([...Command.flags.json.on].sort())
    expect(Command.syntax.help).toContain("--help")
    expect(Command.syntax.value).toContain("--commits 5")
    expect(Object.keys(Command.environment)).toEqual(["SMITHERS_CACHE_TOKEN"])
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

  it("balances measured labels longest first and leaves unmeasured ones where the hash puts them", () => {
    const durations = { "//a:test": 40, "//b:test": 30, "//c:test": 20, "//d:test": 10, "//e:test": 10 }
    const labels = [...Object.keys(durations), "//f:lint", "//g:lint", "//a:test"]
    const assigned = Shard.assign(labels, 2, durations)
    const load = (index: number): number =>
      Object.entries(durations).filter(([label]) => assigned.get(label) === index).reduce((sum, [, ms]) => sum + ms, 0)
    expect([load(0), load(1)]).toEqual([60, 50])
    expect(assigned.get("//a:test")).toBe(0)
    expect(assigned.get("//b:test")).toBe(1)
    expect(assigned.get("//f:lint")).toBe(Shard.shardOf("//f:lint", 2))
    expect(assigned.get("//g:lint")).toBe(Shard.shardOf("//g:lint", 2))
    expect(assigned.size).toBe(7)
    expect([...Shard.assign([...labels].reverse(), 2, durations)].sort()).toEqual([...assigned].sort())
  })

  it("treats a duration that is missing, negative or not a number as unmeasured", () => {
    const labels = ["//a:test", "//b:test", "//c:test", "toString"]
    const durations = { "//a:test": Number.NaN, "//b:test": -5, "//c:test": Number.POSITIVE_INFINITY }
    const assigned = Shard.assign(labels, 3, durations)
    for (const label of labels) expect(assigned.get(label)).toBe(Shard.shardOf(label, 3))
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

describe("contract 10: the parts a replay is handed", () => {
  it("lets the program pass the reader, generator and scorer to a replay, with a cache for the generator", async () => {
    const calls: Array<string> = []
    const fail = (failure: Parts.Failure) => Effect.fail(failure)
    const parts: Parts.ReplayParts = {
      read: (root) => fail({ code: "not-a-repository", message: `${root} has no .git`, part: "inventory" }),
      files: (_inventory, options) => Effect.succeed([{ path: TargetMap.path, content: options?.cache ?? "" }]),
      rows: () => Effect.succeed([]),
      score: () => Effect.succeed([])
    }
    const run: Parts.RunReplay = (request, given) =>
      Effect.gen(function*() {
        calls.push(String(request.settings?.countCutoff ?? Selection.defaultSettings.countCutoff))
        const files = yield* given.files(
          { version: 1, repository: "r", commit: "c", toolchains: [], jobs: [] },
          { cache: request.cache }
        )
        for (const file of files) calls.push(file.path, file.content)
        const exit: number = yield* Effect.match(given.read(request.root), {
          onFailure: (failure) => Command.failureExitCodes[failure.code],
          onSuccess: () => Command.exitCodes.ok
        })
        return yield* fail({ code: "command-failed", message: `exit ${exit}`, part: "replay" })
      })
    const request = { root: "/tmp/x", commits: 1, modes: ["normal" as const], cache: "https://cache.example" }
    const failure = await Effect.runPromise(Effect.flip(run(request, parts)))
    expect(failure.message).toBe("exit 2")
    expect(calls).toEqual(["5", ".smithers/ci-targets.json", "https://cache.example"])
  })
})

describe("contract 11: target map", () => {
  const map = Schema.decodeUnknownSync(TargetMap.TargetMap)(fixture("target-map.example.json"))

  it("finds the target a step became, per matrix variant", () => {
    expect(TargetMap.labelOf(map, "ci.yml:test", "ci.yml:test:1", { os: "macos-latest" }))
      .toBe("//:ci-yml-test-1-os-macos-latest")
    expect(TargetMap.labelOf(map, "justfile:build", "justfile:build:1", {})).toBe("//:justfile-build-1")
  })

  it("has no target for a step, job or variant the generator did not write", () => {
    expect(TargetMap.labelOf(map, "ci.yml:test", "ci.yml:test:2", { os: "macos-latest" })).toBeUndefined()
    expect(TargetMap.labelOf(map, "ci.yml:lint", "ci.yml:test:1", { os: "macos-latest" })).toBeUndefined()
    expect(TargetMap.labelOf(map, "ci.yml:test", "ci.yml:test:1", { os: "windows-latest" })).toBeUndefined()
    expect(TargetMap.labelOf(map, "ci.yml:test", "ci.yml:test:1", {})).toBeUndefined()
  })

  it("reads a variant the same whatever order its keys are in", () => {
    expect(TargetMap.variantKey({ os: "linux", node: "22" })).toBe(TargetMap.variantKey({ node: "22", os: "linux" }))
    expect(TargetMap.variantKey({ os: "linux" })).not.toBe(TargetMap.variantKey({ os: "macos" }))
    expect(TargetMap.path).toBe(".smithers/ci-targets.json")
  })

  it("refuses an entry with no label", () => {
    const entry = { label: "", job: "j", step: "s", variant: {} }
    expect(() => Schema.decodeUnknownSync(TargetMap.Entry)(entry)).toThrow()
  })
})

describe("contract changes, third round", () => {
  const firstRow = (): Selection.Row => {
    const rows = fixture("selection-rows.example.json") as Array<unknown> | { rows: Array<unknown> }
    return Schema.decodeUnknownSync(Selection.Row)((Array.isArray(rows) ? rows : rows.rows)[0])
  }

  it("is affected by any file under a directory the closure reads whole, and by nothing beside it", () => {
    const closure: Closure.Closure = {
      strategy: "zig",
      entries: ["fmt"],
      files: [{ path: "build.zig", digest: "d" }],
      packages: ["zig@0.17.1"],
      unresolved: [],
      dynamic: [],
      directories: ["src", "tools/"]
    }
    expect(Schema.decodeUnknownSync(Closure.Closure)(closure)).toEqual(closure)
    expect(Closure.isAffectedBy(closure, ["src/new.zig"])).toBe(true)
    expect(Closure.isAffectedBy(closure, ["tools/gen/a.zig"])).toBe(true)
    expect(Closure.isAffectedBy(closure, ["build.zig"])).toBe(true)
    expect(Closure.isAffectedBy(closure, ["src2/new.zig", "srcfile", "docs/src/a.zig"])).toBe(false)
  })

  it("holds a row's time, a run's test count and the distance of a target nothing is known to reach", () => {
    const row = firstRow()
    expect(row.at).toBe(1_794_873_600_000)
    expect(
      Schema.decodeUnknownSync(Selection.Row)({ ...row, features: { ...row.features, graphDistance: -1 } })
        .features.graphDistance
    ).toBe(Selection.unreachable)
    const result = { label: "//a:test", status: "ran", key: "k", durationMs: 1, tests: 12 }
    expect(Schema.decodeUnknownSync(RunRecord.TargetResult)(result).tests).toBe(12)
    expect(() => Schema.decodeUnknownSync(RunRecord.TargetResult)({ ...result, tests: -1 })).toThrow()
  })

  it("counts a selection the same when one change has thousands of targets", () => {
    const row = firstRow()
    const rows = Array.from({ length: 4000 }, (_, index) => ({
      ...row,
      commit: "c1",
      target: `//p${index}:test`,
      failed: index % 1000 === 0,
      flaky: false
    }))
    const selected = new Map([["c1", rows.filter((_, index) => index % 2 === 0).map((entry) => entry.target)]])
    expect(Selection.metrics(rows, selected)).toEqual({
      rows: 4000,
      selected: 2000,
      failures: 4,
      failedChanges: 1,
      selectionRate: 0.5,
      testRecall: 1,
      changeRecall: 1
    })
    expect(Selection.metrics(rows, new Map()).selected).toBe(0)
  })

  it("lets a closure strategy fail as a part, and hands a plan to the row builder", async () => {
    const failure = { code: "unsupported", message: "zig 0.12 is too old", part: "closure" }
    expect(Schema.decodeUnknownSync(Parts.Failure)(failure)).toEqual(failure)
    const close: Parts.CloseEntries = (_root, entries) =>
      Effect.succeed(entries.map((entry) => ({
        strategy: "zig",
        entries: [entry],
        files: [],
        packages: [],
        unresolved: [],
        dynamic: []
      })))
    const plan = Schema.decodeUnknownSync(Plan.Plan)(fixture("plan.generate-package.json"))
    const seen: Array<number> = []
    const rows: Parts.BuildRows = (_root, _record, given) =>
      Effect.sync(() => {
        seen.push(given?.targets.length ?? -1)
        return []
      })
    const record = Schema.decodeUnknownSync(RunRecord.RunRecord)(fixture("run-record.rc18-workspace-targets.json"))
    const closures = await Effect.runPromise(close("/repo", ["test", "fmt"]))
    await Effect.runPromise(rows("/repo", record, plan))
    await Effect.runPromise(rows("/repo", record))
    expect(closures.map((closure) => closure.entries)).toEqual([["test"], ["fmt"]])
    expect(seen).toEqual([plan.targets.length, -1])
  })

  it("caps how many generated targets run at once, and names what apply refuses and ignores", () => {
    const map = Schema.decodeUnknownSync(TargetMap.TargetMap)(fixture("target-map.example.json"))
    expect(map.maxJobs).toBe(1)
    expect(() => Schema.decodeUnknownSync(TargetMap.TargetMap)({ ...map, maxJobs: 0 })).toThrow()
    expect(Command.applyRefuses).toEqual(["PACKAGE.ts", "PACKAGE.vibe", ".smithers/WORKSPACE.ts"])
    expect(Command.applyIgnores).toEqual([".flows"])
  })
})
