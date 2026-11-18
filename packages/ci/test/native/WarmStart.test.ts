/**
 * A replay of a repository's own targets starts warm: before the first counted commit every way runs once at the
 * commit before it, in real repositories, with the real `smthrs`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { failsHere } from "../../src/contract/Inventory.ts"
import type { Failure, ReplayParts, ReplayRequest } from "../../src/contract/Parts.ts"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { read } from "../../src/inventory/index.ts"
import { type Host, own } from "../../src/native/index.ts"
import { Options, Progress } from "../../src/replay/index.ts"
import { noCiBefore, noCommitBefore } from "../../src/replay/Summary.ts"
import { text } from "../../src/report/index.ts"
import { unconfined } from "../replay/place.ts"
import { brokenInstall, installScript, ownFiles, smthrs } from "./own.ts"
import { commit, git, repository } from "./repo.ts"
import { rows, scoreKeeping } from "./support.vibe"

const made: Array<string> = []
const keep = (root: string): string => {
  made.push(root)
  return root
}
afterAll(() => made.forEach((root) => rmSync(root, { recursive: true, force: true })))

const parts: ReplayParts<Host> = {
  read,
  files: () => Effect.fail({ code: "invalid-document", message: "nothing may be generated", part: "generate" }),
  rows,
  score: scoreKeeping("//:c", "none")
}

const said: Array<string> = []
const host = Layer.mergeAll(
  Layer.succeed(Options, { smthrs: ["never-used"], reruns: 1, prepare: () => Effect.void, confine: unconfined }),
  Layer.succeed(Progress, { say: (line: string) => Effect.sync(() => void said.push(line)) })
)

const replay = (
  root: string,
  commits: number,
  extra: Partial<ReplayRequest> = {},
  given: ReplayParts<Host> = parts
): Promise<ReplayReport> =>
  Effect.runPromise(
    own({ root, commits, modes: ["normal"], warm: true, ...extra }, given, "WORKSPACE.ts").pipe(
      Effect.provide(Layer.provideMerge(host, NodeServices.layer))
    ) as Effect.Effect<ReplayReport, Failure>
  )

const short = (root: string, revision: string): string => git(root, "rev-parse", revision).trim().slice(0, 7)

const broken = "echo broken >&2\nexit 1\n"

/** Three commits: the first; a change to `c.sh`, which no other target reads; a change to the docs alone. */
const threeCommits = (first: Readonly<Record<string, string>> = {}): string => {
  const root = keep(repository({ ...ownFiles(), ...first }))
  commit(root, "change c", { "c.sh": "# changed\nexit 0\n" })
  commit(root, "docs", { "README.md": "# docs\n" })
  return root
}

describe("a replay of own targets that starts warm", { timeout: 900_000 }, () => {
  it("counts no commit from an empty cache: each reruns what changed and reuses the rest", async () => {
    const root = threeCommits()
    const report = await replay(root, 2, { trial: true })
    expect(report.commits.map((entry) => entry.normal.counts)).toEqual([
      { hit: 2, ran: 1, failed: 0, skipped: 0 },
      { hit: 3, ran: 0, failed: 0, skipped: 0 }
    ])
    for (const entry of report.commits) {
      expect(entry.baseline.counts).toEqual({ hit: 0, ran: 3, failed: 0, skipped: 0 })
      expect(entry.mismatches).toEqual([])
    }
    expect(report.firstRun?.commit).toBe(git(root, "rev-parse", "HEAD~2").trim())
    expect(report.firstRun?.baselineMs).toBeGreaterThan(0)
    expect(report.firstRun?.normalMs).toBeGreaterThan(0)
    expect(report.firstRun?.fastMs).toBeUndefined()
    expect(report.cold).toBeUndefined()
    // The baseline's first run is the one that finds what passes here: there is no other.
    expect(report.trialMs).toBeUndefined()
    expect(report.jobs).toEqual({ replayed: 3, total: 3 })
    // The install and the run of each way were read while they ran.
    expect(report.baselineCpuMs).toBeGreaterThan(0)
    expect(report.normalCpuMs).toBeGreaterThan(0)
    expect(text(report)).toMatch(
      /^the first run, with an empty cache, took .+ as the baseline and .+ in normal mode; it happens once and is in none of these times$/m
    )
    expect(said).toContain(`first run ${short(root, "HEAD~2")} baseline`)
    expect(said).toContain(`first run ${short(root, "HEAD~2")} normal`)
  })

  it("runs fast mode once first too", async () => {
    const report = await replay(threeCommits(), 2, { modes: ["normal", "fast"] })
    expect(report.firstRun?.fastMs).toBeGreaterThan(0)
    // Fast mode's copy holds what its first run stored: the docs commit runs nothing there.
    expect(report.commits[1]?.fast?.counts.ran).toBe(0)
  })
})

describe("a replay of own targets asked to count from an empty cache", { timeout: 900_000 }, () => {
  it("runs nothing first, and its first commit runs everything", async () => {
    const report = await replay(threeCommits(), 2, { warm: false })
    expect(report.commits.map((entry) => entry.normal.counts)).toEqual([
      { hit: 0, ran: 3, failed: 0, skipped: 0 },
      { hit: 3, ran: 0, failed: 0, skipped: 0 }
    ])
    expect(report.firstRun).toBeUndefined()
    expect(report.cold).toBeUndefined()
  })
})

