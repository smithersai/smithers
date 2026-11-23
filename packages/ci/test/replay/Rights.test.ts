/**
 * A job with a step that starts a program whose file asks for rights is left out, from the commit whose run found
 * it on.
 *
 * In a replay's jail such a program gets none of the rights it asks for (set-user-id, set-group-id or a file
 * capability), and `smthrs` names it in its results file (`TargetResult.rights`). Here the real `smthrs` runs the
 * targets of real repositories, behind a script that then names in that file the programs the test lists for a
 * target, as `smthrs` names `/usr/bin/ping`. `test/cli/rights.test.ts` runs the real `ping`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { execFileSync } from "node:child_process"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { failsHere } from "../../src/contract/Inventory.vibe"
import type { Failure, ReplayParts, ReplayRequest } from "../../src/contract/Parts.vibe"
import type { ReplayCommit, ReplayReport, RunTotals } from "../../src/contract/ReplayReport.vibe"
import type { TargetResult } from "../../src/contract/RunRecord.vibe"
import { Options, Progress, run } from "../../src/replay/index.vibe"
import { leftForRights, rightsOf, rightsTaken, type Unit, type UnitStep } from "../../src/replay/Summary.vibe"
import { inventoryWith, job, linkTargets, smthrs } from "./fixture.ts"
import { unconfined } from "./place.ts"
import { parts } from "./TestParts.vibe"

const created: Array<string> = []
const track = (path: string): string => {
  created.push(path)
  return path
}
afterAll(() => {
  for (const path of created) rmSync(path, { recursive: true, force: true })
})

const ping = "runs `ping`, which needs rights this machine's jail takes away"

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-c", "user.name=Replay", "-c", "user.email=replay@example.com", ...args], {
    cwd: root,
    encoding: "utf8"
  }).trim()

interface Commit {
  readonly jobs: ReadonlyArray<unknown>
  readonly files: Readonly<Record<string, string>>
}

/** A repository with one commit for each of `commits`: its CI, and the files it writes. Gives the commits, oldest first. */
const repository = (commits: ReadonlyArray<Commit>) => {
  const root = track(mkdtempSync(join(tmpdir(), "replay-rights-")))
  git(root, "init", "--quiet", "--initial-branch=main")
  writeFileSync(join(root, ".gitignore"), "node_modules\n.flows\n")
  for (const [index, { jobs, files }] of commits.entries()) {
    writeFileSync(join(root, "ci.json"), JSON.stringify({ ...inventoryWith(join(root, "unused")), jobs }))
    for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content)
    git(root, "add", "-A")
    git(root, "commit", "--quiet", "-m", `commit ${index + 1}`)
  }
  return { root, commits: git(root, "rev-list", "--reverse", "HEAD").split("\n") }
}

/**
 * The real `smthrs`, after which the results file it wrote names, for each target `rights` lists, those programs:
 * what `smthrs` writes for a target that started them in a jail.
 */
const naming = (rights: Readonly<Record<string, ReadonlyArray<string>>>): string => {
  const directory = track(mkdtempSync(join(tmpdir(), "replay-rights-smthrs-")))
  const listed = join(directory, "rights.json")
  writeFileSync(listed, JSON.stringify(rights))
  const stamp = join(directory, "stamp.mjs")
  writeFileSync(
    stamp,
    [
      "import { readFileSync, writeFileSync } from \"node:fs\"",
      "const [file, listed] = process.argv.slice(2)",
      "const rights = JSON.parse(readFileSync(listed, \"utf8\"))",
      "const record = JSON.parse(readFileSync(file, \"utf8\"))",
      "for (const result of record.results) if (rights[result.label]) result.rights = rights[result.label]",
      "writeFileSync(file, JSON.stringify(record))",
      ""
    ].join("\n")
  )
  const command = join(directory, "smthrs")
  writeFileSync(
    command,
    [
      "#!/bin/sh",
      "file=''",
      "previous=''",
      "for word in \"$@\"; do if [ \"$previous\" = --results-file ]; then file=$word; fi; previous=$word; done",
      `${smthrs} "$@"`,
      "code=$?",
      `if [ -n "$file" ] && [ -f "$file" ]; then ${process.execPath} ${stamp} "$file" ${listed} || exit 1; fi`,
      "exit $code",
      ""
    ].join("\n")
  )
  chmodSync(command, 0o755)
  return command
}

