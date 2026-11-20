import { describe, expect, it } from "vitest"
import { type Ci, ci, type Inventory, type Job, longRunning } from "../../src/contract/Inventory.ts"
import type { RunRecord, TargetResult } from "../../src/contract/RunRecord.ts"
import type { TargetMap } from "../../src/contract/TargetMap.ts"
import {
  addRerun,
  blocked,
  choose,
  cycleIn,
  failedAt,
  failedTwice,
  failureTexts,
  fastRunOf,
  finishedReport,
  firstAttempt,
  flakyOf,
  isBlocked,
  jobsFor,
  labelsOf,
  maxReruns,
  mismatchesOf,
  modelOf,
  noCiBefore,
  noCommitBefore,
  nothingToReplay,
  planOfPrinted,
  predictedSafe,
  ranAgainAt,
  recordOf,
  recovered,
  replayable,
  reportOf,
  runNames,
  seenIn,
  selectionOf,
  splitOf,
  startCostOf,
  stationsOf,
  stepKey,
  stepNames,
  stepsThrough,
  targetsOf,
  totalsOf,
  withCheckout,
  withoutCredentials,
  withoutFast
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
  triggers: ["push"],
  matrix: [],
  steps: [step(`${id}1`, "true")],
  unsupported: [],
  ...extra
})
const inventory = (jobs: ReadonlyArray<Job>): Ci =>
  ci({
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

type Entries = ReadonlyArray<readonly [string, string, Readonly<Record<string, string>>, string]>
const map = (entries: Entries): TargetMap => ({
  version: 1,
  targets: entries.map(([job, step, variant, label]) => ({ job, step, variant, label }))
})
/** A target for every step of every variant, named after the step and the variant's values. */
const mapAll = (inventory: Ci): TargetMap =>
  map(
    inventory.jobs.flatMap((entry) =>
      (entry.matrix.length === 0 ? [{}] : entry.matrix).flatMap((variant) =>
        entry.steps.map((each) =>
          [entry.id, each.id, variant, `//:${[each.id, ...Object.values(variant)].join("-")}`] as const
        )
      )
    )
  )
const unitsOf = (inventory: Ci, targets: TargetMap = mapAll(inventory)) => replayable(inventory, targets, "linux").units

describe("replayable", () => {
  it("makes a unit of every job the CI holds, and of no other", () => {
    const units = unitsOf(
      inventory([
        job("push"),
        job("pr", { triggers: ["pull_request"], needs: ["push", "gate"] }),
        job("gate", { steps: [], needs: ["push"] }),
        job("cron", { triggers: ["schedule"] }),
        job("dev", { unsupported: [{ feature: longRunning, detail: "a server" }] }),
        job("after-dev", { needs: ["dev"] })
      ])
    )
    expect(units.map((unit) => unit.job)).toEqual(["push", "pr"])
    expect(units[1]?.needs).toEqual(["push"])
    expect(units.map((unit) => unit.tree)).toEqual([undefined, undefined])
  })

  it("runs a step with runner text as that text, with the variant's values in it and in the command", () => {
    const runner = `__smithers_ci_step() { echo '\${{ matrix.size }}'; bash -e -c "$1"; }`
    const sized = { id: "s", command: "echo ${{ matrix.size }}", cwd: "", env: {}, secrets: [], runner }
    const units = unitsOf(inventory([job("a", { steps: [sized], matrix: [{ size: "big" }] })]))
    // The jobs of a baseline run at once in one checkout, so each step is told its job.
    expect(units[0]?.steps[0]?.command).toBe(
      [
        `__smithers_ci_unit='a'`,
        `__smithers_ci_part=`,
        `__smithers_ci_step() { echo 'big'; bash -e -c "$1"; }`,
        `__smithers_ci_step 'echo big'`
      ].join("\n")
    )
  })

  it("runs a job once per matrix variant with its values filled in, and finds each target", () => {
    const size = {
      id: "s",
      command: "echo ${{ matrix.size }}",
      cwd: "${{ matrix.size }}",
      env: { WHERE: "${{matrix.size}}" },
      secrets: []
    }
    const [one, two] = unitsOf(inventory([job("m", { matrix: [{ size: "small" }, { size: "big" }], steps: [size] })]))
    expect(one?.steps[0]).toEqual({
      id: "s",
      name: "s (size=small)",
      label: "//:s-small",
      targets: ["//:s-small"],
      command: "echo small",
      written: "echo small",
      cwd: "small",
      env: { WHERE: "small" }
    })
    expect(two?.steps[0]).toMatchObject({ label: "//:s-big", targets: ["//:s-big"], command: "echo big" })
  })

  it("calls a step by its name in its job when it has one, and names every label and target of it", () => {
    const named = { ...step("s", "make test"), name: "Run tests" }
    const units = unitsOf(
      inventory([job("j", { steps: [named, step("t", "true")] })]),
      map([["j", "s", {}, "//:s-a"], ["j", "s", {}, "//:s-b"], ["j", "t", {}, "//:t"]])
    )
    expect(units[0]?.steps.map((entry) => entry.name)).toEqual(["j: Run tests", "t"])
    expect([...stepNames(units)]).toEqual([
      // One step follows the first in its job, and none the last.
      ["s", { step: "j: Run tests", command: "make test", after: 1 }],
      ["//:s-a", { step: "j: Run tests", command: "make test", after: 1 }],
      ["//:s-b", { step: "j: Run tests", command: "make test", after: 1 }],
      ["//:t", { step: "t", command: "true", after: 0 }]
    ])
  })

  it("calls a target of a split step by the part of the step it runs", () => {
    const named = { ...step("s", "npm run check"), name: "Check" }
    const split: TargetMap = {
      version: 1,
      targets: [
        { label: "//:s-lint", job: "j", step: "s", variant: {}, part: "lint" },
        { label: "//:s-types", job: "j", step: "s", variant: {}, part: "types" },
        { label: "//:t", job: "j", step: "t", variant: {} }
      ]
    }
    const units = unitsOf(inventory([job("j", { steps: [named, step("t", "true")] })]), split)
    expect(units[0]?.steps[0]?.parts).toEqual({ "//:s-lint": "lint", "//:s-types": "types" })
    expect(units[0]?.steps[1]?.parts).toBeUndefined()
    // The step itself, which the baseline's verdict is compared under, keeps its name.
    expect([...stepNames(units)]).toEqual([
      ["s", { step: "j: Check", command: "npm run check", after: 1 }],
      ["//:s-lint", { step: "j: Check (lint)", command: "npm run check", after: 1 }],
      ["//:s-types", { step: "j: Check (types)", command: "npm run check", after: 1 }],
      ["//:t", { step: "t", command: "true", after: 0 }]
    ])
  })

  it("knows a step of a matrix job by its name without the variant too", () => {
    const named = { ...step("s", "npm run check"), name: "Check" }
    const matrix = job("j", { steps: [named, step("t", "npm test")], matrix: [{ node: "22" }, { node: "24" }] })
    const split: TargetMap = {
      version: 1,
      targets: [
        { label: "//:s-22-lint", job: "j", step: "s", variant: { node: "22" }, part: "lint" },
        { label: "//:s-22-types", job: "j", step: "s", variant: { node: "22" }, part: "types" },
        { label: "//:t-22", job: "j", step: "t", variant: { node: "22" } },
        { label: "//:s-24", job: "j", step: "s", variant: { node: "24" } },
        { label: "//:t-24", job: "j", step: "t", variant: { node: "24" } }
      ]
    }
    const names = stepNames(unitsOf(inventory([matrix]), split))
    expect(names.get("//:t-22")).toEqual({ step: "t (node=22)", command: "npm test", after: 0, variantOf: "t" })
    expect(names.get("//:s-24")).toEqual({
      step: "j: Check (node=24)",
      command: "npm run check",
      after: 1,
      variantOf: "j: Check"
    })
    // A part of a split step keeps its part in both names.
    expect(names.get("//:s-22-lint")).toEqual({
      step: "j: Check (node=22) (lint)",
      command: "npm run check",
      after: 1,
      variantOf: "j: Check (lint)"
    })
    const totals = totalsOf(record([{ ...ran("//:t-22"), notReused: "src/a.ts changed" }]), names)
    expect(totals.notReused).toEqual([
      { step: "t (node=22)", reason: "src/a.ts changed", kept: true, command: "npm test", variantOf: "t" }
    ])
  })

  it("shows a step's command as its CI file writes it, not the text that runs it", () => {
    const wrapped = { ...step("s", "make test"), runner: "prepare_the_job" }
    const [unit] = unitsOf(inventory([job("j", { steps: [wrapped] })]))
    expect(unit?.steps[0]?.command).toContain("prepare_the_job")
    expect(unit?.steps[0]?.written).toBe("make test")
    expect(stepNames([unit!]).get("//:s")).toEqual({ step: "s", command: "make test", after: 0 })
  })

  it("compares a split step under its own id, and runs every target it became", () => {
    const units = unitsOf(
      inventory([job("j", { steps: [step("whole", "true"), step("split", "true")] })]),
      map([["j", "whole", {}, "//:whole"], ["j", "split", {}, "//:split-a"], ["j", "split", {}, "//:split-b"]])
    )
    expect(units[0]!.steps.map((entry) => [entry.label, entry.targets])).toEqual([
      ["//:whole", ["//:whole"]],
      ["split", ["//:split-a", "//:split-b"]]
    ])
    expect(labelsOf(units[0]!, undefined)).toEqual(["//:whole", "split"])
    expect(targetsOf(units)).toEqual(["//:whole", "//:split-a", "//:split-b"])
    expect([...splitOf(units)]).toEqual([["split", ["//:split-a", "//:split-b"]]])
  })

  it("compares a split step of a matrix job under a name for each variant, with that variant's targets", () => {
    const variants = [{ suite: "one", node: "22" }, { node: "22", suite: "two" }]
    const units = unitsOf(
      inventory([job("j", { matrix: variants, steps: [step("s", "true")] })]),
      map(
        variants.flatMap((variant) =>
          ["a", "b"].map((name) => ["j", "s", variant, `//:s-${name}--${variant.suite}`] as const)
        )
      )
    )
    expect(stepKey("s", {})).toBe("s")
    expect(units.map((unit) => unit.steps[0]!.label)).toEqual(["s (node=22, suite=one)", "s (node=22, suite=two)"])
    expect([...splitOf(units)]).toEqual([
      ["s (node=22, suite=one)", ["//:s-a--one", "//:s-b--one"]],
      ["s (node=22, suite=two)", ["//:s-a--two", "//:s-b--two"]]
    ])
    // The hidden failure of review finding 7: variant one's target fails, and only variant one's step differs.
    const baseline = record(units.map((unit) => ran(unit.steps[0]!.label)))
    const normal = record([failed("//:s-a--one"), ran("//:s-b--one"), ran("//:s-a--two"), ran("//:s-b--two")])
    expect(mismatchesOf("normal", baseline, normal, splitOf(units))).toEqual([
      { label: "s (node=22, suite=one)", mode: "normal", baseline: "pass", got: "fail" }
    ])
  })

  it("starts a job's variants together, each in a run of its own", () => {
    const units = unitsOf(
      inventory([job("m", { matrix: [{ a: "1" }, { a: "2" }], needs: ["n"] }), job("n"), job("o", { needs: ["m"] })])
    )
    const stations = stationsOf(units)
    expect(stations.map((station) => [station.jobs, station.needs, station.runs.map((run) => run.length)])).toEqual([
      [["m"], ["n"], [1, 1]],
      [["n"], [], [1]],
      [["o"], ["m"], [1]]
    ])
    // A rerun names what it wants: only the runs that hold it are kept.
    expect(stationsOf(units, new Set(["//:m1-2"])).map((station) => [station.jobs, station.runs.length])).toEqual([
      [["m"], 1]
    ])
    expect(stationsOf(units, new Set(["//:gone"]))).toEqual([])
  })

  it("names each run's machine the same at every commit, and apart from every other run", () => {
    const units = unitsOf(inventory([job("m", { matrix: [{ a: "1" }, { a: "2" }] }), job("n/x y")]))
    const runs = stationsOf(units).flatMap((station) => station.runs)
    const names = runNames(runs)
    expect(names).toEqual(runNames(
      unitsOf(inventory([job("m", { matrix: [{ a: "1" }, { a: "2" }] }), job("n/x y")]))
        .map((unit) => [unit])
    ))
    expect(names.map((name) => name.replace(/-[0-9a-f]{12}$/, ""))).toEqual(["m", "m", "n-x-y"])
    expect(new Set(names).size).toBe(3)
    // Two runs of the same units are two machines.
    const first = runs[0] ?? []
    expect(runNames([first, first])).toEqual([names[0], `${names[0]}-1`])
    // The jobs of one shared tree are one run, named by the tree.
    const tree = unitsOf(inventory([
      job("justfile:ci", { source: "justfile", file: "Justfile", needs: ["justfile:build"], triggers: [] }),
      job("justfile:build", { source: "justfile", file: "Justfile", triggers: [] })
    ]))
    const [shared] = stationsOf(tree).flatMap((station) => station.runs)
    expect(runNames([shared ?? []])[0]).toMatch(/^Justfile-Justfile-[0-9a-f]{12}$/)
  })

  it("runs the jobs of one shared tree as one run, in order, and reruns a job after the jobs before it", () => {
    const recipe = (id: string, needs: ReadonlyArray<string> = []) =>
      job(id, { source: "justfile", file: "Justfile", needs: [...needs], triggers: [] })
    const units = unitsOf(
      inventory([
        recipe("justfile:ci", ["justfile:build", "justfile:test", "justfile:lint"]),
        recipe("justfile:lint"),
        recipe("justfile:test", ["justfile:build"]),
        recipe("justfile:build")
      ])
    )
    const [station] = stationsOf(units)
    expect(stationsOf(units)).toHaveLength(1)
    // What its jobs need of each other is the order of the run, not a need on another station.
    expect(station?.needs).toEqual([])
    expect(station?.jobs).toEqual(["justfile:build", "justfile:test", "justfile:lint", "justfile:ci"])
    expect(station?.runs.map((run) => run.map((unit) => unit.job))).toEqual([station?.jobs])
    const run = station!.runs[0]!
    expect(stepsThrough(run, undefined).map((step) => step.id)).toEqual([
      "justfile:build1",
      "justfile:test1",
      "justfile:lint1",
      "justfile:ci1"
    ])
    // A rerun of `test` runs `build` first, and stops there.
    const wanted = new Set(["//:justfile:test1"])
    expect(stationsOf(units, wanted)[0]?.runs[0]).toEqual(run)
    expect(stepsThrough(run, wanted).map((step) => step.id)).toEqual(["justfile:build1", "justfile:test1"])
    expect(stepsThrough(run, new Set(["//:gone"]))).toEqual([])
  })

  it("lists a unit's comparison names, limited to the wanted ones", () => {
    const [unit] = unitsOf(inventory([job("j", { steps: [step("a", "true"), step("b", "true")] })]))
    expect(labelsOf(unit!, undefined)).toEqual(["//:a", "//:b"])
    expect(labelsOf(unit!, new Set(["//:b"]))).toEqual(["//:b"])
  })

  it("leaves out a job with a step that has no target, and every job that needs it", () => {
    const narrowed = inventory([
      job("x", { steps: [step("x1", "true"), step("x2", "true")] }),
      job("after-x", { needs: ["x"] }),
      job("last", { needs: ["after-x", "plain", "gone"] }),
      job("plain"),
      job("m", { matrix: [{ a: "1" }, { a: "2" }] }),
      job("loop", { needs: ["loop"] })
    ])
    const targets = mapAll(narrowed).targets.filter((entry) => entry.step !== "x2" && entry.label !== "//:m1-2")
    const { left, units } = replayable(narrowed, { version: 1, targets }, "linux")
    expect(units.map((unit) => unit.job)).toEqual(["plain", "loop"])
    expect(left).toEqual([
      { job: "x", reasons: [{ feature: "no-target", detail: "x2 has no target" }] },
      { job: "after-x", reasons: [{ feature: "needs", detail: "after-x needs x, which is not replayed" }] },
      { job: "last", reasons: [{ feature: "needs", detail: "last needs after-x, which is not replayed" }] },
      { job: "m", reasons: [{ feature: "no-target", detail: "m1 (a=2) has no target" }] }
    ])
    expect(nothingToReplay(left)).toBe([
      "no CI step that runs on a change has a target on this machine",
      "  x        has a step Smithers CI could not turn into a build step",
      "  after-x  needs x, which is not replayed",
      "  last     needs after-x, which is not replayed",
      "  m        has a step Smithers CI could not turn into a build step"
    ].join("\n"))
    expect(nothingToReplay([])).toBe("no CI step that runs on a change has a target on this machine")
    expect(nothingToReplay([{ job: "gems", reasons: [{ feature: "missing-tool", detail: "ruby 3.4.6" }] }])).toBe(
      "no CI step that runs on a change has a target on this machine\n  gems  needs ruby 3.4.6, which this machine does not have; install it and run smithers-ci again"
    )
  })

  it("leaves out a variant for another system, and a job with no variant for this one", () => {
    const narrowed = inventory([
      job("both", { runsOn: "${{ matrix.os }}", matrix: [{ os: "ubuntu-latest" }, { os: "macos-latest" }] }),
      job("mac", { runsOn: "macos-15" }),
      job("after-mac", { needs: ["mac"] }),
      job("after-both", { needs: ["both"] }),
      job("self", { runsOn: "self-hosted,gpu" }),
      job("windows", { runsOn: "windows-latest" })
    ])
    // The generator makes no target Smithers build would run here for another system; the map may still name one.
    const on = (host: string) => replayable(narrowed, mapAll(narrowed), host)
    expect(on("linux").units.map((unit) => [unit.job, unit.steps[0]!.label])).toEqual([
      ["both", "//:both1-ubuntu-latest"],
      ["after-both", "//:after-both1"]
    ])
    expect(on("linux").left).toEqual([
      {
        job: "both",
        reasons: [{ feature: "other-system", detail: "both (os=macos-latest) runs on darwin; this machine is linux" }]
      },
      { job: "mac", reasons: [{ feature: "other-system", detail: "mac runs on darwin; this machine is linux" }] },
      { job: "after-mac", reasons: [{ feature: "needs", detail: "after-mac needs mac, which is not replayed" }] },
      { job: "self", reasons: [{ feature: "self-hosted", detail: "self runs on a self-hosted runner" }] },
      { job: "windows", reasons: [{ feature: "other-system", detail: "windows runs on win32; this machine is linux" }] }
    ])
    expect(on("darwin").units.map((unit) => unit.job)).toEqual(["both", "mac", "after-mac", "after-both"])
    expect(on("darwin").left.map((entry) => entry.job)).toEqual(["both", "self", "windows"])
    // A variant for another system needs no target to be left out as that, not as `no-target`.
    const none = replayable(narrowed, map([]), "linux")
    expect(none.units).toEqual([])
    expect(none.left.find((entry) => entry.job === "mac")?.reasons[0]?.feature).toBe("other-system")
    expect(none.left.find((entry) => entry.job === "both")?.reasons.map((reason) => reason.feature)).toEqual([
      "no-target"
    ])
  })

  it("leaves out only the self-hosted variant of a job that also runs here", () => {
    const narrowed = inventory([
      job("both", { runsOn: "${{ matrix.os }}", matrix: [{ os: "self-hosted" }, { os: "ubuntu-latest" }] })
    ])
    const { left, units } = replayable(narrowed, mapAll(narrowed), "linux")
    expect(units.map((unit) => unit.steps[0]!.label)).toEqual(["//:both1-ubuntu-latest"])
    expect(left).toEqual([{
      job: "both",
      reasons: [{ feature: "self-hosted", detail: "both (os=self-hosted) runs on a self-hosted runner" }]
    }])
  })

  it("puts the jobs of one Justfile in the order they run, in one tree, after the jobs with a checkout of their own", () => {
    const recipe = (id: string, needs: ReadonlyArray<string> = []) =>
      job(id, { source: "justfile", file: "Justfile", needs: [...needs], triggers: [] })
    const narrowed = inventory([
      recipe("justfile:ci", ["justfile:build", "justfile:test"]),
      recipe("justfile:test", ["justfile:build"]),
      recipe("justfile:build")
    ])
    const units = unitsOf(narrowed)
    expect(units.map((unit) => [unit.job, unit.tree])).toEqual([
      ["justfile:build", "Justfile"],
      ["justfile:test", "Justfile"],
      ["justfile:ci", "Justfile"]
    ])
  })
})

describe("planOfPrinted", () => {
  it("reads the rule and key from what smthrs prints, and leaves a missing key empty", () => {
    const target = { label: "//:a", target: "ToolBuild", cacheable: true, dependencies: ["//:b"] }
    const plan = planOfPrinted({
      verb: "ci",
      pattern: "//:a",
      roots: ["//:a"],
      targets: [{ ...target, keyPreview: "k" }, target]
    })
    expect(plan.targets).toEqual([
      { label: "//:a", rule: "ToolBuild", key: "k", cacheable: true, dependencies: ["//:b"] },
      { label: "//:a", rule: "ToolBuild", key: "", cacheable: true, dependencies: ["//:b"] }
    ])
  })
})

describe("jobsFor", () => {
  it("takes the lower of the request and the target map, whichever are given", () => {
    expect(jobsFor(undefined, undefined)).toBeUndefined()
    expect(jobsFor(4, undefined)).toBe(4)
    expect(jobsFor(undefined, 1)).toBe(1)
    expect(jobsFor(4, 1)).toBe(1)
    expect(jobsFor(1, 4)).toBe(1)
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
    const said = { ...firstAttempt(failed("a")), error: "boom", exitCode: 1, command: "make" }
    expect(addRerun(said, ran("a", 3))).not.toHaveProperty("exitCode")
    expect(addRerun(said, ran("a", 3))).not.toHaveProperty("command")
    expect(addRerun(said, failed("a"))).toMatchObject({ error: "boom", exitCode: 1, command: "make" })
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

  it("names each step that ran and says why it was not reused", () => {
    const names = new Map([
      ["//:b", { step: "test (node 22)\nsecond line", command: "npm test\nnpm run more" }],
      // A name of nothing but space is no name: the label stands.
      ["//:c", { step: " \n", command: "npm run c" }]
    ])
    const totals = totalsOf(
      record([
        // A file it read changed: the result is kept for the next commit.
        { ...ran("//:a"), notReused: "src/a.ts changed" },
        // It reached the network: no result of it is ever kept, whatever else changed.
        { ...ran("//:b"), notReused: "package.json changed", notStored: "it opened a network connection\nmore" },
        { ...failed("//:c"), notStored: "it failed" },
        // A step with no earlier result gives no reason, and a reused or skipped step did not run.
        ran("//:d"),
        { ...ran("//:e"), status: "hit", notReused: "never read" },
        { ...ran("//:f"), status: "skipped", notStored: "never read" }
      ]),
      names
    )
    expect(totals.notReused).toEqual([
      { step: "//:a", reason: "src/a.ts changed", kept: true },
      { step: "test (node 22)", reason: "it opened a network connection", kept: false, command: "npm test" },
      { step: "//:c", reason: "it failed", kept: false, command: "npm run c" }
    ])
    expect(totalsOf(record([ran("//:d")]))).not.toHaveProperty("notReused")
  })

  it("says what a person does about a step that is never kept for want of a lockfile", () => {
    const network = "it opened a network connection (node to 104.16.4.34 port 443)"
    const cargo = "it opened a network connection (cargo to 8.8.8.8 port 53), with no Cargo.lock to say what it fetches"
    const names = new Map([
      ["//:build", { step: "test: cargo build", command: "cargo build --verbose", after: 2 }],
      ["//:install", { step: "test: npm install", command: "npm install --no-audit", after: 1 }],
      ["//:last", { step: "test: npm i", command: "npm i", after: 0 }],
      ["//:add", { step: "test: add", command: "npm install left-pad" }],
      ["//:both", { step: "test: both", command: "npm install && npm test" }],
      ["//:curl", { step: "test: curl", command: "curl https://example.invalid" }],
      ["//:tox", { step: "tests: tox", command: "uvx --with tox-uv tox -e py314", after: 0 }],
      ["//:uvpy", { step: "tests: fetch", command: "uv run python fetch.py", after: 0 }]
    ])
    const uv = "it opened a network connection (uv to 8.8.8.8 port 53)"
    const fixes = (results: ReadonlyArray<TargetResult>) =>
      totalsOf(record(results), names).notReused?.map((entry) => entry.fix)
    expect(
      fixes([
        { ...ran("//:build"), notStored: cargo },
        // The line Smithers build gives for a day after such a run still names the lockfile.
        { ...ran("//:build"), notStored: `${cargo}, when its reads were last recorded` },
        { ...ran("//:install"), notStored: network },
        { ...ran("//:last"), notStored: network },
        // uv resolved what it fetched when it ran: the program the recording names, whatever the command says.
        { ...ran("//:tox"), notStored: uv }
      ])
    ).toEqual([
      "commit Cargo.lock and this step and the 2 after it can be reused",
      "commit Cargo.lock and this step and the 2 after it can be reused",
      "commit package-lock.json, install with `npm ci`, and this step and the 1 after it can be reused",
      "commit package-lock.json, install with `npm ci`, and this step can be reused",
      "commit uv.lock, run it with `uv run --locked`, and this step can be reused"
    ])
    // An install of a package it names, a step that does more than install, another program, a step with no
    // name, and a step whose result is kept: nothing a lockfile mends, so no line says it would.
    expect(
      fixes([
        { ...ran("//:add"), notStored: network },
        { ...ran("//:both"), notStored: network },
        { ...ran("//:curl"), notStored: network },
        { ...ran("//:unnamed"), notStored: network },
        { ...ran("//:install"), notStored: "it changed its root directory" },
        { ...ran("//:build"), notReused: cargo },
        // A step run with uv whose connection another program opened: no lockfile of uv's pins it.
        { ...ran("//:uvpy"), notStored: "it opened a network connection (python3 to 8.8.8.8 port 443)" },
        { ...ran("//:tox"), notReused: uv }
      ])
    ).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined])
  })

  it("sums work and reads wall time from the record", () => {
    expect(totalsOf(record([ran("a", 2), ran("b", 3)]))).toMatchObject({ ok: true, wallMs: 10, workMs: 5 })
    const { durationMs: _durationMs, ...timeless } = record([])
    expect(totalsOf(timeless).wallMs).toBe(0)
  })
})

describe("withoutCredentials", () => {
  it("drops a user name and password, and keeps every other remote as it is", () => {
    expect(withoutCredentials("https://will:ghp_secret@github.com/acme/widgets.git\n")).toBe(
      "https://github.com/acme/widgets.git"
    )
    expect(withoutCredentials("https://token@github.com/acme/widgets")).toBe("https://github.com/acme/widgets")
    expect(withoutCredentials("ssh://git@github.com/acme/widgets.git")).toBe("ssh://github.com/acme/widgets.git")
    expect(withoutCredentials("git@github.com:acme/widgets.git")).toBe("git@github.com:acme/widgets.git")
    expect(withoutCredentials("/srv/git/widgets")).toBe("/srv/git/widgets")
    expect(withoutCredentials("https://github.com/acme/w@x")).toBe("https://github.com/acme/w@x")
  })
})

describe("failureTexts", () => {
  it("gives each failed target the lines Smithers build printed under it", () => {
    const output = [
      "//:a  ran  12ms",
      "//:b  failed  375ms  command failed (exit 2): /bin/sh -c tsc -p .",
      "PACKAGE.ts(3,31): error TS2307: Cannot find module",
      "more",
      "//:c  failed  3ms  command failed (exit 1): sh -c y",
      "//:d  hit  1ms",
      "printed by nothing that failed",
      "//packages/a:e  failed  9ms  command failed (exit 1): sh -c z",
      "last words",
      // A tool target's failure holds the tool's output on the line itself.
      `//:f  failed  2ms  ${JSON.stringify({ _tag: "ExecError", argv: ["x"], stdout: "said\n", stderr: "" })}`,
      `//:g  failed  2ms  ${JSON.stringify({ stderr: "wrong\n" })}`,
      "//:h  failed  2ms  {not a document",
      "//:i  failed",
      "code: targets_failed",
      "message: 7 of 9 targets failed"
    ].join("\n")
    expect([...failureTexts(output)]).toEqual([
      ["//:b", "PACKAGE.ts(3,31): error TS2307: Cannot find module\nmore"],
      ["//:c", ""],
      ["//packages/a:e", "last words"],
      ["//:f", "said"],
      ["//:g", "wrong"],
      ["//:h", ""],
      ["//:i", ""]
    ])
    expect([...failureTexts("")]).toEqual([])
    // Two targets that ran at once: a line one printed while it ran is its own, whichever line it follows.
    const atOnce = [
      "//:b  failed  291ms  {\"stdout\":\"\",\"stderr\":\"\"}",
      "//:a: .smithers/WORKSPACE.smithers:2:19 - Unknown word (smthrs)",
      "//:b: what b printed",
      "after b",
      "//:a  failed  223ms  {\"stdout\":\".smithers/WORKSPACE.smithers:2:19 - Unknown word (smthrs)\\n\"}",
      "//:b: late",
      "code: targets_failed"
    ].join("\n")
    expect([...failureTexts(atOnce)]).toEqual([
      ["//:b", "//:b: what b printed\nafter b"],
      ["//:a", ".smithers/WORKSPACE.smithers:2:19 - Unknown word (smthrs)"]
    ])
  })
})

describe("seenIn", () => {
  const plain = ".smithers/WORKSPACE.smithers"
  const workflow = ".github/workflows/smithers-ci.yml"
  const legs = ".smithers/ci/legs.txt"
  const written = [workflow, plain, legs]

  it("names the tool that read a file Smithers CI wrote, the file, and what to add to its ignore list", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      [
        `${plain}(3,31): error TS2307: Cannot find module '@smthrs/targets'`,
        `tsc read ${plain}, which Smithers CI wrote. Add .smithers to "exclude" in the tsconfig.json it reads.`
      ],
      [
        `/tmp/r/${plain}\n  0:0  error  Parsing error: "parserOptions.project" has been provided\n\n✖ 1 problem (1 error, 0 warnings)`,
        `ESLint read ${plain}, which Smithers CI wrote. Add .smithers to "ignores" in eslint.config.js, or to .eslintignore.`
      ],
      [
        `Checking formatting...\n[warn] ${workflow}\n[warn] Code style issues found in the above file.`,
        `Prettier read ${workflow}, which Smithers CI wrote. Add ${workflow} to .prettierignore.`
      ],
      [
        `${workflow} format ━━━━━━━━━━━━━━\n  × Formatter would have printed the following content:`,
        `Biome read ${workflow}, which Smithers CI wrote. Add "!${workflow}" to "files.includes" in biome.json.`
      ],
      [
        `from /r/${legs}:\nFound 1 not formatted file.`,
        `dprint read ${legs}, which Smithers CI wrote. Add .smithers to "excludes" in dprint.json.`
      ],
      [
        `${plain}:2:19 - Unknown word (smthrs)`,
        `cspell read ${plain}, which Smithers CI wrote. Add .smithers to "ignorePaths" in the cspell configuration.`
      ],
      [
        `Unlisted binaries (1)\nawk  ${workflow}`,
        `knip read ${workflow}, which Smithers CI wrote. Add ${workflow} to "ignore" in the knip configuration.`
      ],
      [
        `Failed to collect coverage from /r/${plain}`,
        `Jest read ${plain}, which Smithers CI wrote. Add .smithers to "coveragePathIgnorePatterns" and "testPathIgnorePatterns" in the Jest configuration.`
      ],
      [
        ` FAIL  ${plain} [ vitest ]`,
        `Vitest read ${plain}, which Smithers CI wrote. Add .smithers to "exclude" in the Vitest configuration.`
      ],
      [
        `mocha: cannot load ${plain}`,
        `Mocha read ${plain}, which Smithers CI wrote. Add .smithers to "ignore" in .mocharc.`
      ],
      [
        `npm notice 1.2kB ${legs}`,
        `npm read ${legs}, which Smithers CI wrote. Add .smithers to .npmignore.`
      ],
      [
        `licence check: no header in ${legs}`,
        `A tool of this repository read ${legs}, which Smithers CI wrote. Add .smithers to that tool's ignore list.`
      ]
    ]
    for (const [error, line] of cases) expect(seenIn(error, written), error).toBe(line)
  })

  it("names a file under a directory Smithers CI fills, and the directory to leave alone", () => {
    const filled = [...written, ".flows/"]
    expect(seenIn("./.flows/cache/ab/k.json format ━━━━━━━━", filled)).toBe(
      `Biome read .flows/cache/ab/k.json, which Smithers CI wrote. Add "!.flows" to "files.includes" in biome.json.`
    )
    expect(seenIn("[warn] .flows/cache/ab/k.json\n[warn] Code style issues found in the above file.", filled)).toBe(
      "Prettier read .flows/cache/ab/k.json, which Smithers CI wrote. Add .flows to .prettierignore."
    )
    // The directory's name inside another name, or alone, is not a file under it.
    expect(seenIn("src/x.flows/a.ts(1,1): error TS1: x", filled)).toBeUndefined()
    expect(seenIn("no .flows/ here", filled)).toBeUndefined()
  })

  it("says nothing for a failure that names no file Smithers CI wrote", () => {
    expect(seenIn(undefined, written)).toBeUndefined()
    expect(seenIn("src/index.ts(1,1): error TS2322: wrong type", written)).toBeUndefined()
    expect(seenIn(`${plain}: error TS1`, [])).toBeUndefined()
  })
})