describe("a replay of own targets with no commit to run first", { timeout: 900_000 }, () => {
  it("starts with an empty cache when its oldest commit is the repository's first, and says so", async () => {
    const root = keep(repository(ownFiles()))
    const oldest = git(root, "rev-parse", "HEAD").trim()
    commit(root, "docs", { "README.md": "# docs\n" })
    const report = await replay(root, 2)
    expect(report.firstRun).toBeUndefined()
    expect(report.cold).toBe(noCommitBefore(oldest))
    expect(report.commits[0]?.normal.counts.ran).toBe(3)
  })

  it("starts with an empty cache when the CI of the commit before cannot be read, and says so", async () => {
    const root = keep(repository({ ...ownFiles(), "old.sh": "exit 0\n" }))
    git(root, "rm", "--quiet", "old.sh")
    const oldest = commit(root, "remove old.sh", { "README.md": "# docs\n" })
    const refusing: ReplayParts<Host> = {
      ...parts,
      read: (at) =>
        existsSync(join(at, "old.sh"))
          ? Effect.fail({ code: "invalid-document", message: "the workflow does not parse", part: "inventory" })
          : read(at)
    }
    const report = await replay(root, 1, { trial: true }, refusing)
    expect(report.firstRun).toBeUndefined()
    expect(report.cold).toBe(noCiBefore(oldest))
    // The run that finds what passes is then at the oldest counted commit, in a copy of its own.
    expect(report.trialMs).toBeGreaterThan(0)
    expect(report.commits[0]?.normal.counts.ran).toBe(3)
  })
})

describe("the first run of the baseline of own targets", { timeout: 900_000 }, () => {
  it("leaves out a target that fails it and fails again at the newest commit, and names both commits", async () => {
    const root = threeCommits({ "a.sh": broken })
    const report = await replay(root, 2, { trial: true })
    const at = `(at ${short(root, "HEAD~2")} and ${short(root, "HEAD")})`
    expect(report.notReplayed).toEqual(expect.arrayContaining([
      { job: "//:a", reasons: [{ feature: failsHere, detail: `broken ${at}` }] }
    ]))
    expect(report.jobs).toEqual({ replayed: 1, total: 3 })
    // The modes' first runs left it out too, so the first counted commit reruns only what changed.
    expect(report.commits.map((entry) => entry.normal.counts)).toEqual([
      { hit: 0, ran: 1, failed: 0, skipped: 0 },
      { hit: 1, ran: 0, failed: 0, skipped: 0 }
    ])
    expect(said).toContain(`fails here: //:a: broken ${at}`)
  })

  it("keeps a target that was broken at the commit before and is fixed since", async () => {
    const root = keep(repository({ ...ownFiles(), "c.sh": broken }))
    commit(root, "fix c", { "c.sh": "exit 0\n" })
    const report = await replay(root, 1, { trial: true })
    expect(report.notReplayed?.filter((entry) => entry.reasons.some((reason) => reason.feature === failsHere)))
      .toEqual([])
    expect(report.jobs).toEqual({ replayed: 3, total: 3 })
    expect(report.commits[0]?.baseline.ok).toBe(true)
  })

  it("judges at the newest commit when the commit before cannot be installed", async () => {
    const root = keep(repository({ ...ownFiles(), "tools/install.mjs": brokenInstall, "c.sh": broken }))
    commit(root, "fix the install", { "tools/install.mjs": installScript(smthrs) })
    const report = await replay(root, 1, { trial: true })
    expect(report.notReplayed).toEqual(expect.arrayContaining([
      { job: "//:c", reasons: [{ feature: failsHere, detail: `broken (at ${short(root, "HEAD")})` }] }
    ]))
    expect(report.jobs).toEqual({ replayed: 2, total: 3 })
    expect(report.firstRun?.baselineMs).toBeGreaterThanOrEqual(0)
    expect(report.commits[0]?.baseline.counts).toEqual({ hit: 0, ran: 2, failed: 0, skipped: 0 })
  })
})

describe("the run that only finds which own targets pass here", { timeout: 900_000 }, () => {
  it("is at the oldest commit whose CI can be read", async () => {
    const root = keep(repository({ ...ownFiles(), "old.sh": "exit 0\n" }))
    git(root, "rm", "--quiet", "old.sh")
    const second = commit(root, "remove old.sh", { "README.md": "# docs\n" })
    commit(root, "docs", { "README.md": "# more docs\n" })
    const refusing: ReplayParts<Host> = {
      ...parts,
      read: (at) =>
        existsSync(join(at, "old.sh"))
          ? Effect.fail({ code: "invalid-document", message: "the workflow does not parse", part: "inventory" })
          : read(at)
    }
    const report = await replay(root, 3, { warm: false, trial: true }, refusing)
    expect(said).toContain(`checking which targets pass on this machine at ${second.slice(0, 7)}`)
    expect(report.notReplayedCommits).toHaveLength(1)
    expect(report.commits).toHaveLength(2)
  })
})
