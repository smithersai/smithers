/** The pure parts of finding what can pass here and of stopping what has stalled. */
import { describe, expect, it } from "vitest"
import {
  type FailedHere,
  failsHere,
  type Inventory,
  type Job,
  notReplayed,
  reasonsText,
  variantsFailedHere,
  withoutFailedHere
} from "../../src/contract/Inventory.ts"
import type { Plan } from "../../src/contract/Plan.ts"
import type { TargetResult } from "../../src/contract/RunRecord.ts"
import { madeNoProgress, noJobPassed, noProgress, stoppedResults } from "../../src/replay/Failures.ts"
import { jobsCovered, rootsWithout, trialOf, type Unit, unitKey } from "../../src/replay/Summary.ts"

const jobOf = (id: string, matrix: ReadonlyArray<Readonly<Record<string, string>>> = []): Job => ({
  id,
  source: "github-actions",
  file: "ci.yml",
  name: id,
  needs: [],
  triggers: ["push"],
  matrix,
  steps: [{ id: `${id}0`, command: "true", cwd: "", env: {}, secrets: [] }],
  unsupported: []
})

const inventoryOf = (...jobs: ReadonlyArray<Job>): Inventory => ({
  version: 1,
  repository: "test/trial",
  commit: "0".repeat(40),
  toolchains: [],
  jobs
})

describe("what failed here, in an inventory", () => {
  const one = { size: "1" }
  const two = { size: "2" }
  const failed = (job: string, reason: string, variant?: Readonly<Record<string, string>>): FailedHere => ({
    job,
    reason,
    ...(variant === undefined ? {} : { variant })
  })

  it("leaves a job that failed whole out, with the first line of its error", () => {
    const left = notReplayed(withoutFailedHere(inventoryOf(jobOf("a"), jobOf("b")), [failed("a", "no docker")]))
    expect(left).toEqual([{ job: "a", reasons: [{ feature: failsHere, detail: "no docker" }] }])
    expect(reasonsText(left[0]?.reasons ?? [])).toBe("fails-here (no docker)")
  })

  it("takes a variant out of the job's matrix and lists it, whatever order its keys are in", () => {
    const inventory = inventoryOf(jobOf("m", [{ a: "1", b: "2" }, { a: "3", b: "4" }]))
    const gone = [failed("m", "(a=3, b=4) broken", { b: "4", a: "3" })]
    expect(withoutFailedHere(inventory, gone).jobs[0]?.matrix).toEqual([{ a: "1", b: "2" }])
    expect(variantsFailedHere(inventory, gone)).toEqual([
      { job: "m", reasons: [{ feature: failsHere, detail: "(a=3, b=4) broken" }] }
    ])
  })

  it("leaves a job out when every variant failed, and lists it once", () => {
    const inventory = inventoryOf(jobOf("m", [one, two]))
    const gone = [failed("m", "first", one), failed("m", "second", two)]
    expect(notReplayed(withoutFailedHere(inventory, gone))).toEqual([
      { job: "m", reasons: [{ feature: failsHere, detail: "first" }] }
    ])
    expect(variantsFailedHere(inventory, gone)).toEqual([])
  })

  it("prefers the reason of a whole-job failure", () => {
    const gone = [failed("m", "variant", one), failed("m", "whole")]
    expect(notReplayed(withoutFailedHere(inventoryOf(jobOf("m", [one, two])), gone))[0]?.reasons).toEqual([
      { feature: failsHere, detail: "whole" }
    ])
  })

  it("ignores what this commit does not hold", () => {
    const inventory = inventoryOf(jobOf("a"))
    expect(withoutFailedHere(inventory, [failed("gone", "x")])).toEqual(inventory)
    expect(withoutFailedHere(inventory, [])).toEqual(inventory)
    expect(variantsFailedHere(inventory, [failed("gone", "x", one)])).toEqual([])
  })
})

const step = (label: string) => ({
  id: label,
  name: label,
  label,
  targets: [label],
  command: "true",
  written: "true",
  cwd: "",
  env: {}
})
const unit = (job: string, labels: ReadonlyArray<string>, variant?: Readonly<Record<string, string>>): Unit => ({
  job,
  needs: [],
  steps: labels.map(step),
  ...(variant === undefined ? {} : { variant })
})
const result = (label: string, status: TargetResult["status"], error?: string): TargetResult => ({
  label,
  status,
  key: "",
  durationMs: 1,
  ...(error === undefined ? {} : { error })
})

