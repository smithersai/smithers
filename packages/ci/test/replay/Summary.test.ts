import { describe, expect, it } from "vitest"
import { type Inventory, type Job, longRunning } from "../../src/contract/Inventory.ts"
import type { RunRecord, TargetResult } from "../../src/contract/RunRecord.ts"
import type { TargetMap } from "../../src/contract/TargetMap.ts"
import {
  addRerun,
  blocked,
  choose,
  cycleIn,
  firstAttempt,
  groupByJob,
  isBlocked,
  labelsOf,
  maxReruns,
  mismatchesOf,
  predictedSafe,
  recordOf,
  recovered,
  reportOf,
  selectionOf,
  totalsOf,
  unitsOf
} from "../../src/replay/Summary.ts"

const step = (id: string, command: string, env: Readonly<Record<string, string>> = {}) => ({
  id,
  command,
  cwd: "",
  env,
  secrets: []
})
const job = (id: string, extra: Partial<Job> = {}): Job => ({
  id,
  source: "github-actions",
  file: "ci.yml",
  name: id,
  needs: [],
  triggers: [],
  matrix: [],
  steps: [step(`${id}1`, "true")],
  unsupported: [],
  ...extra
})
const inventory = (jobs: ReadonlyArray<Job>): Inventory => ({
  version: 1,
  repository: "r",
  commit: "c",
  toolchains: [],
  jobs
})
const ran = (label: string, durationMs = 5): TargetResult => ({ label, status: "ran", key: "k", durationMs })
const failed = (label: string): TargetResult => ({
  label,
  status: "failed",
  key: "k",
  durationMs: 7,
  error: "boom",
  failureDigest: "d"
})
const record = (results: ReadonlyArray<TargetResult>): RunRecord => recordOf(results, "c", 10, "normal")

describe("unitsOf", () => {
  const map = (
    entries: ReadonlyArray<readonly [string, string, Readonly<Record<string, string>>, string]>
  ): TargetMap => ({
    version: 1,
    targets: entries.map(([job, step, variant, label]) => ({ job, step, variant, label }))
  })

  it("keeps runnable jobs a push or pull request runs and drops needs on the others", () => {
    const units = unitsOf(
      inventory([
        job("push", { triggers: ["push"] }),
        job("pr", { triggers: ["pull_request"], needs: ["push", "cron", "dev"] }),
        job("cron", { triggers: ["schedule"] }),
        job("dev", { unsupported: [{ feature: longRunning, detail: "a server" }] }),
        job("empty", { steps: [] })
      ]),
      map([])
    )
    expect(units.map((unit) => unit.job)).toEqual(["push", "pr"])
    expect(units[1]?.needs).toEqual(["push"])
  })

  it("runs a job once per matrix variant with its values filled in, and finds each target", () => {
    const os = {
      id: "s",
      command: "echo ${{ matrix.os }}",
      cwd: "${{ matrix.os }}",
      env: { WHERE: "${{matrix.os}}" },
      secrets: []
    }
    const [one, two] = unitsOf(
      inventory([job("m", { matrix: [{ os: "linux" }, { os: "mac" }], steps: [os] })]),
      map([["m", "s", { os: "linux" }, "//:linux"]])
    )
    expect(one?.steps[0]).toEqual({
      id: "s",
      label: "//:linux",
      command: "echo linux",
      cwd: "linux",
      env: { WHERE: "linux" }
    })
    expect(two?.steps[0]).toMatchObject({ label: undefined, command: "echo mac" })
  })

  it("groups a job's variants", () => {
    const units = unitsOf(inventory([job("m", { matrix: [{ a: "1" }, { a: "2" }] }), job("n")]), map([]))
    expect(groupByJob(units).map((group) => [group.job, group.units.length])).toEqual([["m", 2], ["n", 1]])
  })

  it("lists a unit's target labels, limited to the wanted ones", () => {
    const [unit] = unitsOf(
      inventory([job("j", { steps: [step("a", "true"), step("b", "true"), step("c", "true")] })]),
      map([["j", "a", {}, "//:a"], ["j", "b", {}, "//:b"]])
    )
    expect(labelsOf(unit!, undefined)).toEqual(["//:a", "//:b"])
    expect(labelsOf(unit!, new Set(["//:b"]))).toEqual(["//:b"])
  })
})

describe("cycleIn", () => {
  const unit = (id: string, needs: ReadonlyArray<string>) => ({ job: id, needs, steps: [] })

  it("accepts needs in any order and names a job in a cycle", () => {
    expect(cycleIn([unit("b", ["a"]), unit("a", [])])).toBeUndefined()
    expect(cycleIn([unit("x", []), unit("a", ["b"]), unit("b", ["a"])])).toBe("a")
  })
})