/** Fast mode runs every target: the model gives each a chance of failure of 1. */
const running = {
  ...parts("none"),
  score: (rows: ReadonlyArray<{ readonly commit: string; readonly target: string }>) =>
    Effect.succeed(rows.map((row) => ({ commit: row.commit, target: row.target, score: 1 })))
} as unknown as ReplayParts<never>

/** Replays `root` with the targets `rights` lists naming those programs. Gives the report and every progress line. */
const replay = async (
  root: string,
  request: Omit<ReplayRequest, "root">,
  rights: Readonly<Record<string, ReadonlyArray<string>>>
) => {
  const said: Array<string> = []
  const host = Layer.mergeAll(
    Layer.succeed(Options, {
      smthrs: [naming(rights)] as const,
      reruns: 1,
      prepare: (directory: string) => Effect.sync(() => linkTargets(directory)),
      // The script reads its list outside every copy.
      confine: unconfined
    }),
    Layer.succeed(Progress, { say: (line: string) => Effect.sync(() => void said.push(line)) })
  )
  const report = await Effect.runPromise(
    run({ root, ...request }, running).pipe(
      Effect.provide(Layer.provideMerge(host, NodeServices.layer))
    ) as Effect.Effect<ReplayReport, Failure>
  )
  return { report, said }
}

const total = (totals: RunTotals | undefined): number =>
  totals === undefined ? 0 : totals.counts.hit + totals.counts.ran + totals.counts.failed + totals.counts.skipped

const failedSteps = (totals: RunTotals | undefined): ReadonlyArray<string> =>
  (totals?.failures ?? []).map((failure) => failure.step)

/** Every way of a commit. */
const ways = (
  commit: ReplayCommit
): ReadonlyArray<RunTotals> => [commit.baseline, commit.normal, ...(commit.fast === undefined ? [] : [commit.fast])]

