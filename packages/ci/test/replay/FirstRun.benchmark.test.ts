/**
 * Benchmark: what a first run costs, when no result can be reused.
 *
 * **How to run.** `pnpm run benchmark` in `packages/ci`. It is no part of the
 * suite: it holds one time against another, and the suite must not fail for
 * the machine's load.
 *
 * **Shape.** The most common CI: two GitHub Actions jobs, `lint` and `test`,
 * each an install followed by one check. The install takes 0.4 s, `lint`
 * 0.4 s and `test` 3 s; each is a `sleep`, so its time does not move with
 * the machine's load.
 *
 * **Method.** One commit is replayed with the real reader, generator and
 * replay, and the repository's own `smthrs`, from an empty cache. A start of
 * `smthrs` is timed right before and right after each attempt, and the
 * attempt is held against the mean of its own two: the load of a shared
 * machine moves from minute to minute, and a start timed minutes away from
 * the run says nothing about it. A start is `smthrs --help`, which loads
 * every command, as a run does, and does no work (`--version` alone is
 * answered before a command loads). It is started as the replay starts
 * `smthrs`: with no `TMPDIR`, and with Node's compiled code in an empty
 * directory, as a first run's cache directory is. One replay before the
 * first attempt is not timed: a `smthrs` run from source compiles itself,
 * and the targets the generated files import, once, which an installed
 * `smthrs` never does (both ship compiled). The measurement is repeated
 * up to three times and the best is kept, because one slow attempt on a
 * shared machine says nothing about the code.
 *
 * **What it holds.**
 *
 * 1. `smthrs` starts once for the commit.
 * 2. Each job runs its own install, as in the baseline and on GitHub: a job
 *    has a checkout and a home of its own, and a runner tells every step its
 *    job, so the two installs are two steps.
 * 3. The steps take no longer than in the baseline, give or take one start.
 * 4. Around its steps, normal mode adds at most two starts of `smthrs`
 *    and a checkout for each job, timed beside it as the start is: a clone
 *    that shares the repository's objects, as the baseline makes one for
 *    each of its jobs, asked once what it holds, and removed. Measured on
 *    the build server at load 330 to 420 (2026-11-19, three attempts), a
 *    start took 6.6 to 7.4 s and the time around the steps was 1.27 to 1.38
 *    starts. One run, split by the lines `smthrs` prints: the start, reading
 *    the generated files and deciding what to run 7.6 s; the rest of the run
 *    between the steps 0.15 s, in which the two jobs' checkouts were made in
 *    85 and 65 ms; writing the results, removing the checkouts and stopping
 *    0.5 s. Until 2026-11-19 every replay compiled `smthrs` from source
 *    again, 11 s more at load 145, and 1 in 4 check runs read 2.2 to 2.4
 *    starts.
 *
 * **Limits.** It does not hold a ratio of wall times. On this shape normal
 * mode's wall time is the start of `smthrs`, a copy of the checkout for each
 * job, and every step one after the other, where the baseline runs its two
 * jobs side by side: two jobs on one machine share its ports and its `/tmp`,
 * so they never run at once. A cache hit is not measured here: `test/replay`
 * and `test/generate.smthrs.test.ts` hold reuse.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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
import { makeEmptyDirectory, recordingSmthrs, smthrs } from "./fixture.ts"
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

/** The fixture: two jobs, each an install and one check. Every run of the install adds a line to `installs`. */
const repository = (installs: string): string => {
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
  const tree: Readonly<Record<string, string>> = {
    ".github/workflows/ci.yml": ["on: [push]", "jobs:", ...job("lint"), ...job("test"), ""].join("\n"),
    ".gitignore": "deps\n",
    "install.sh": `echo installed >> ${installs}\nsleep 0.4\nmkdir -p deps\necho ready > deps/ready\n`,
    "lint.sh": "test -f deps/ready && sleep 0.4\n",
    "test.sh": "test -f deps/ready && sleep 3\n"
  }
  git(root, "init", "--quiet", "--initial-branch=main")
  for (const [path, content] of Object.entries(tree)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  git(root, "add", "--all")
  git(root, "commit", "--quiet", "--message", "first")
  return root
}

const linesOf = (file: string): number =>
  existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((line) => line !== "").length : 0

/**
 * How long `smthrs` takes to start and stop, in milliseconds, started as a replay starts it on a first run: with no
 * `TMPDIR` and nothing in the directory Node keeps its compiled code in.
 */
const startOf = (): number => {
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !["TMPDIR", "TMP", "TEMP"].includes(name))),
    NODE_COMPILE_CACHE: join(directory(), "node-compile-cache")
  }
  const from = performance.now()
  execFileSync(smthrs, ["--help"], { stdio: "ignore", env })
  return performance.now() - from
}

