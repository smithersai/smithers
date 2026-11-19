/**
 * A replay starts warm: before the first counted commit every way runs once at the commit before it, in real
 * repositories, with the real `smthrs`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { failsHere, stateVariable } from "../../src/contract/Inventory.ts"
import type { Failure, ReplayParts, ReplayRequest } from "../../src/contract/Parts.ts"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { Options, Progress, run } from "../../src/replay/index.ts"
import { noCiBefore, noCommitBefore } from "../../src/replay/Summary.ts"
import { text } from "../../src/report/index.ts"
import { inventoryWith, job, linkTargets, makeSmallRepository, smthrs } from "./fixture.ts"
import { unconfined } from "./place.ts"
import { options, parts } from "./TestParts.vibe"

const created: Array<string> = []
const track = (path: string): string => {
  created.push(path)
  return path
}
afterAll(() => {
  for (const path of created) rmSync(path, { recursive: true, force: true })
})

const base = parts("none") as unknown as ReplayParts<never>

const said: Array<string> = []
const listening = Layer.succeed(Progress, { say: (line: string) => Effect.sync(() => void said.push(line)) })

const start = (
  root: string,
  commits: number,
  extra: Partial<ReplayRequest> = {},
  host: Layer.Layer<never> = options as never
) =>
  Effect.runPromise(
    run({ root, commits, modes: ["normal"], warm: true, ...extra }, base).pipe(
      Effect.provide(Layer.provideMerge(Layer.merge(host, listening), NodeServices.layer))
    ) as Effect.Effect<ReplayReport, Failure>
  )

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-c", "user.name=Replay", "-c", "user.email=replay@example.com", ...args], {
    cwd: root,
    encoding: "utf8"
  }).trim()

/** A new commit that writes `files`; gives its id. */
const commit = (root: string, files: Readonly<Record<string, string>>): string => {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content)
  git(root, "add", "-A")
  git(root, "commit", "--quiet", "-m", "another")
  return git(root, "rev-parse", "HEAD")
}

const ciOf = (jobs: ReadonlyArray<unknown>): string => JSON.stringify({ ...inventoryWith("unused"), jobs })

const scratch = (): string => track(mkdtempSync(join(tmpdir(), "replay-warm-")))

/**
 * Three commits of a CI with two jobs, each reading one script: the first, a change to `b.sh`, and a change to
 * the docs alone.
 */
const threeCommits = () => {
  const root = track(makeSmallRepository([job("a", "sh a.sh"), job("b", "sh b.sh")]))
  const first = commit(root, { "b.sh": "exit 0\n" })
  const source = commit(root, { "b.sh": "# changed\nexit 0\n" })
  const docs = commit(root, { "README.md": "# docs\n" })
  return { root, first, source, docs }
}

describe("a replay that starts warm", () => {
  it("counts no commit from an empty cache: each reruns what changed and reuses the rest", async () => {
    const { root, first } = threeCommits()
    const report = await start(root, 2, { trial: true })
    expect(report.commits.map((entry) => entry.normal.counts)).toEqual([
      { hit: 1, ran: 1, failed: 0, skipped: 0 },
      { hit: 2, ran: 0, failed: 0, skipped: 0 }
    ])
    for (const entry of report.commits) {
      expect(entry.baseline.counts).toEqual({ hit: 0, ran: 2, failed: 0, skipped: 0 })
      expect(entry.mismatches).toEqual([])
    }
    expect(report.firstRun?.commit).toBe(first)
    expect(report.firstRun?.baselineMs).toBeGreaterThan(0)
    expect(report.firstRun?.normalMs).toBeGreaterThan(0)
    expect(report.firstRun?.fastMs).toBeUndefined()
    expect(report.cold).toBeUndefined()
    // The baseline's first run is the one that finds what passes here: there is no other.
    expect(report.trialMs).toBeUndefined()
    expect(text(report)).toMatch(
      /^the first run, with an empty cache, took .+ as the baseline and .+ in normal mode; it happens once and is in none of these times$/m
    )
    expect(said).toContain(`first run ${first.slice(0, 7)} baseline`)
    expect(said).toContain(`first run ${first.slice(0, 7)} normal`)
  }, 600_000)

  it("runs fast mode once first too", async () => {
    const { root } = threeCommits()
    const report = await start(root, 2, { modes: ["normal", "fast"] })
    expect(report.firstRun?.fastMs).toBeGreaterThan(0)
    // Fast mode's copy holds what its first run stored: the docs commit runs nothing there.
    expect(report.commits[1]?.fast?.counts.ran).toBe(0)
    expect(text(report)).toMatch(/took .+ as the baseline, .+ in normal mode and .+ in fast mode; it happens once/)
  }, 600_000)

  it("fills the baseline's own home, and a first run that fails is no failure of the replay", async () => {
    // The step fails the first time it runs in a home, and passes there ever after.
    const once = "test -e \"$HOME/seen\" || { touch \"$HOME/seen\"; echo first time >&2; exit 1; }"
    const root = track(makeSmallRepository([job("once", once)]))
    commit(root, { "README.md": "# docs\n" })
    const report = await start(root, 1)
    expect(report.firstRun?.normalMs).toBeGreaterThan(0)
    expect(report.commits[0]?.baseline.ok).toBe(true)
    expect(report.notReplayed).toBeUndefined()
  }, 600_000)
})