describe("what one run says of each unit", () => {
  it("sorts units into passed, failed and neither", () => {
    const units = [
      unit("ok", ["a"]),
      unit("bad", ["b", "c"]),
      unit("m", ["d"], { size: "2" }),
      unit("behind", ["e"]),
      unit("unseen", ["f"])
    ]
    const found = trialOf(units, [
      result("a", "ran"),
      result("b", "ran"),
      result("c", "failed", "broken"),
      result("d", "failed", "too big"),
      result("e", "skipped")
    ], new Map())
    expect(found.passed).toEqual(["ok"])
    expect(found.failed).toEqual([
      { job: "bad", reason: "broken" },
      { job: "m", variant: { size: "2" }, reason: "(size=2) too big" }
    ])
    expect(found.first?.reason).toBe("broken")
  })

  it("has no first failure when nothing failed", () => {
    expect(trialOf([unit("ok", ["a"])], [result("a", "ran")], new Map()).first).toBeUndefined()
  })

  it("names a unit by its job and variant", () => {
    expect(unitKey({ job: "a" })).toBe("a")
    expect(unitKey({ job: "a", variant: { size: "1" } })).toBe("a (size=1)")
  })

  it("counts the jobs replayed, of those and the jobs left out, each once", () => {
    const left = [{ job: "m", reasons: [] }, { job: "gone", reasons: [] }]
    expect(jobsCovered([{ job: "m" }, { job: "m" }, { job: "a" }], left)).toEqual({ replayed: 2, total: 3 })
  })
})

describe("the roots of a plan without what was left out", () => {
  const target = (label: string, dependencies: ReadonlyArray<string> = []) => ({
    label,
    rule: "x",
    key: "",
    cacheable: true,
    dependencies
  })
  const plan: Plan = {
    verb: "ci",
    pattern: "//...",
    roots: ["//:bad", "//:behind", "//:far", "//:ok", "//:twice"],
    targets: [
      target("//:bad"),
      target("//:behind", ["//:bad"]),
      target("//:far", ["//:behind"]),
      target("//:ok", ["//:shared", "//:elsewhere"]),
      target("//:twice", ["//:shared"]),
      target("//:shared")
    ]
  }

  it("drops a left-out target and all that wait on it, near or far", () => {
    expect(rootsWithout(plan, new Set(["//:bad"]))).toEqual(["//:ok", "//:twice"])
  })

  it("survives a plan whose targets wait on each other", () => {
    const circle: Plan = { ...plan, roots: ["//:x"], targets: [target("//:x", ["//:y"]), target("//:y", ["//:x"])] }
    expect(rootsWithout(circle, new Set(["//:bad"]))).toEqual(["//:x"])
  })
})

describe("a run stopped for making no progress", () => {
  const reason = noProgress(10)

  it("says for how long, in words", () => {
    expect(reason).toBe("it made no progress for 10 minutes")
    expect(noProgress(1)).toBe("it made no progress for 1 minute")
    expect(noProgress(0.5)).toBe("it made no progress for 0.5 minutes")
  })

  it("is told from any other failure", () => {
    expect(madeNoProgress({ error: reason })).toBe(true)
    expect(madeNoProgress({ error: "broken" })).toBe(false)
    expect(madeNoProgress({})).toBe(false)
  })

  it("blames the targets that ran as long as the limit, and only them", () => {
    const short = { ...result("//:short", "failed", "broken"), exitCode: 2 }
    const long = { ...result("//:long", "failed", "killed"), durationMs: 600_000, exitCode: 137 }
    const passed = { ...result("//:ok", "ran"), durationMs: 700_000 }
    expect(stoppedResults([short, long, passed], [], 600_000, reason)).toEqual([
      short,
      { ...result("//:long", "failed", reason), durationMs: 600_000 },
      passed
    ])
  })

  it("fails every target asked for when there is no run record", () => {
    expect(stoppedResults(undefined, ["//:a"], 5, reason)).toEqual([
      { label: "//:a", status: "failed", key: "", durationMs: 5, error: reason }
    ])
  })
})

describe("no job passing", () => {
  it("says at which commit, with the first failure", () => {
    expect(noJobPassed("abcdef0123", { step: "s", reason: "r", exitCode: 3, command: "c" })).toBe(
      [
        "this repository's CI does not pass on this machine, so there is no speedup to measure. No job passed at abcdef0.",
        "First failure at abcdef0:",
        "  step     s",
        "  command  c",
        "  exit     3",
        "  error    r"
      ].join("\n")
    )
  })
})
