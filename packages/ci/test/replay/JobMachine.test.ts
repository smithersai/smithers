/**
 * A job is a machine: each job of each commit starts with a checkout, a home
 * and a temporary directory nothing else wrote to, as each job of a workflow
 * starts on a runner of its own. Real repositories, real `git`, real `smthrs`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Failure, ReplayParts } from "../../src/contract/Parts.vibe"
import type { ReplayReport } from "../../src/contract/ReplayReport.vibe"
import type { Mode } from "../../src/contract/RunRecord.vibe"
import { files } from "../../src/generate/index.vibe"
import { Options, run } from "../../src/replay/index.vibe"
import { type Probe, probe } from "../../src/replay/Jail.ts"
import { inventoryWith, job, linkTargets, smthrs } from "./fixture.ts"
import { unconfined } from "./place.ts"
import { parts } from "./TestParts.vibe"

const created: Array<string> = []
afterAll(() => {
  for (const root of created) rmSync(root, { recursive: true, force: true })
})

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-c", "user.name=Replay", "-c", "user.email=replay@example.com", "-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim()

type Jobs = ReadonlyArray<ReturnType<typeof job>>

/** A repository whose CI is `jobs`, with one commit per entry of `commits`, each writing its files. */
const repository = (jobs: Jobs, commits: ReadonlyArray<Readonly<Record<string, string>>>): string => {
  // A jailed step has a `/tmp` of its own, so the repository is kept beside it.
  const root = realpathSync(mkdtempSync(join("/var/tmp", "replay-job-machine-")))
  created.push(root)
  git(root, "init", "--quiet", "--initial-branch=main")
  writeFileSync(join(root, ".gitignore"), "node_modules\n.flows\n")
  writeFileSync(join(root, "ci.json"), JSON.stringify({ ...inventoryWith(join(root, "unused")), jobs }))
  for (const [index, written] of commits.entries()) {
    for (const [name, content] of Object.entries(written)) writeFileSync(join(root, name), content)
    git(root, "add", "-A")
    git(root, "commit", "--quiet", "-m", `commit ${index + 1}`)
  }
  return root
}

/** Fast mode judges every target worth running, so fast mode runs each step too. */
const runningAll: ReplayParts<never> = {
  ...(parts("none") as unknown as ReplayParts<never>),
  score: (rows) => Effect.succeed(rows.map((row) => ({ commit: row.commit, target: row.target, score: 1 })))
}

/** The real generator in place of the test one: its targets are the ones `smithers-ci` runs. */
const generating: ReplayParts<never> = { ...runningAll, files } as unknown as ReplayParts<never>

const replay = (
  root: string,
  commits: number,
  confined: () => Probe,
  modes: ReadonlyArray<Mode> = ["normal"],
  chosen: ReplayParts<never> = runningAll
): Promise<ReplayReport> =>
  Effect.runPromise(
    run({ root, commits, modes }, chosen).pipe(
      Effect.provide(Layer.provideMerge(
        Layer.succeed(Options, {
          smthrs: [smthrs],
          reruns: 0,
          prepare: (checkout) => Effect.sync(() => linkTargets(checkout)),
          confine: confined
        }) as never,
        NodeServices.layer
      ))
    ) as Effect.Effect<ReplayReport, Failure>
  )

const two = [{ "docs.md": "one\n" }, { "docs.md": "two\n" }]
// This machine's jail, asked once: a replay given the answer jails its steps whatever variables it is started with.
const found = probe()
const jailable = !("refusal" in found)
const jailed = (): Probe => found

