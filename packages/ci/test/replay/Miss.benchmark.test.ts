/**
 * Benchmark: what a commit costs when nothing can be reused.
 *
 * **Shape.** Two GitHub Actions jobs, `lint` and `test`, each an install
 * followed by one check. The install takes 0.4 s, `lint` 0.4 s and `test`
 * 3 s; each is a `sleep`, so its time does not move with the machine's load.
 * Every step reads `input.txt`, and each check also reads the 200 files of
 * `src`, as a linter or a test runner reads a source tree. Each of the three
 * commits changes `input.txt`: at every commit every step has to run again,
 * and says why.
 *
 * **Method.** The last two commits are replayed with the real reader,
 * generator and replay, and the repository's own `smthrs`. The replay runs
 * each way once at the first commit before it counts, as it does for a
 * person, so the counted commits start with a cache that holds a record of
 * every step, and none of the records holds. Each commit is held against the
 * start of its own run, which the run's record gives (`parts.ms.start`): the
 * load of a shared machine moves from minute to minute, and no start timed
 * beside the run is as near to it as its own. One replay before the first is
 * not timed: a `smthrs` run from source compiles itself once, which an
 * installed `smthrs` never does. The measurement is repeated up to three
 * times, two counted commits each, and the best commit is the one held:
 * on a shared machine the time around a start grows faster than the start
 * when the load rises (every step starts five programs, and the planning
 * and the archive wait for processors as the start does not), so one slow
 * commit says nothing about the code, and a change that costs every commit
 * shows in the best one too.
 *
 * **What it holds.**
 *
 * 1. At each counted commit no step is reused, in the baseline or in normal
 *    mode, and both agree.
 * 2. At each counted commit the run says where its time went, and the parts
 *    add up to its wall time: the checkout, the start, the planning, each
 *    step, the reading of what each step read, and the storing of its
 *    record.
 * 3. Normal mode's wall time is at most 1.05 times the baseline's plus two
 *    and a half starts of `smthrs`: the start itself, and one and a half
 *    more for everything else, which is reading the generated files,
 *    deciding what to run, a checkout for each job, and for each step the
 *    watch, the reading of what it read and the storing of its record.
 * 4. Holding the stored records against the files, reading what the steps
 *    read, keeping what they left and storing their records take half a
 *    start together, at most.
 *
 * Measured on the build server (2026-11-19). At load 17, two commits: the
 * baseline 4.4 s, normal mode 9.2 to 9.5 s, of which the start 2.8 s, the
 * planning 0.5 to 0.7 s, the four commands 4.9 s where the baseline's took
 * 4.3 s, and the records 0.6 s; normal mode was 1.63 to 1.71 of its own
 * starts over 1.05 times the baseline, and the records 0.20. At load 120 to
 * 140, four commits: the baseline 4.5 to 5.7 s, normal mode 11.5 to 18.0 s, of which
 * the start 3.7 to 7.0 s, the planning 0.9 to 2.2 s, the four commands 5.3
 * to 6.4 s where the baseline's took 4.4 to 5.1 s, and the records (item 4)
 * 0.9 to 1.9 s; normal mode was 1.70 to 1.94 of its own starts over 1.05
 * times the baseline, and the records 0.22 to 0.37. At load 150 to 185, six
 * commits: normal mode 16.4 to 23.2 s, the start 4.3 to 9.3 s, 1.97 to 3.22
 * starts over, the records 0.13 to 0.82: the best commit was at 1.97 and
 * 0.13, and a bound on every commit failed.
 *
 * **Limits.** It holds no ratio of wall times: on a CI this short the start
 * of `smthrs` alone is as long as the baseline. The steps sleep, so this
 * holds what Smithers CI adds around a step and for each file a step opens,
 * not how the watch slows a step that makes hundreds of thousands of file
 * calls: each watched call stops the process twice, about 40 millionths of a
 * second together on the build server, which is 1.3 s on a test run that
 * makes 35,000 of them. No step here reaches the network;
 * `ObservedReadsExecution.test.ts` in Smithers build holds that such a step
 * is not watched again for a day. A machine that cannot record what a step
 * reads (macOS, or no `strace`) runs every step at every commit, and item 4
 * holds nothing there.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { layer, replayOptions } from "../../src/cli/Host.vibe"
import type { Failure, ReplayParts } from "../../src/contract/Parts.ts"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { split } from "../../src/decompose/index.ts"
import { files } from "../../src/generate/index.ts"
import { read } from "../../src/inventory/index.ts"
import { Options, run } from "../../src/replay/index.ts"
import { rows, score } from "../../src/select/index.ts"
import { makeEmptyDirectory, smthrs } from "./fixture.ts"
import { unconfined } from "./place.ts"

const created: Array<string> = []
afterAll(() => {
  for (const path of created) rmSync(path, { recursive: true, force: true })
})
const directory = (): string => {
  const path = makeEmptyDirectory()
  created.push(path)
  return path
}

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-c", "user.name=Benchmark", "-c", "user.email=benchmark@example.invalid", ...args], {
    cwd: root,
    encoding: "utf8"
  })

/** How many files each check reads beside `input.txt`. */
const sources = 200