describe("attempts", () => {
  it("records what a first run did", () => {
    expect(firstAttempt(ran("a")).attempts).toEqual([{ passed: true, durationMs: 5 }])
    expect(firstAttempt(failed("a")).attempts).toEqual([{ passed: false, durationMs: 7 }])
    const hit: TargetResult = { label: "a", status: "hit", key: "k", durationMs: 1 }
    expect(firstAttempt(hit)).toEqual(hit)
    const skipped: TargetResult = { label: "a", status: "skipped", key: "k", durationMs: 0 }
    expect(firstAttempt(skipped).skipReason).toBe("dependency-failed")
    expect(firstAttempt(predictedSafe("a")).skipReason).toBe("predicted-safe")
  })

  it("makes a target that passes a rerun flaky and clears its failure", () => {
    const after = addRerun(firstAttempt(failed("a")), ran("a", 3))
    expect(after).toEqual({
      label: "a",
      status: "ran",
      key: "k",
      durationMs: 7,
      attempts: [{ passed: false, durationMs: 7 }, { passed: true, durationMs: 3 }]
    })
    expect(recovered(after)).toBe(true)
  })

  it("counts a cache hit on a rerun as a pass", () => {
    const hit: TargetResult = { label: "a", status: "hit", key: "k", durationMs: 0 }
    expect(addRerun(firstAttempt(failed("a")), hit).status).toBe("ran")
  })

  it("keeps a target failed when the rerun fails or never reaches it", () => {
    const once = addRerun(firstAttempt(failed("a")), failed("a"))
    const twice = addRerun(once, undefined)
    expect(twice.status).toBe("failed")
    expect(twice.attempts?.map((attempt) => attempt.passed)).toEqual([false, false, false])
    expect(twice.attempts?.[2]?.durationMs).toBe(0)
    expect(twice.error).toBe("boom")
    expect(recovered(twice)).toBe(false)
    expect(recovered(firstAttempt(ran("a")))).toBe(false)
  })

  it("adds a rerun to a target with no recorded attempts", () => {
    expect(addRerun(failed("a"), undefined).attempts).toEqual([{ passed: false, durationMs: 0 }])
  })

  it("reruns up to ten times", () => {
    expect(maxReruns).toBe(10)
  })

  it("tells a blocked target from a predicted-safe one", () => {
    expect(isBlocked(blocked("a", "b"))).toBe(true)
    expect(blocked("a", "b").blockedBy).toBe("b")
    expect(isBlocked(predictedSafe("a"))).toBe(false)
    expect(isBlocked(ran("a"))).toBe(false)
  })
})

describe("records and totals", () => {
  it("counts statuses and is red only when a target failed", () => {
    const green = recordOf([ran("a"), blocked("b", "a")], "c", 4)
    expect(green).toMatchObject({ ok: true, commit: "c", durationMs: 4, cache: false })
    expect(green.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 1 })
    expect(green.mode).toBeUndefined()
    const red = recordOf([failed("a")], "c", 4, "fast")
    expect(red).toMatchObject({ ok: false, mode: "fast", cache: true })
  })

  it("sums work and reads wall time from the record", () => {
    expect(totalsOf(record([ran("a", 2), ran("b", 3)]))).toMatchObject({ ok: true, wallMs: 10, workMs: 5 })
    const { durationMs: _durationMs, ...timeless } = record([])
    expect(totalsOf(timeless).wallMs).toBe(0)
  })
})

describe("mismatchesOf", () => {
  it("reports a differing verdict", () => {
    expect(mismatchesOf("normal", record([failed("a")]), record([ran("a")]))).toEqual([
      { label: "a", mode: "normal", baseline: "fail", got: "pass" }
    ])
    expect(mismatchesOf("normal", record([ran("a")]), record([ran("a")]))).toEqual([])
  })

  it("counts a target the mode never reported as skipped", () => {
    expect(mismatchesOf("normal", record([ran("a")]), record([]))).toEqual([
      { label: "a", mode: "normal", baseline: "pass", got: "skipped" }
    ])
    expect(mismatchesOf("normal", record([blocked("a", "b")]), record([]))).toEqual([])
  })

  it("forgives a predicted-safe skip unless the baseline failed", () => {
    const got = record([predictedSafe("a")])
    expect(mismatchesOf("fast", record([ran("a")]), got)).toEqual([])
    expect(mismatchesOf("fast", record([failed("a")]), got)).toEqual([
      { label: "a", mode: "fast", baseline: "fail", got: "skipped" }
    ])
  })

  it("ignores a target only the mode has", () => {
    expect(mismatchesOf("normal", record([]), record([ran("extra")]))).toEqual([])
  })
})

describe("selection", () => {
  const score = (target: string, value: number) => ({ commit: "c", target, score: value })

  it("skips only the scored targets it did not select", () => {
    const choice = choose([score("a", 0.9), score("b", 0.1)], { scoreCutoff: 0.5, countCutoff: 0 })
    expect(choice.selected).toEqual(["a"])
    expect([...choice.skipped]).toEqual(["b"])
  })

  it("measures selection over rows", () => {
    expect(selectionOf([], new Map())).toMatchObject({ rows: 0, selected: 0 })
  })
})

describe("reportOf", () => {
  const totals = (wallMs: number) => ({
    ok: true,
    wallMs,
    workMs: wallMs,
    counts: { hit: 0, ran: 1, failed: 0, skipped: 0 }
  })
  const entry = { commit: "c", changedFiles: 1, baseline: totals(30), normal: totals(10), mismatches: [] }

  it("divides baseline wall time by normal-mode wall time", () => {
    const report = reportOf("r", [entry, entry], undefined)
    expect(report).toMatchObject({ baselineWallMs: 60, normalWallMs: 20, speedup: 3, mismatches: 0 })
    expect(report.fastWallMs).toBeUndefined()
  })

  it("is 0 when nothing ran, and sums fast mode when it ran", () => {
    expect(reportOf("r", [], undefined).speedup).toBe(0)
    const metrics = selectionOf([], new Map())
    expect(reportOf("r", [{ ...entry, fast: totals(4) }, entry], metrics)).toMatchObject({
      fastWallMs: 4,
      selection: metrics
    })
  })
})