describe("a job whose step starts a program that asks for rights", () => {
  it(
    "is left out from the first commit, which runs again without it in every way, from what each way kept before",
    async () => {
      // `p` fails here as `ping` does in a jail; `q` passes, as a step that skips its check when `ping` fails does.
      const jobs = [job("p", "sh p.sh"), job("q", "sh q.sh"), job("plain", "sh plain.sh")]
      const pass = "exit 0\n"
      const { root, commits } = repository([
        {
          jobs,
          files: {
            "p.sh": "echo 'ping: socktype: SOCK_RAW: Operation not permitted' >&2; exit 2\n",
            "q.sh": pass,
            "plain.sh": pass
          }
        },
        { jobs, files: { "README.md": "# docs only\n" } },
        { jobs, files: { "plain.sh": "echo bad >&2; exit 1\n" } }
      ])
      const { report, said } = await replay(root, { commits: 3, modes: ["normal", "fast"] }, {
        "//:p0_0": ["/usr/bin/ping"],
        "//:q0_0": ["/usr/bin/ping", "/usr/sbin/traceroute"]
      })
      expect(report.notReplayed).toEqual([
        { job: "p", reasons: [{ feature: failsHere, detail: ping }] },
        {
          job: "q",
          reasons: [{
            feature: failsHere,
            detail: "runs `ping` and `traceroute`, which need rights this machine's jail takes away"
          }]
        }
      ])
      expect(report.jobs).toEqual({ replayed: 1, total: 3 })
      expect(report.mismatches).toBe(0)
      expect(report.speedupCommits).toBe(2)
      expect(report.commits.map((replayed) => replayed.commit)).toEqual(commits)
      // At no commit is anything of `p` or `q` counted, in any way: only `plain`'s one step.
      for (const replayed of report.commits) {
        for (const way of ways(replayed)) expect(total(way)).toBe(1)
      }
      const [first, docs, bad] = report.commits
      expect(ways(bad!).map(failedSteps)).toEqual([["plain0"], ["plain0"], ["plain0"]])
      expect(ways(first!).map(failedSteps)).toEqual([[], [], []])
      // The first commit ran again with each mode's cache as it was before it: `plain` ran, though the run that was
      // thrown away stored it. The next commit changes none of its files, and finds it.
      expect(first!.normal.counts).toMatchObject({ ran: 1, hit: 0 })
      expect(first!.fast?.counts).toMatchObject({ ran: 1, hit: 0 })
      expect(docs!.normal.counts).toMatchObject({ ran: 0, hit: 1 })
      const at = `1/3 ${commits[0]!.slice(0, 7)}`
      expect(said.filter((line) => line === `${at} baseline`)).toHaveLength(2)
      expect(said).toContain(`fails here: p: ${ping}`)
      expect(said).toContain(`${at} again without p, q`)
      expect(said.filter((line) => line.includes(" again without "))).toHaveLength(1)
    },
    600_000
  )

  it("is left out from the commit that adds the step, which runs again; the commits before keep it", async () => {
    const before = [job("g", "sh g.sh"), job("plain", "sh plain.sh")]
    const after = [job("g", "sh g.sh", { more: ["sh g1.sh"] }), job("plain", "sh plain.sh")]
    const { root, commits } = repository([
      { jobs: before, files: { "g.sh": "exit 0\n", "plain.sh": "exit 0\n" } },
      { jobs: before, files: { "g.sh": "# changed\nexit 0\n" } },
      { jobs: after, files: { "g1.sh": "exit 2\n" } }
    ])
    const { report, said } = await replay(root, { commits: 3, modes: ["normal"] }, { "//:g1_0": ["/usr/bin/ping"] })
    expect(report.notReplayed).toEqual([{ job: "g", reasons: [{ feature: failsHere, detail: ping }] }])
    expect(report.jobs).toEqual({ replayed: 1, total: 2 })
    expect(report.mismatches).toBe(0)
    const [first, second, third] = report.commits
    // `g` and `plain` at the first two commits, as they ran; `plain` alone at the third.
    for (const replayed of [first!, second!]) {
      for (const way of ways(replayed)) expect(total(way)).toBe(2)
      expect(replayed.baseline).toMatchObject({ ok: true, counts: { ran: 2 } })
    }
    expect(second!.normal.counts).toMatchObject({ ran: 1, hit: 1 })
    for (const way of ways(third!)) expect([total(way), way.ok]).toEqual([1, true])
    // What normal mode kept from the commits before is still there when the third runs again.
    expect(third!.normal.counts).toMatchObject({ ran: 0, hit: 1 })
    const at = `3/3 ${commits[2]!.slice(0, 7)}`
    expect(said.filter((line) => line === `${at} baseline`)).toHaveLength(2)
    expect(said.filter((line) => line.endsWith(" baseline"))).toHaveLength(4)
    expect(said).toContain(`${at} again without g`)
  }, 600_000)

  it(
    "found by the first run is left out before any commit counts, a matrix variant by itself, beside what fails here",
    async () => {
      const pass = "exit 0\n"
      const jobs = [
        job("p", "sh p.sh"),
        job("q", "sh q.sh"),
        { ...job("m", "sh m.sh"), matrix: [{ size: "1" }, { size: "2" }] },
        job("plain", "sh plain.sh")
      ]
      const files = { "p.sh": "echo broken >&2; exit 1\n", "q.sh": pass, "m.sh": pass, "plain.sh": pass }
      const { root, commits } = repository([
        { jobs, files },
        { jobs, files: { "README.md": "# docs\n" } },
        { jobs, files: { "README.md": "# more docs\n" } }
      ])
      const { report, said } = await replay(
        root,
        { commits: 2, modes: ["normal"], warm: true, trial: true },
        { "//:q0_0": ["/usr/bin/ping"], "//:m0_1": ["/bin/ping"] }
      )
      const short = (commit: string): string => commit.slice(0, 7)
      expect(report.notReplayed).toEqual([
        // The trial runs the baseline alone, which names no program: `p` fails there as any step does.
        {
          job: "p",
          reasons: [{
            feature: failsHere,
            detail: `p0: exit 1: broken (at ${short(commits[0]!)} and ${short(commits[2]!)})`
          }]
        },
        { job: "q", reasons: [{ feature: failsHere, detail: ping }] },
        { job: "m", reasons: [{ feature: failsHere, detail: `(size=2) ${ping}` }] }
      ])
      expect(report.firstRun?.commit).toBe(commits[0])
      expect(report.jobs).toEqual({ replayed: 2, total: 4 })
      expect(report.mismatches).toBe(0)
      expect(report.commits).toHaveLength(2)
      // `m` on its first variant and `plain`, at each counted commit, in each way.
      for (const replayed of report.commits) {
        for (const way of ways(replayed)) expect([total(way), way.ok]).toEqual([2, true])
      }
      expect(said).toContain(`fails here: q: ${ping}`)
      expect(said).toContain(`fails here: m: (size=2) ${ping}`)
      expect(said.filter((line) => line.includes(" again without "))).toEqual([])
    },
    600_000
  )
})