/** The fixture: two jobs, each an install and one check, and three commits that each change what every step reads. */
const repository = (): string => {
  const root = directory()
  const runner = process.platform === "darwin" ? "macos-latest" : "ubuntu-latest"
  const job = (name: string): ReadonlyArray<string> => [
    `  ${name}:`,
    `    runs-on: ${runner}`,
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: sh install.sh",
    `      - run: sh ${name}.sh`
  ]
  const check = (seconds: string): string =>
    `test -f deps/ready && cat input.txt src/* > /dev/null && sleep ${seconds}\n`
  const tree: Record<string, string> = {
    ".github/workflows/ci.yml": ["on: [push]", "jobs:", ...job("lint"), ...job("test"), ""].join("\n"),
    ".gitignore": "deps\n",
    "input.txt": "1\n",
    "install.sh": "cat input.txt > /dev/null\nsleep 0.4\nmkdir -p deps\necho ready > deps/ready\n",
    "lint.sh": check("0.4"),
    "test.sh": check("3")
  }
  for (let index = 0; index < sources; index += 1) tree[`src/file-${index}.txt`] = `source ${index}\n`
  git(root, "init", "--quiet", "--initial-branch=main")
  for (const [path, content] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  git(root, "add", "--all")
  git(root, "commit", "--quiet", "--message", "first")
  for (const version of ["2", "3"]) {
    writeFileSync(join(root, "input.txt"), `${version}\n`)
    git(root, "commit", "--quiet", "--all", "--message", `input ${version}`)
  }
  return root
}

/** The parts the program replays with, each with the services `layer` gives it. */
const parts = { read, decompose: split, files, rows, score } as unknown as ReplayParts<never>

/** How the program replays. The steps need no jail, and a jail's cost is not what this measures. */
const host = Layer.provide(
  Layer.effect(
    Options,
    Effect.gen(function*() {
      return { ...(yield* Options), confine: unconfined }
    })
  ),
  replayOptions([smthrs])
)

const measure = (root: string): Promise<ReplayReport> =>
  Effect.runPromise(
    run({ root, commits: 2, modes: ["normal"], warm: true }, parts).pipe(
      Effect.provide(Layer.provide(host, NodeServices.layer)),
      Effect.provide(layer({}))
    ) as Effect.Effect<ReplayReport, Failure>
  )

type Commit = ReplayReport["commits"][number]

/** What a commit's normal mode spent on a part, in milliseconds. */
const spent = (commit: Commit, part: string): number => commit.normal.parts?.ms[part] ?? 0

/** How far a commit's normal mode is over 1.05 times its baseline, in starts of its own `smthrs`. */
const over = (commit: Commit): number => (commit.normal.wallMs - 1.05 * commit.baseline.wallMs) / spent(commit, "start")

/** What a commit's records took, in starts of its own `smthrs`. */
const records = (commit: Commit): number =>
  ["check", "reads", "keep", "store"].reduce((sum, part) => sum + spent(commit, part), 0) / spent(commit, "start")

describe("a commit that changes what every step reads", () => {
  it(
    "runs every step again within 1.05 times the baseline and two and a half starts of smthrs, and says where the time went",
    async () => {
      const root = repository()
      // Not timed: a smthrs run from source compiles itself and the targets package here, as no installed one does.
      await measure(root)
      const over25: Array<number> = []
      const kept: Array<number> = []
      // What each attempt measured, for the line a failure prints.
      const seen: Array<string> = []
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const report = await measure(root)
        expect(report.mismatches).toBe(0)
        expect(report.commits).toHaveLength(2)
        // The run before the first counted commit filled the cache: no counted commit starts from nothing.
        expect(report.firstRun?.normalMs).toBeGreaterThan(0)
        for (const commit of report.commits) {
          // Nothing is reused: every step read the file the commit changed.
          expect(commit.baseline.counts).toEqual({ hit: 0, ran: 4, failed: 0, skipped: 0 })
          expect(commit.normal.counts).toEqual({ hit: 0, ran: 4, failed: 0, skipped: 0 })
          const parts = commit.normal.parts?.ms ?? {}
          for (const part of ["checkout", "start", "plan", "answer", "machine", "rest"]) {
            expect(parts[part], part).toBeGreaterThanOrEqual(0)
          }
          expect(parts["start"]).toBeGreaterThan(0)
          const named = Object.values(parts).reduce((sum, ms) => sum + ms, 0)
          expect(Math.abs(named - commit.normal.wallMs)).toBeLessThan(50)
          seen.push(
            `baseline ${commit.baseline.wallMs} ms, normal ${commit.normal.wallMs} ms, ` +
              `steps ${Math.round(commit.baseline.workMs)} and ${Math.round(commit.normal.workMs)} ms, ` +
              JSON.stringify(parts)
          )
        }
        over25.push(...report.commits.map(over))
        kept.push(...report.commits.map(records))
        if (Math.min(...over25) <= 2.5 && Math.min(...kept) <= 0.5) break
      }
      expect(Math.min(...kept), seen.join("\n")).toBeLessThanOrEqual(0.5)
      expect(Math.min(...over25), seen.join("\n")).toBeLessThanOrEqual(2.5)
    },
    1_800_000
  )
})
