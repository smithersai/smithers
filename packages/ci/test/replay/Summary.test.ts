import { describe, expect, it } from "vitest"
import { type Ci, ci, type Inventory, type Job, longRunning } from "../../src/contract/Inventory.ts"
import type { RunRecord, TargetResult } from "../../src/contract/RunRecord.ts"
import type { TargetMap } from "../../src/contract/TargetMap.ts"
import {
  addRerun,
  blocked,
  choose,
  cycleIn,
  excludeLines,
  firstAttempt,
  flakyOf,
  isBlocked,
  jobsFor,
  labelsOf,
  maxReruns,
  mismatchesOf,
  nothingToReplay,
  planOfPrinted,
  predictedSafe,
  recordOf,
  recovered,
  replayable,
  reportOf,
  selectionOf,
  splitOf,
  stationsOf,
  stepKey,
  stepsThrough,
  targetsOf,
  totalsOf,
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
    expect(units[0]?.steps[0]?.command).toBe(
      `__smithers_ci_step() { echo 'big'; bash -e -c "$1"; }\n__smithers_ci_step 'echo big'`
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
      label: "//:s-small",
      targets: ["//:s-small"],
      command: "echo small",
      cwd: "small",
      env: { WHERE: "small" }
    })
    expect(two?.steps[0]).toMatchObject({ label: "//:s-big", targets: ["//:s-big"], command: "echo big" })
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

  it("lists what is untracked in a copy as exclude patterns that match only those paths", () => {
    expect(excludeLines("PACKAGE.ts\0.smithers/\0we[i]rd *?\\name\0")).toBe(
      "/PACKAGE.ts\n/.smithers/\n/we\\[i\\]rd \\*\\?\\\\name\n"
    )
    expect(excludeLines("")).toBe("")
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
      "  x        no-target",
      "  after-x  needs",
      "  last     needs",
      "  m        no-target"
    ].join("\n"))
    expect(nothingToReplay([])).toBe("no CI step that runs on a change has a target on this machine")
    expect(nothingToReplay([{ job: "gems", reasons: [{ feature: "missing-tool", detail: "ruby 3.4.6" }] }])).toBe(
      "no CI step that runs on a change has a target on this machine\n  gems  missing-tool (ruby 3.4.6)"
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
      ["after-both", "//:after-both1"],
      ["self", "//:self1"]
    ])
    expect(on("linux").left).toEqual([
      {
        job: "both",
        reasons: [{ feature: "other-system", detail: "both (os=macos-latest) runs on darwin; this machine is linux" }]
      },
      { job: "mac", reasons: [{ feature: "other-system", detail: "mac runs on darwin; this machine is linux" }] },
      { job: "after-mac", reasons: [{ feature: "needs", detail: "after-mac needs mac, which is not replayed" }] },
      { job: "windows", reasons: [{ feature: "other-system", detail: "windows runs on win32; this machine is linux" }] }
    ])
    expect(on("darwin").units.map((unit) => unit.job)).toEqual(["both", "mac", "after-mac", "after-both", "self"])
    expect(on("darwin").left.map((entry) => entry.job)).toEqual(["both", "windows"])
    // A variant for another system needs no target to be left out as that, not as `no-target`.
    const none = replayable(narrowed, map([]), "linux")
    expect(none.units).toEqual([])
    expect(none.left.find((entry) => entry.job === "mac")?.reasons[0]?.feature).toBe("other-system")
    expect(none.left.find((entry) => entry.job === "both")?.reasons.map((reason) => reason.feature)).toEqual([
      "no-target"
    ])
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
      fast: totals
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
