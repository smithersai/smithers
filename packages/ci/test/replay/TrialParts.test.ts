/** The pure parts of finding what can pass here and of stopping what has stalled. */
import { describe, expect, it } from "vitest"
import { failsHere } from "../../src/contract/Inventory.vibe"
import type { Plan } from "../../src/contract/Plan.vibe"
import type { TargetResult } from "../../src/contract/RunRecord.vibe"
import { madeNoProgress, noJobPassed, noProgress, stoppedResults } from "../../src/replay/Failures.ts"
import {
  exitAndError,
  failedStep,
  jobsCovered,
  rootsWithout,
  tooFewLeft,
  trialOf,
  type Unit,
  unitKey
} from "../../src/replay/Summary.vibe"

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
      { job: "bad", reason: "c: broken" },
      { job: "m", variant: { size: "2" }, reason: "(size=2) d: too big" }
    ])
    expect(found.first?.reason).toBe("broken")
  })

  it("gives a job left out the step that failed, its exit code and the first line of its error", () => {
    const units = [unit("lint", ["a"]), unit("m", ["b"], { size: "2" })]
    const names = new Map([
      ["a", { step: "lint: golangci-lint", command: "golangci-lint run" }],
      ["b", { step: "m: test (size=2)", command: "make test" }]
    ])
    const found = trialOf(units, [
      { ...result("a", "failed", "`golangci-lint` is not installed on this machine"), exitCode: 127 },
      { ...result("b", "failed", "too big"), exitCode: 1 }
    ], names)
    expect(found.failed.map((entry) => entry.reason)).toEqual([
      "lint: golangci-lint: exit 127: `golangci-lint` is not installed on this machine",
      // The step's name says which variant: it is not said twice.
      "m: test (size=2): exit 1: too big"
    ])
    expect(exitAndError({ reason: "it made no progress for 10 minutes" })).toBe("it made no progress for 10 minutes")
    expect(failedStep({ step: "build", reason: "boom", exitCode: 2 })).toBe("build: exit 2: boom")
  })

  it("refuses to measure a CI of which the first run left out half or more, and says what and why", () => {
    const fails = (job: string, detail: string) => ({ job, reasons: [{ feature: failsHere, detail }] })
    const needs = { job: "e2e", reasons: [{ feature: "needs", detail: "e2e needs lint, which is not replayed" }] }
    // Under half: the report covers the rest and says how many.
    expect(tooFewLeft(3, [fails("lint", "x")])).toBeUndefined()
    expect(tooFewLeft(4, [])).toBeUndefined()
    expect(tooFewLeft(2, [fails("lint", "lint: exit 127: no linter")])).toBe([
      "this replay cannot measure your CI on this machine: 1 of its 2 jobs does not pass here, and a speedup over the rest would not be your CI's.",
      "  lint  fails on this machine: lint: exit 127: no linter",
      "Fix what a line names and run it again, or pass --no-trial to compare every job as it is."
    ].join("\n"))
    const most = tooFewLeft(4, [fails("lint", "x"), needs], "target") as string
    expect(most.split("\n")[0]).toContain("2 of its 4 targets do not pass here")
    expect(most).toContain("\n  lint  fails on this machine: x\n  e2e   ")
    expect(most).toContain("to compare every target as it is.")
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
    const failed = { step: "s", reason: "r", exitCode: 3, command: "c" }
    // The jobs that failed ran once more at another commit, and none passed there either.
    expect(noJobPassed("abcdef0123", failed, "1234567890").split("\n").slice(0, 2)).toEqual([
      "this repository's CI does not pass on this machine, so there is no speedup to measure. No job passed at abcdef0 or at 1234567.",
      "First failure at abcdef0:"
    ])
    expect(noJobPassed("abcdef0123", failed, "abcdef0123")).toBe(noJobPassed("abcdef0123", failed))
    expect(noJobPassed("abcdef0123", failed)).toBe(
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