describe("a replay asked to count from an empty cache", () => {
  it("runs nothing first, and its first commit runs everything", async () => {
    const { root } = threeCommits()
    const report = await start(root, 2, { warm: false })
    expect(report.commits.map((entry) => entry.normal.counts)).toEqual([
      { hit: 0, ran: 2, failed: 0, skipped: 0 },
      { hit: 2, ran: 0, failed: 0, skipped: 0 }
    ])
    expect(report.firstRun).toBeUndefined()
    expect(report.cold).toBeUndefined()
    expect(text(report)).not.toContain("the first run")
  }, 600_000)
})

describe("a replay with no commit to run first", () => {
  it("starts with an empty cache when its oldest commit is the repository's first, and says so", async () => {
    const root = track(makeSmallRepository([job("a", "sh a.sh")]))
    const oldest = git(root, "rev-parse", "HEAD")
    commit(root, { "README.md": "# docs\n" })
    const report = await start(root, 2)
    expect(report.firstRun).toBeUndefined()
    expect(report.cold).toBe(noCommitBefore(oldest))
    expect(report.commits[0]?.normal.counts.ran).toBe(1)
    expect(text(report)).toContain(
      `started with an empty cache: no commit comes before ${oldest.slice(0, 7)} in this repository`
    )
  }, 600_000)

  it("starts with an empty cache when the commit before has no CI that runs here, and says so", async () => {
    const root = track(makeSmallRepository([job("a", "sh a.sh")]))
    git(root, "rm", "--quiet", "ci.json")
    git(root, "commit", "--quiet", "-m", "no CI")
    const oldest = commit(root, { "ci.json": ciOf([job("a", "sh a.sh")]) })
    const report = await start(root, 1, { trial: true })
    expect(report.firstRun).toBeUndefined()
    expect(report.cold).toBe(noCiBefore(oldest))
    // The run that finds what passes is then the one at the oldest counted commit, in a home of its own.
    expect(report.trialMs).toBeGreaterThan(0)
    expect(report.commits[0]?.normal.counts.ran).toBe(1)
  }, 600_000)
})