describe("a baseline job", () => {
  it("starts with a home no other job and no earlier commit wrote to, on a machine with no jail", async () => {
    // The second review's blocker 4: `mkdir ~/x` with no `-p` passes on every runner, and failed from the second
    // job on, because one home was kept for the whole replay.
    const root = repository([
      job("homea", "test ! -e ~/.seen && touch ~/.seen"),
      job("homeb", "test ! -e ~/.seen && touch ~/.seen # b"),
      // The steps of one job share the job's home, in order.
      job("steps", "touch ~/.first", { more: ["test -e ~/.first && test ! -e ~/.seen"] })
    ], two)
    const report = await replay(root, 2, unconfined)
    const counts = { hit: 0, ran: 4, failed: 0, skipped: 0 }
    expect(report.commits.map((commit) => commit.baseline.counts)).toEqual([counts, counts])
  }, 600_000)

  it("is told a temporary directory of its own where no jail stands behind the machine's", async () => {
    // On macOS, and on Linux without bubblewrap, every baseline job was given the person's own TMPDIR: a job found
    // there what the job before it left, and failed where the same job passes as a target, which has its own.
    const root = repository([
      job("tmpa", "test ! -e \"$TMPDIR/seen\" && touch \"$TMPDIR/seen\""),
      job("tmpb", "test ! -e \"$TMPDIR/seen\" && touch \"$TMPDIR/seen\" # b"),
      // The steps of one job share the job's temporary directory, in order.
      job("steps", "touch \"$TMPDIR/first\"", { more: ["test -e \"$TMPDIR/first\" && test ! -e \"$TMPDIR/seen\""] })
    ], two)
    const report = await replay(root, 2, unconfined)
    const counts = { hit: 0, ran: 4, failed: 0, skipped: 0 }
    expect(report.commits.map((commit) => commit.baseline.failures ?? [])).toEqual([[], []])
    expect(report.commits.map((commit) => commit.baseline.counts)).toEqual([counts, counts])
  }, 600_000)

  it.skipIf(!jailable)("starts with a temporary directory of its own too, in the jail", async () => {
    const root = repository([
      job("tmpa", "test ! -e /tmp/seen && touch /tmp/seen && test ! -e ~/.seen && touch ~/.seen"),
      job("tmpb", "test ! -e /tmp/seen && touch /tmp/seen && test ! -e ~/.seen && touch ~/.seen # b"),
      job("steps", "touch /tmp/first", { more: ["test -e /tmp/first && test ! -e /tmp/seen"] })
    ], two)
    const report = await replay(root, 2, jailed)
    const counts = { hit: 0, ran: 4, failed: 0, skipped: 0 }
    expect(report.commits.map((commit) => commit.baseline.failures ?? [])).toEqual([[], []])
    expect(report.commits.map((commit) => commit.baseline.counts)).toEqual([counts, counts])
  }, 600_000)
})

describe("a mode", () => {
  /** A step that passes only in a home, and with `tmp` a temporary directory, nothing wrote to. Each commit changes it, so it runs. */
  const fresh = (tmp: boolean, note: string): string =>
    `test ! -e ~/.seen && touch ~/.seen${tmp ? " && test ! -e /tmp/seen && touch /tmp/seen" : ""}\n# ${note}\n`
  const once = { hit: 0, ran: 1, failed: 0, skipped: 0 }

  it("starts every commit with an empty home, as a CI run does, on a machine with no jail", async () => {
    const root = repository([job("seen", "sh seen.sh")], [{ "seen.sh": fresh(false, "one") }, {
      "seen.sh": fresh(false, "two")
    }])
    const report = await replay(root, 2, unconfined, ["normal", "fast"])
    expect(report.commits.map((commit) => [commit.normal.counts, commit.fast?.counts])).toEqual([[once, once], [
      once,
      once
    ]])
    expect(report.commits.flatMap((commit) => commit.mismatches)).toEqual([])
  }, 600_000)

  it.skipIf(!jailable)("starts every commit with an empty temporary directory too, in the jail", async () => {
    const root = repository([job("seen", "sh seen.sh")], [{ "seen.sh": fresh(true, "one") }, {
      "seen.sh": fresh(true, "two")
    }])
    const report = await replay(root, 2, jailed, ["normal", "fast"])
    expect(report.commits.map((commit) => [commit.normal.counts, commit.fast?.counts])).toEqual([[once, once], [
      once,
      once
    ]])
    expect(report.commits.flatMap((commit) => commit.mismatches)).toEqual([])
  }, 600_000)
})