describe("mismatchesOf", () => {
  it("says why a step failed only beside the files Smithers CI wrote", () => {
    const plain = ".smithers/WORKSPACE.smithers"
    const cause = seenIn(`${plain}:2:19 - Unknown word (smthrs)`, [plain]) as string
    expect(cause).toBe(
      `cspell read ${plain}, which Smithers CI wrote. Add .smithers to "ignorePaths" in the cspell configuration.`
    )
    const one = new Map([["a", cause]])
    // It is still a mismatch.
    expect(mismatchesOf("normal", record([ran("a")]), record([failed("a")]), new Map(), one)).toEqual([
      { label: "a", mode: "normal", baseline: "pass", got: "fail", cause }
    ])
    // A split step: the target that failed says so.
    const split = new Map([["s", ["a-1", "a-2"]]])
    const second = new Map([["a-2", cause]])
    expect(mismatchesOf("fast", record([ran("s")]), record([ran("a-1"), failed("a-2")]), split, second)).toEqual([
      { label: "s", mode: "fast", baseline: "pass", got: "fail", cause }
    ])
    // No line for a target whose output named no such file, and none when the step did not fail in the mode.
    expect(mismatchesOf("normal", record([ran("a")]), record([failed("a")]), new Map(), second)).toEqual([
      { label: "a", mode: "normal", baseline: "pass", got: "fail" }
    ])
    expect(mismatchesOf("normal", record([ran("a")]), record([failed("a")]))).toEqual([
      { label: "a", mode: "normal", baseline: "pass", got: "fail" }
    ])
    expect(mismatchesOf("normal", record([failed("a")]), record([ran("a")]), new Map(), one)).toEqual([
      { label: "a", mode: "normal", baseline: "fail", got: "pass" }
    ])
  })

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

  describe("a step that was split", () => {
    const split = new Map([["s", ["a", "b"]]])
    const mismatch = (baseline: string, got: string) => [{ label: "s", mode: "normal", baseline, got }]

    it("agrees when its targets' combined verdict is the step's", () => {
      expect(mismatchesOf("normal", record([ran("s")]), record([ran("a"), ran("b")]), split)).toEqual([])
      expect(mismatchesOf("normal", record([failed("s")]), record([ran("a"), failed("b")]), split)).toEqual([])
    })

    it("differs when one target fails a step that passed, or every target passes a step that failed", () => {
      expect(mismatchesOf("normal", record([ran("s")]), record([ran("a"), failed("b")]), split)).toEqual(
        mismatch("pass", "fail")
      )
      expect(mismatchesOf("normal", record([failed("s")]), record([ran("a"), ran("b")]), split)).toEqual(
        mismatch("fail", "pass")
      )
    })

    it("differs when the mode never reported one of its targets, whatever the others say", () => {
      expect(mismatchesOf("normal", record([ran("s")]), record([]), split)).toEqual(mismatch("pass", "skipped"))
      expect(mismatchesOf("normal", record([ran("s")]), record([ran("a")]), split)).toEqual(
        mismatch("pass", "skipped")
      )
      expect(mismatchesOf("normal", record([failed("s")]), record([failed("a")]), split)).toEqual(
        mismatch("fail", "skipped")
      )
      // A target that was reported as skipped behind a failure is not missing.
      expect(mismatchesOf("normal", record([failed("s")]), record([failed("a"), blocked("b", "a")]), split)).toEqual([])
    })

    it("forgives predicted-safe skips unless the baseline failed and no target that ran shows it", () => {
      const fast = (baseline: string, got: string) => [{ label: "s", mode: "fast", baseline, got }]
      expect(mismatchesOf("fast", record([ran("s")]), record([ran("a"), predictedSafe("b")]), split)).toEqual([])
      expect(mismatchesOf("fast", record([ran("s")]), record([predictedSafe("a"), predictedSafe("b")]), split))
        .toEqual([])
      expect(mismatchesOf("fast", record([ran("s")]), record([failed("a"), predictedSafe("b")]), split)).toEqual(
        fast("pass", "fail")
      )
      expect(mismatchesOf("fast", record([failed("s")]), record([failed("a"), predictedSafe("b")]), split)).toEqual([])
      expect(mismatchesOf("fast", record([failed("s")]), record([ran("a"), predictedSafe("b")]), split)).toEqual(
        fast("fail", "pass")
      )
      expect(mismatchesOf("fast", record([failed("s")]), record([predictedSafe("a"), predictedSafe("b")]), split))
        .toEqual(fast("fail", "skipped"))
    })
  })

  it("lets pass and flaky agree, in either direction, and counts flaky verdicts apart", () => {
    const flaky = (label: string) => addRerun(firstAttempt(failed(label)), ran(label))
    const hit: TargetResult = { label: "a", status: "hit", key: "k", durationMs: 0 }
    expect(mismatchesOf("normal", record([flaky("a")]), record([ran("a")]))).toEqual([])
    expect(mismatchesOf("normal", record([flaky("a")]), record([hit]))).toEqual([])
    expect(mismatchesOf("normal", record([ran("a")]), record([flaky("a")]))).toEqual([])
    expect(mismatchesOf("normal", record([flaky("a")]), record([flaky("a")]))).toEqual([])
    // Flaky never agrees with a failure or a skip.
    expect(mismatchesOf("normal", record([flaky("a")]), record([failed("a")]))).toEqual([
      { label: "a", mode: "normal", baseline: "flaky", got: "fail" }
    ])
    expect(mismatchesOf("normal", record([failed("a")]), record([flaky("a")]))).toEqual([
      { label: "a", mode: "normal", baseline: "fail", got: "flaky" }
    ])
    expect(mismatchesOf("normal", record([flaky("a")]), record([blocked("a", "b")]))).toEqual([
      { label: "a", mode: "normal", baseline: "flaky", got: "skipped" }
    ])
    expect(mismatchesOf("normal", record([blocked("a", "b")]), record([flaky("a")]))).toEqual([
      { label: "a", mode: "normal", baseline: "skipped", got: "flaky" }
    ])
    // A split step with a flaky target agrees with a step that passed, and with a flaky step.
    const split = new Map([["s", ["a", "b"]]])
    expect(mismatchesOf("normal", record([ran("s")]), record([flaky("a"), ran("b")]), split)).toEqual([])
    expect(mismatchesOf("fast", record([flaky("s")]), record([ran("a"), predictedSafe("b")]), split)).toEqual([])
    expect(flakyOf([record([flaky("a"), ran("b"), failed("c")]), record([flaky("a")]), record([])])).toBe(2)
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
  const read: Inventory = { version: 1, repository: "r", commit: "c", toolchains: [], jobs: [] }
  const nothing = { left: [], flaky: 0 }

  it("divides baseline wall time by normal-mode wall time", () => {
    const report = reportOf(read, [entry, entry], nothing)
    expect(report.notReplayed).toBeUndefined()
    expect(report.notRead).toBeUndefined()
    expect(report).toMatchObject({
      repository: "r",
      baselineWallMs: 60,
      normalWallMs: 20,
      speedup: 3,
      mismatches: 0,
      flaky: 0
    })
    expect(report.fastWallMs).toBeUndefined()
  })

  it("states what failed in a run, under the name the step has", () => {
    const red = recordOf([{ ...failed("//:a"), error: "boom", exitCode: 2 }, ran("//:b")], "c", 4)
    const names = new Map([["//:a", { step: "lint", command: "make lint" }]])
    expect(totalsOf(red, names).failures).toEqual([
      { step: "lint", reason: "boom", exitCode: 2, command: "make lint" }
    ])
    expect(totalsOf(recordOf([ran("//:b")], "c", 4))).not.toHaveProperty("failures")
  })

  it("covers only the commits whose baseline passed, and says how many", () => {
    const failing = { ...entry, baseline: { ...totals(1000), ok: false } }
    const report = reportOf(read, [entry, failing, { ...entry, fast: totals(4) }], nothing)
    expect(report).toMatchObject({ baselineWallMs: 60, normalWallMs: 20, speedup: 3, speedupCommits: 2 })
    expect(reportOf(read, [failing], nothing)).toMatchObject({
      baselineWallMs: 0,
      normalWallMs: 0,
      speedup: 0,
      speedupCommits: 0
    })
  })

  it("has no speedup when normal mode gave another result than the CI at any commit", () => {
    const mismatch = { label: "//:a", mode: "normal", baseline: "pass", got: "fail" } as const
    const differing = { ...entry, normal: { ...totals(1), ok: false }, mismatches: [mismatch] }
    // One mismatch, and no commit is counted: not the one it is at, and not the others.
    expect(reportOf(read, [entry, differing, entry], nothing)).toMatchObject({
      mismatches: 1,
      speedup: 0,
      speedupCommits: 0,
      baselineWallMs: 0,
      normalWallMs: 0
    })
    expect(reportOf(read, [entry, entry], nothing)).toMatchObject({ mismatches: 0, speedup: 3, speedupCommits: 2 })
    // A failure fast mode skipped is its own miss, counted in its recall: normal mode's numbers stand.
    const missed = {
      ...entry,
      mismatches: [{ label: "//:a", mode: "fast", baseline: "fail", got: "skipped" } as const]
    }
    expect(reportOf(read, [entry, missed], nothing)).toMatchObject({ mismatches: 1, speedup: 3, speedupCommits: 2 })
    // A step that fails only once the files `apply` writes are committed says why. Normal mode gave the CI's result
    // on the commit's files, so its numbers stand too.
    const applied = { ...entry, mismatches: [{ ...mismatch, cause: "cspell read a file Smithers CI wrote." }] }
    expect(reportOf(read, [entry, applied], nothing)).toMatchObject({ mismatches: 1, speedup: 3, speedupCommits: 2 })
  })

  it("carries a run's CPU time when it could be read", () => {
    const record = recordOf([ran("//:b")], "c", 4)
    expect(totalsOf(record, new Map(), 250).cpuMs).toBe(250)
    expect(totalsOf(record)).not.toHaveProperty("cpuMs")
  })

  it("say where a run's wall time went, when Smithers build timed its parts", () => {
    // The run's own parts, the replay's checkout before it, and each target's parts, by name; the rest is `rest`.
    const run = withCheckout({ ms: { start: 900, plan: 100 }, cpuMs: { start: 1200, plan: 80 } }, 50)
    expect(run).toEqual({ ms: { checkout: 50, start: 900, plan: 100 }, cpuMs: { start: 1200, plan: 80 } })
    const results: ReadonlyArray<TargetResult> = [
      { ...ran("//:a", 1300), parts: { ms: { step: 1200, reads: 60 }, cpuMs: { step: 1000, reads: 55 } } },
      { ...ran("//:b", 700), parts: { ms: { step: 650 } } },
      ran("//:c", 5)
    ]
    const timed = recordOf(results, "c", 3200, "normal", run)
    expect(timed.parts).toEqual(run)
    expect(totalsOf(timed).parts).toEqual({
      ms: { checkout: 50, start: 900, plan: 100, step: 1850, reads: 60, rest: 240 },
      cpuMs: { start: 1200, plan: 80, step: 1000, reads: 55 }
    })
    // Targets that ran at once add up to more than the time that passed: nothing is left over.
    expect(totalsOf(recordOf(results, "c", 2000, "normal", run)).parts?.ms["rest"]).toBe(0)
    // With no CPU time read anywhere, the totals hold none.
    const wallOnly = recordOf([results[1] as TargetResult], "c", 1000, "normal", { ms: { start: 100 } })
    expect(totalsOf(wallOnly).parts).toEqual({ ms: { start: 100, step: 650, rest: 250 } })
    // A Smithers build that timed nothing leaves nothing to say, whatever the checkout took; so does a baseline.
    expect(withCheckout(undefined, 50)).toBeUndefined()
    expect(totalsOf(recordOf(results, "c", 3200, "normal"))).not.toHaveProperty("parts")
    expect(recordOf(results, "c", 3200, "normal")).not.toHaveProperty("parts")
    // A record with no duration has no time to split.
    const { durationMs: _durationMs, ...timeless } = timed
    expect(totalsOf(timeless).parts?.ms["rest"]).toBe(0)
  })

  it("adds up each way's CPU time over the commits the wall times cover, when each has one", () => {
    const used = (wallMs: number, cpuMs: number) => ({ ...totals(wallMs), cpuMs })
    const counted = { ...entry, baseline: used(30, 100), normal: used(10, 40) }
    const failing = { ...counted, baseline: { ...used(1000, 9000), ok: false } }
    expect(reportOf(read, [counted, failing, counted], nothing)).toMatchObject({ baselineCpuMs: 200, normalCpuMs: 80 })
    // One commit whose processes could not be read in a way takes that way's number away.
    const partly = reportOf(read, [counted, { ...counted, normal: totals(10) }], nothing)
    expect(partly.baselineCpuMs).toBe(200)
    expect(partly).not.toHaveProperty("normalCpuMs")
    // No commit covered, no number.
    expect(reportOf(read, [failing], nothing)).not.toHaveProperty("baselineCpuMs")
    // Fast mode has a number only where it was measured.
    const metrics = selectionOf([], new Map())
    const fast = { ...counted, fast: used(4, 15) }
    expect(reportOf(read, [fast, fast], { ...nothing, selection: metrics }).fastCpuMs).toBe(30)
    expect(reportOf(read, [fast, counted], { ...nothing, selection: metrics })).not.toHaveProperty("fastCpuMs")
    expect(reportOf(read, [fast, fast], nothing)).not.toHaveProperty("fastCpuMs")
  })

  it("says what starting costs when it is more than a twentieth of the CI's time for a commit", () => {
    const timed = (wallMs: number, ms: Record<string, number>) => ({ ...totals(wallMs), parts: { ms } })
    const short = (baselineMs: number, startMs: number, planMs: number) => ({
      ...entry,
      baseline: totals(baselineMs),
      normal: timed(baselineMs + startMs + planMs, { start: startMs, plan: planMs, step: baselineMs })
    })
    // A CI of 6 s for a commit and a start of 3.2 s with its planning: both times, each a mean over the commits.
    expect(reportOf(read, [short(5000, 2500, 500), short(7000, 3000, 400)], nothing).startCost).toEqual({
      commitMs: 6000,
      startMs: 3200
    })
    // A start with no planning timed beside it counts alone.
    expect(startCostOf([{ ...entry, normal: timed(40, { start: 10 }) }])).toEqual({ commitMs: 30, startMs: 10 })
    // A twentieth of the CI's time or less says nothing: 3 s beside a minute, and just over it.
    expect(reportOf(read, [short(60_000, 2500, 500)], nothing)).not.toHaveProperty("startCost")
    expect(startCostOf([short(60_000, 2500, 501)])).toEqual({ commitMs: 60_000, startMs: 3001 })
    // Normal mode as fast as the CI, or faster, has no slowness to account for, however short the CI is.
    const faster = { ...short(5000, 2500, 500), normal: timed(4000, { start: 2500, plan: 500, step: 1000 }) }
    expect(startCostOf([faster])).toBeUndefined()
    expect(startCostOf([{ ...faster, normal: timed(5000, { start: 2500, plan: 500, step: 2000 }) }])).toBeUndefined()
    expect(startCostOf([{ ...faster, normal: timed(5001, { start: 2500, plan: 500, step: 2001 }) }])).toEqual({
      commitMs: 5000,
      startMs: 3000
    })
    // Only the commits the wall times cover count: a failed baseline's time measures nothing.
    const failing = { ...short(100, 3000, 0), baseline: { ...totals(100), ok: false } }
    expect(reportOf(read, [short(60_000, 2500, 500), failing], nothing)).not.toHaveProperty("startCost")
    // No commit, or a commit whose start was not timed, gives no number.
    expect(startCostOf([])).toBeUndefined()
    expect(startCostOf([short(5000, 2500, 500), entry])).toBeUndefined()
    expect(startCostOf([{ ...entry, normal: timed(40, { step: 30 }) }])).toBeUndefined()
  })

  it("is 0 when nothing ran, and sums fast mode when it ran", () => {
    expect(reportOf(read, [], nothing).speedup).toBe(0)
    const metrics = selectionOf([], new Map())
    expect(reportOf(read, [{ ...entry, fast: totals(4) }, entry], { ...nothing, selection: metrics })).toMatchObject({
      fastWallMs: 4,
      selection: metrics
    })
  })

  it("lists the CI jobs that were left out, and counts the flaky verdicts", () => {
    const left = [
      { job: "deploy", reasons: [{ feature: "secret-env", detail: "a" }, { feature: "secret-env", detail: "b" }] },
      { job: "after", reasons: [{ feature: "condition", detail: "c" }, { feature: "needs", detail: "d" }] }
    ]
    expect(reportOf(read, [entry], { left, flaky: 3 })).toMatchObject({ notReplayed: left, flaky: 3 })
  })

  it("lists what the inventory could not read, but not the workspace file it found", () => {
    const unread = { feature: "malformed-file", detail: ".github/workflows/tests.yml: BAD_INDENT at line 3" }
    const own = { feature: "smithers-build", detail: "WORKSPACE.ts" }
    expect(reportOf({ ...read, unsupported: [own, unread] }, [entry], nothing).notRead).toEqual([unread])
    expect(reportOf({ ...read, unsupported: [own] }, [entry], nothing).notRead).toBeUndefined()
  })

  it("lists each tool the machine has at another version than a job asks for", () => {
    const toolVersions = [{ job: "ci.yml:test", tool: "node", asked: "22.x", found: "26.5.0" }]
    expect(reportOf({ ...read, toolVersions }, [entry], nothing).toolVersions).toEqual(toolVersions)
    expect(reportOf(read, [entry], nothing).toolVersions).toBeUndefined()
  })

  it("names the cache credentials a kept job ran without", () => {
    const step = {
      id: "j1",
      command: "true",
      cwd: "",
      env: { TURBO_TOKEN: "" },
      secrets: [],
      withheld: ["TURBO_TOKEN"]
    }
    const kept: Job = {
      id: "j",
      source: "github-actions",
      file: ".github/workflows/ci.yml",
      name: "j",
      needs: [],
      triggers: ["push"],
      matrix: [],
      steps: [step],
      unsupported: []
    }
    expect(reportOf({ ...read, jobs: [kept] }, [entry], nothing).withheld).toEqual(["TURBO_TOKEN"])
    expect(reportOf(read, [entry], nothing).withheld).toBeUndefined()
  })

  it("lists the commits whose own CI could not be replayed", () => {
    const commitsLeft = [{ commit: "0123456789abcdef", reason: "no job runs on a push" }]
    expect(reportOf(read, [entry], { ...nothing, commitsLeft }).notReplayedCommits).toEqual(commitsLeft)
    expect(reportOf(read, [entry], { ...nothing, commitsLeft: [] }).notReplayedCommits).toBeUndefined()
    expect(reportOf(read, [entry], nothing).notReplayedCommits).toBeUndefined()
    expect(reportOf(read, [entry], nothing)).not.toHaveProperty("fastNotMeasured")
    expect(reportOf(read, [entry], { ...nothing, fastNotMeasured: "why" }).fastNotMeasured).toBe("why")
  })
})

describe("withoutFast", () => {
  const totals = { ok: true, wallMs: 1, workMs: 1, counts: { hit: 0, ran: 1, failed: 0, skipped: 0 } }

  it("takes out the commit's fast-mode time and mismatches and keeps the rest", () => {
    const normal = { label: "//:a", mode: "normal", baseline: "pass", got: "fail" } as const
    const fast = { label: "//:b", mode: "fast", baseline: "fail", got: "skipped" } as const
    const commit = {
      commit: "c",
      changedFiles: 1,
      baseline: totals,
      normal: totals,
      mismatches: [normal, fast],
      fast: totals,
      skipped: [{ label: "//:b", skipReason: "predicted-safe" as const, score: 0.01 }],
      model: { ms: 5, questions: 1 }
    }
    expect(withoutFast(commit)).toStrictEqual({
      commit: "c",
      changedFiles: 1,
      baseline: totals,
      normal: totals,
      mismatches: [normal]
    })
  })
})

describe("what failed the first run", () => {
  it("names the commits a job failed at after its reason, each once", () => {
    const entry = { job: "docker", variant: { os: "linux" }, reason: "no docker here" }
    const first = "3f2a1c9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    const newest = "8d1e0b2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    expect(failedAt(entry, [first, newest])).toEqual({ ...entry, reason: "no docker here (at 3f2a1c9 and 8d1e0b2)" })
    expect(failedAt(entry, [first, first]).reason).toBe("no docker here (at 3f2a1c9)")
    expect(failedAt(entry, [first]).reason).toBe("no docker here (at 3f2a1c9)")
  })

  it("counts as failed twice only a result that ran again and failed again", () => {
    const failed = { status: "failed", key: "", durationMs: 1 } as const
    const once = { passed: false, durationMs: 1 }
    const twice = failedTwice([
      { ...failed, label: "//:again", attempts: [once, once] },
      { ...failed, label: "//:once", attempts: [once] },
      // A result no attempt was recorded for was never run again.
      { ...failed, label: "//:unrecorded" },
      { label: "//:flaky", status: "ran", key: "", durationMs: 1, attempts: [once, { passed: true, durationMs: 1 }] }
    ])
    expect([...twice]).toEqual(["//:again"])
  })

  it("names the newest commit as where a job ran once more, unless nothing runs again", () => {
    expect(ranAgainAt(1, "first", "newest")).toBe("newest")
    expect(ranAgainAt(0, "first", "newest")).toBe("first")
  })

  it("says why a replay that was to start warm starts with an empty cache", () => {
    const oldest = "3f2a1c9aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    expect(noCommitBefore(oldest)).toBe("no commit comes before 3f2a1c9 in this repository")
    expect(noCiBefore(oldest)).toBe("the commit before 3f2a1c9 has no CI that runs on this machine")
  })
})

describe("fast mode's run of one commit", () => {
  const normal = [ran("//:a"), ran("//:b"), failed("//:c")]
  const baseline = recordOf(normal, "c", 10)
  const nothing = "Nothing in the features points to a failure."

  it("lists each target it skipped with the model's score and reason, and counts the model's time in the run", () => {
    const scores = [
      { commit: "c", target: "//:a", score: 0.02, reason: nothing },
      { commit: "c", target: "//:b", score: 0.6 },
      { commit: "c", target: "//:c", score: 0.01 }
    ]
    const model = { ms: 40, questions: 2 }
    const run = fastRunOf(normal, [ran("//:b")], "c", 100, baseline, undefined, undefined, undefined, undefined, {
      scores,
      model
    })
    expect(run.part.fast?.wallMs).toBe(140)
    expect(run.part.fast?.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 2 })
    expect(run.part.skipped).toEqual([
      { label: "//:a", skipReason: "predicted-safe", score: 0.02, reason: nothing },
      { label: "//:c", skipReason: "predicted-safe", score: 0.01 }
    ])
    expect(run.part.model).toEqual(model)
  })

  it("lists a skipped target the model gave no score with its label alone", () => {
    const run = fastRunOf(normal, [ran("//:a"), ran("//:b")], "c", 100, baseline, undefined, undefined, undefined, 7, {
      scores: [],
      model: { ms: 0 }
    })
    expect(run.part.skipped).toEqual([{ label: "//:c", skipReason: "predicted-safe" }])
    expect(run.part.model).toEqual({ ms: 0 })
    expect(run.part.fast?.cpuMs).toBe(7)
  })

  it("adds no list and no model time when it is not told what the model said", () => {
    const run = fastRunOf(normal, [ran("//:b")], "c", 100, baseline)
    expect(Object.keys(run.part)).toEqual(["fast"])
    expect(run.part.fast?.wallMs).toBe(100)
  })
})

describe("what asking the model cost over a replay", () => {
  const totals = { ok: true, wallMs: 1, workMs: 1, counts: { hit: 0, ran: 1, failed: 0, skipped: 0 } }
  const commit = { commit: "c", changedFiles: 1, baseline: totals, normal: totals, mismatches: [] }
  const read: Inventory = { version: 1, repository: "r", commit: "c", toolchains: [], jobs: [] }

  it("adds up the time and the questions of every commit the model was asked about", () => {
    const asked = [
      { ...commit, fast: totals, model: { ms: 30, questions: 2 } },
      commit,
      { ...commit, fast: totals, model: { ms: 12, questions: 1 } }
    ]
    expect(modelOf(asked)).toEqual({ ms: 42, questions: 3 })
    expect(modelOf([commit])).toBeUndefined()
    expect(modelOf([])).toBeUndefined()
  })

  it("gives no number of questions when one commit has none", () => {
    expect(modelOf([{ ...commit, model: { ms: 30, questions: 2 } }, { ...commit, model: { ms: 12 } }])).toEqual({
      ms: 42
    })
  })

  it("is in the report when fast mode was measured, over every commit, and in no other report", () => {
    const failing = { ...commit, baseline: { ...totals, ok: false }, fast: totals, model: { ms: 9, questions: 4 } }
    const passing = { ...commit, fast: totals, model: { ms: 30, questions: 2 } }
    const metrics = selectionOf([], new Map())
    expect(reportOf(read, [passing, failing], { left: [], flaky: 0, selection: metrics }).model).toEqual({
      ms: 39,
      questions: 6
    })
    expect(reportOf(read, [passing, failing], { left: [], flaky: 0 })).not.toHaveProperty("model")
    expect(reportOf(read, [commit], { left: [], flaky: 0, selection: metrics })).not.toHaveProperty("model")
  })
})

describe("the report of a replay whose model stopped answering", () => {
  const totals = { ok: true, wallMs: 1, workMs: 1, counts: { hit: 0, ran: 1, failed: 0, skipped: 0 } }
  const commit = { commit: "c", changedFiles: 1, baseline: totals, normal: totals, mismatches: [] }
  const read: Inventory = { version: 1, repository: "r", commit: "c", toolchains: [], jobs: [] }
  const firstRun = { commit: "b", baselineMs: 30, normalMs: 31, fastMs: 32 }
  const gathered = { fastAsked: true, rows: [], selected: new Map(), left: [], flaky: 0, fastFlaky: 0 }

  it("holds no time of fast mode's first run either: part of a measurement is not one", () => {
    const report = finishedReport(read, [{ ...commit, fast: totals, model: { ms: 5 } }], {
      ...gathered,
      fastNotMeasured: "the model could not be reached",
      firstRun
    })
    expect(report.firstRun).toStrictEqual({ commit: "b", baselineMs: 30, normalMs: 31 })
    expect(report).not.toHaveProperty("fastWallMs")
    expect(report).not.toHaveProperty("model")
    expect(report.commits[0]).not.toHaveProperty("fast")
    expect(report.fastNotMeasured).toBe("the model could not be reached")
  })

  it("keeps it when fast mode was measured, and has none to keep when no run came first", () => {
    const measured = { ...gathered, fastNotMeasured: undefined }
    expect(finishedReport(read, [{ ...commit, fast: totals }], { ...measured, firstRun }).firstRun).toEqual(firstRun)
    const lost = { ...gathered, fastNotMeasured: "why" }
    expect(finishedReport(read, [commit], lost)).not.toHaveProperty("firstRun")
  })
})