/**
 * How long a checkout of `root` for one job takes, in milliseconds: a clone that shares its objects, asked once
 * what it holds, and removed, as a job's checkout is made, read and removed.
 */
const checkoutOf = (root: string): number => {
  const copy = join(directory(), "copy")
  const from = performance.now()
  execFileSync("git", ["clone", "--quiet", "--shared", root, copy], { stdio: "ignore" })
  execFileSync("git", ["status", "--porcelain"], { cwd: copy, stdio: "ignore" })
  rmSync(copy, { recursive: true, force: true })
  return performance.now() - from
}

interface Measurement {
  readonly report: ReplayReport
  /** The `smthrs ci` command lines of the replay. */
  readonly starts: number
  readonly installs: number
  readonly startMs: number
  readonly checkoutMs: number
}

/** The parts the program replays with, each with the services `layer` gives it. */
const parts = { read, decompose: split, files, rows, score } as unknown as ReplayParts<never>

/**
 * How the program replays, with `command` for `smthrs`. The command and the steps write what the test counts
 * outside every copy, so the runs have no jail.
 */
const recorded = (command: string) =>
  Layer.provide(
    Layer.effect(
      Options,
      Effect.gen(function*() {
        return { ...(yield* Options), confine: unconfined }
      })
    ),
    replayOptions([command])
  )

const measure = async (root: string, installs: string): Promise<Measurement> => {
  const recording = recordingSmthrs(false)
  created.push(recording.directory)
  const ran = linesOf(installs)
  const before = startOf()
  const copied = checkoutOf(root)
  const report = await Effect.runPromise(
    run({ root, commits: 1, modes: ["normal"] }, parts).pipe(
      Effect.provide(Layer.provide(recorded(recording.command), NodeServices.layer)),
      Effect.provide(layer({}))
    ) as Effect.Effect<ReplayReport, Failure>
  )
  return {
    report,
    starts: recording.commands().filter((line) => line.startsWith("ci ")).length,
    installs: linesOf(installs) - ran,
    startMs: (before + startOf()) / 2,
    checkoutMs: (copied + checkoutOf(root)) / 2
  }
}

describe("a first run, with nothing to reuse", () => {
  it(
    "starts smthrs once, runs each job's own steps, and adds at most two starts and a checkout for each job",
    async () => {
      const installs = join(directory(), "installs")
      const root = repository(installs)
      // Not timed: a smthrs run from source compiles itself and the targets package here, as no installed one does.
      await measure(root, installs)
      const overheads: Array<number> = []
      const slower: Array<number> = []
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const measured = await measure(root, installs)
        const commit = measured.report.commits[0]
        expect(measured.report.mismatches).toBe(0)
        expect(commit?.baseline.counts).toEqual({ hit: 0, ran: 4, failed: 0, skipped: 0 })
        // Four targets: each job installs on its own machine, as each does in the baseline.
        expect(commit?.normal.counts).toEqual({ hit: 0, ran: 4, failed: 0, skipped: 0 })
        // Two installs in the baseline and two in normal mode, one per job.
        expect(measured.installs).toBe(4)
        expect(measured.starts).toBe(1)
        const normal = commit?.normal as ReplayReport["commits"][number]["normal"]
        const baseline = commit?.baseline as ReplayReport["commits"][number]["baseline"]
        // Each of the two jobs runs in a checkout of its own.
        overheads.push((normal.wallMs - normal.workMs - 2 * measured.checkoutMs) / measured.startMs)
        slower.push((normal.workMs - baseline.workMs) / measured.startMs)
        if ((overheads.at(-1) as number) <= 2 && (slower.at(-1) as number) <= 1) break
      }
      expect(Math.min(...slower)).toBeLessThanOrEqual(1)
      expect(Math.min(...overheads)).toBeLessThanOrEqual(2)
    },
    900_000
  )
})