describe("the baseline's first run", () => {
  /** A command that fails with `message`, and adds a line to `log` each time it runs. */
  const failing = (log: string, message: string): string => `echo ran >> ${log}; echo '${message}' >&2; exit 1`

  it("leaves out a job that fails it and fails again at the newest commit, and names both commits", async () => {
    const log = join(scratch(), "runs")
    const jobs = [job("ok", "sh a.sh"), job("fine", "sh a.sh"), job("docker", failing(log, "no docker here"))]
    const root = track(makeSmallRepository(jobs))
    const before = git(root, "rev-parse", "HEAD")
    commit(root, { "a.sh": "# changed\nexit 0\n" })
    const newest = commit(root, { "README.md": "# docs\n" })
    const report = await start(root, 2, { trial: true })
    const at = `(at ${before.slice(0, 7)} and ${newest.slice(0, 7)})`
    expect(report.notReplayed).toEqual([
      { job: "docker", reasons: [{ feature: failsHere, detail: `docker0: exit 1: no docker here ${at}` }] }
    ])
    expect(report.jobs).toEqual({ replayed: 2, total: 3 })
    expect(report.commits.map((entry) => entry.baseline.counts)).toEqual([
      { hit: 0, ran: 2, failed: 0, skipped: 0 },
      { hit: 0, ran: 2, failed: 0, skipped: 0 }
    ])
    // The modes' first runs left it out too: it ran in the baseline's first run, once more, and never again.
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2)
    expect(said).toContain(`fails here: docker: docker0: exit 1: no docker here ${at}`)
  }, 600_000)

  it("keeps a job that was broken at the commit before and is fixed since", async () => {
    const root = track(makeSmallRepository([job("a", "sh a.sh")]))
    commit(root, { "a.sh": "echo broken then >&2\nexit 1\n" })
    commit(root, { "a.sh": "exit 0\n" })
    const report = await start(root, 1, { trial: true })
    expect(report.notReplayed).toBeUndefined()
    expect(report.jobs).toEqual({ replayed: 1, total: 1 })
    expect(report.commits[0]?.baseline.ok).toBe(true)
    expect(report.speedupCommits).toBe(1)
  }, 600_000)

  it("leaves a job added since to its own commits, when nothing else of the commit before can pass", async () => {
    const bad = job("bad", "echo broken >&2; exit 1")
    const root = track(makeSmallRepository([bad]))
    commit(root, { "ci.json": ciOf([bad, job("ok", "sh a.sh"), job("fine", "sh a.sh")]) })
    const report = await start(root, 1, { trial: true })
    expect(report.notReplayed?.map((entry) => entry.job)).toEqual(["bad"])
    // Nothing of the commit before is left for the modes to run first.
    expect(report.firstRun?.baselineMs).toBeGreaterThan(0)
    expect(report.firstRun?.normalMs).toBeUndefined()
    expect(report.commits[0]?.baseline.counts).toEqual({ hit: 0, ran: 2, failed: 0, skipped: 0 })
    expect(report.commits[0]?.normal.ok).toBe(true)
  }, 600_000)
})

describe("a mode's first run that cannot finish", () => {
  it("has no time, and the replay goes on", async () => {
    let prepared = 0
    const failingOnce = Layer.succeed(Options, {
      smthrs: [smthrs] as const,
      reruns: 1,
      confine: unconfined,
      prepare: (directory: string) => {
        prepared += 1
        return prepared === 1
          ? Effect.fail({ code: "command-failed", message: "no link\nnor anything else", part: "replay" } as const)
          : Effect.sync(() => linkTargets(directory))
      }
    })
    const { root } = threeCommits()
    const report = await start(root, 2, {}, failingOnce as never)
    expect(report.firstRun?.baselineMs).toBeGreaterThan(0)
    expect(report.firstRun?.normalMs).toBeUndefined()
    expect(said).toContain("the first run in normal mode did not finish: no link")
    // Nothing was filled, so the first counted commit runs everything.
    expect(report.commits[0]?.normal.counts.ran).toBe(2)
    expect(text(report)).toMatch(/^the first run, with an empty cache, took [^,]+ as the baseline; it happens once/m)
  }, 600_000)
})

describe("the run that only finds what passes here", () => {
  it("is at the oldest commit that has a CI, and keeps its saved files to itself", async () => {
    // The step passes once for each store: a store another run saved into fails it.
    const store = `d="\${${stateVariable}:-.flows}"; test ! -e "$d/seen" && touch "$d/seen"`
    const root = track(makeSmallRepository([job("a", "sh a.sh")]))
    git(root, "rm", "--quiet", "ci.json")
    git(root, "commit", "--quiet", "-m", "no CI")
    const oldest = commit(root, { "ci.json": ciOf([job("saves", store)]) })
    const report = await start(root, 2, { warm: false, trial: true })
    expect(said).toContain(`checking which jobs pass on this machine at ${oldest.slice(0, 7)}`)
    expect(report.notReplayed).toBeUndefined()
    expect(report.commits).toHaveLength(1)
    expect(report.commits[0]?.baseline.ok).toBe(true)
  }, 600_000)
})