const step = (label: string, targets: ReadonlyArray<string> = [label]): UnitStep => ({
  id: label,
  name: label,
  label,
  targets,
  command: "true",
  written: "true",
  cwd: "",
  env: {}
})

const result = (label: string, rights?: ReadonlyArray<string>): TargetResult => ({
  label,
  status: "failed",
  key: "",
  durationMs: 1,
  ...(rights === undefined ? {} : { rights })
})

describe("what a run of smthrs says needs rights", () => {
  it("names each program once by the last part of its path", () => {
    expect(rightsTaken(["/usr/bin/ping"])).toBe(ping)
    expect(rightsTaken(["/bin/ping", "/usr/bin/ping"])).toBe(ping)
    expect(rightsTaken(["/usr/bin/ping", "/usr/sbin/traceroute"])).toBe(
      "runs `ping` and `traceroute`, which need rights this machine's jail takes away"
    )
    expect(rightsTaken(["/usr/bin/ping", "/usr/sbin/traceroute", "arping"])).toBe(
      "runs `ping`, `traceroute` and `arping`, which need rights this machine's jail takes away"
    )
  })

  it("belongs to the unit whose step a target runs, a split step's part included; a target of no step is nobody's", () => {
    const units: ReadonlyArray<Unit> = [
      { job: "a", needs: [], steps: [step("a0"), step("a1", ["//:a1-x", "//:a1-y"])] },
      { job: "m", needs: [], steps: [step("m0 (size=2)", ["//:m0_1"])], variant: { size: "2" } },
      { job: "none", needs: [], steps: [step("//:n")] }
    ]
    const results = [
      result("a0"),
      result("//:a1-y", ["/usr/bin/ping"]),
      result("//:m0_1", ["/usr/sbin/traceroute"]),
      result("//:n", []),
      result("//:files", ["/usr/bin/ping"])
    ]
    expect(rightsOf(units, results)).toEqual([
      { job: "a", programs: ["/usr/bin/ping"] },
      { job: "m", variant: { size: "2" }, programs: ["/usr/sbin/traceroute"] }
    ])
    expect(rightsOf(units, [result("a0")])).toEqual([])
  })

  it("leaves each job or variant out once, with every program any run found", () => {
    expect(leftForRights([
      { job: "a", programs: ["/usr/bin/ping"] },
      { job: "m", variant: { size: "2" }, programs: ["/usr/sbin/traceroute"] },
      { job: "a", programs: ["/usr/bin/ping", "/usr/sbin/arping"] },
      { job: "m", variant: { size: "1" }, programs: ["/usr/bin/ping"] }
    ])).toEqual([
      { job: "a", reason: "runs `ping` and `arping`, which need rights this machine's jail takes away" },
      {
        job: "m",
        variant: { size: "2" },
        reason: "(size=2) runs `traceroute`, which needs rights this machine's jail takes away"
      },
      { job: "m", variant: { size: "1" }, reason: `(size=1) ${ping}` }
    ])
    expect(leftForRights([])).toEqual([])
  })
})