describe("the jobs of a workflow, as the targets the generator writes", () => {
  // The second ship review's blockers 2 and 4. On GitHub each of these jobs passes at every commit, on a runner of
  // its own. In one tree with one home, `pristine`, `flagabsent` and one of the two `home` jobs failed.
  const jobs = [
    job("mutate", "echo bad > shared.txt"),
    job("pristine", "grep -q ok shared.txt"),
    job("flagwrite", "touch leftover.flag"),
    job("flagabsent", "test ! -e leftover.flag"),
    job("homea", "test ! -e ~/.seen && touch ~/.seen"),
    job("homeb", "test ! -e ~/.seen && touch ~/.seen # b"),
    // The steps of one job share its checkout and its home, in order.
    job("steps", "echo built > out.txt && echo tool > ~/.tool", {
      more: ["grep -q built out.txt && grep -q tool ~/.tool"]
    })
  ]
  const commits = [{ "shared.txt": "ok\n", "docs.md": "one\n" }, { "docs.md": "two\n" }]
  const steps = 8

  for (
    const { where, asked, runs } of [
      { where: "in the jail", asked: jailed, runs: jailable },
      { where: "on a machine with no jail", asked: unconfined, runs: true }
    ]
  ) {
    it.skipIf(!runs)(`never see what another job wrote, in normal mode and in fast mode, ${where}`, async () => {
      const report = await replay(repository(jobs, commits), 2, asked, ["normal", "fast"], generating)
      expect(report.commits).toHaveLength(2)
      for (const commit of report.commits) {
        expect(commit.baseline.counts).toEqual({ hit: 0, ran: steps, failed: 0, skipped: 0 })
        for (const totals of [commit.normal, commit.fast]) {
          expect(totals?.failures ?? []).toEqual([])
          expect([(totals?.counts.hit ?? 0) + (totals?.counts.ran ?? 0), totals?.counts.failed, totals?.counts.skipped])
            .toEqual([steps, 0, 0])
        }
        expect(commit.mismatches).toEqual([])
      }
    }, 900_000)
  }
})

describe("a job's machine", () => {
  // The third ship review's blocker 6: pre-commit keeps absolute paths of its home in what `actions/cache` saves.
  // A runner gives a job the same paths at every run, so the baseline and each mode must too. Each job fails with
  // one of its paths as its error, which a report keeps.
  const shown = { home: "$HOME", work: "$PWD", temp: "$TMPDIR" }
  const jobs = Object.entries(shown).map(([name, value]) => job(name, `echo "${value}" >&2; exit 1`))
  const ends = { home: "home", work: "w/[^/]+", temp: "tmp" }
  for (
    const { place, asked, runs } of [
      { place: "in the jail", asked: jailed, runs: jailable },
      { place: "on a machine with no jail", asked: unconfined, runs: true }
    ]
  ) {
    it.skipIf(!runs)(
      `keeps stable job paths at every commit and isolates the baseline backing directory, ${place}`,
      async () => {
        const report = await replay(
          repository([...jobs, job("passes", "true")], two),
          2,
          asked,
          ["normal", "fast"],
          generating
        )
        for (const [name, end] of Object.entries(ends)) {
          const paths = report.commits.map((commit) =>
            [commit.baseline, commit.normal, commit.fast].map((totals) =>
              totals?.failures?.find((failure) => failure.step.startsWith(name))?.reason
            )
          )
          expect(paths[1]).toEqual(paths[0])
          const [baseline, normal, fast] = paths[0]!
          expect(baseline).toMatch(new RegExp(`^/\\S+/baseline-machines/[0-9a-f]{16}/${name}-[0-9a-f]{8}/${end}$`))
          expect(normal).toBe(asked === jailed ? baseline : baseline!.replace("/baseline-machines/", "/machines/"))
          expect(fast).toBe(normal)
        }
      },
      900_000
    )
  }
})
