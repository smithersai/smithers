/**
 * Benchmark: what recording a step costs when the step has to run.
 *
 * **How to run.** `pnpm exec smthrs test "//packages/ci:bench"` from the
 * repository root, or `pnpm run benchmark` in `packages/ci`. It is no part of
 * the suite, as `Miss.benchmark.test.ts` says why.
 *
 * **Shape.** Three repositories, each one GitHub Actions job of one step, and
 * three commits that each change `input.txt`, which the step reads: at every
 * counted commit the step runs again in normal mode, recorded.
 *
 * - `processes` starts 720 programs, four at a time, as a compiler driver
 *   starts compilers: each of 360 shells reads `input.txt` and one source
 *   file with `cat` and computes for about 30 ms.
 * - `files` is one Node program that reads 800 source files of 2 KB and
 *   computes for about 6 ms on each: 160 files a second of CPU, the density
 *   of `go test` in google/go-cmp (6,494 files in 40 s of CPU) and of
 *   commander.js's `tsc -p tsconfig.js.json` (1,590 files in 10 s), measured
 *   with strace on 2026-11-21.
 * - `dense` is the same program over 8,000 files, hashing each 250 times:
 *   about 4,000 files a second of CPU, as a type check or a linter over an
 *   installed tree reads.
 *
 * **Method.** Each replay replays the last two commits with the real reader,
 * generator and replay, and the repository's own `smthrs`, after one replay
 * that is not timed (a `smthrs` run from source compiles itself once). The
 * recorder is the one the build picks: `smthrs-observe` on x86_64 Linux.
 * `pnpm run benchmark` builds it first where zig 0.17.1 is installed, as the
 * `observe` target of `@smthrs/build-cli` does; where it is not built, the
 * benchmark fails rather than measure strace in its place. At each commit the
 * baseline runs the step alone, so its wall and CPU time are the step's, and
 * normal mode runs it right after; normal mode's build measures itself part
 * by part: `step` is the step with what the build itself spends while it
 * runs, and `reads` the reading of what it read after it ended.
 *
 * A pair is one commit's baseline and normal run. The replay runs twice back
 * to back, so each pair runs twice within about a minute, and each side keeps
 * the lesser of its two runs: a shared machine only ever adds time to a run,
 * so the least is the honest reading. Five such double replays give ten pairs;
 * the gate reads the median of the ten ratios, normal over baseline, wall and
 * CPU apart. A pair's two sides run within seconds of each other, so a load
 * that changes over minutes moves both; the fastest normal run over the
 * fastest baseline instead holds a baseline taken in a quiet minute against a
 * normal run taken in a loaded one, and was over the wall bound at load 108
 * to 126 where the median of pairs was not.
 *
 * **Artifacts.** Every run appends one JSON line a fixture to
 * `record-cost-<fixture>.jsonl` in `$RECORD_COST_OUT`, or in the system's
 * temporary directory: the time, the load at the start and end of each replay,
 * each run of each pair (wall and CPU of both sides, and of the reading) and
 * the two medians. The assertion's message holds the same table.
 *
 * **What it holds**, for each fixture:
 *
 * 1. At every counted commit the step ran in both ways, and no step was
 *    reused.
 * 2. The median of the ten pairs: normal mode's step and the reading of what
 *    it read take at most 1.20 times the baseline's step in wall time, and at
 *    most 1.30 times its CPU time: what `docs/concepts/modes.md` says a step
 *    that has to run costs.
 * 3. In every pair normal mode's step uses at least 0.7 times the baseline's
 *    CPU time. It does the same work, recorded: less says the build did not
 *    count the step's processes, and then 2 says nothing about CPU (as from
 *    355f33e4d1f3 to 6e525e375a9c, when a step under a job's keeper was not
 *    counted).
 *
 * `dense` is a known failure: its test is expected to fail, and turns red the
 * day such a step holds the bound.
 *
 * **Limits.** One machine, shared: on the build server (48 threads, ten
 * agents' builds and tests beside it) the same baseline work took 3.0 to
 * 7.4 s within one run at load 83 to 96, so one run against another moves by
 * half, while the recording costs `files` about 3 to 6% and its reading 0.06
 * to 0.17 s of a 3 s step. A single pair says nothing; the median of ten
 * double pairs is what holds. Ten rounds of this benchmark there on
 * 2026-11-21, at load 13 to 247: the median was over the bound in none,
 * `processes` at 1.04 to 1.17 wall and 1.10 to 1.16 CPU, `files` at 1.00 to
 * 1.13 wall and 1.10 to 1.22 CPU, while single pairs were over in up to 4 of
 * 10 within a round. A step that reads files faster than `files` costs more:
 * `dense` was over the CPU bound in each of eight rounds (median 1.46 to 1.57
 * CPU, 1.01 to 1.08 wall, load 18 to 155), and at 476 files a second of CPU
 * (2,500 files, commander.js's `eslint .`) the median was 1.13 to 1.23 CPU in
 * five rounds, inside the bound. A machine
 * that cannot record what a step reads (macOS, or Linux with neither
 * recorder) holds nothing here: the test is skipped there.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"
import { layer, replayOptions } from "../../src/cli/Host.vibe"
import type { Failure, ReplayParts } from "../../src/contract/Parts.vibe"
import type { ReplayReport } from "../../src/contract/ReplayReport.vibe"
import { split } from "../../src/decompose/index.ts"
import { files } from "../../src/generate/index.vibe"
import { read } from "../../src/inventory/index.vibe"
import { Options, run } from "../../src/replay/index.vibe"
import { rows, score } from "../../src/select/index.vibe"
import { makeEmptyDirectory, smthrs } from "./fixture.ts"
import { unconfined } from "./place.ts"

const created: Array<string> = []
afterAll(() => {
  for (const path of created) rmSync(path, { recursive: true, force: true })
})

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-c", "user.name=Benchmark", "-c", "user.email=benchmark@example.invalid", ...args], {
    cwd: root,
    encoding: "utf8"
  })

/** A Node program that reads `files` source files and hashes each `rounds` times. */
const reader = (files: number, rounds: number): string =>
  [
    "import { createHash } from \"node:crypto\"",
    "import { readFileSync } from \"node:fs\"",
    "let sum = readFileSync(\"input.txt\", \"utf8\").length",
    `for (let file = 0; file < ${files}; file += 1) {`,
    "  let text = readFileSync(`src/file-${file}.txt`, \"utf8\")",
    `  for (let round = 0; round < ${rounds}; round += 1) text = createHash("sha1").update(text).digest("hex")`,
    "  sum += text.charCodeAt(0)",
    "}",
    "console.log(sum)",
    ""
  ].join("\n")

/** The step of each fixture, and the files it reads beside `input.txt`. */
const fixtures = {
  processes: {
    sources: 360,
    script: [
      "lane() {",
      "  i=$1",
      "  while [ $i -le 360 ]; do",
      "    sh -c \"cat input.txt src/file-$i.txt > /dev/null; n=0; while [ \\$n -lt 25000 ]; do n=\\$((n+1)); done\"",
      "    i=$((i+4))",
      "  done",
      "}",
      "lane 1 & lane 2 & lane 3 & lane 4 & wait",
      ""
    ].join("\n"),
    command: "sh step.sh"
  },
  files: { sources: 800, script: reader(800, 4100), command: "node step.mjs" },
  dense: { sources: 8000, script: reader(8000, 250), command: "node step.mjs" }
} as const

/** A repository with one job of one step, and three commits that each change what the step reads. */
const repository = (fixture: keyof typeof fixtures): string => {
  const root = makeEmptyDirectory()
  created.push(root)
  const { command, script, sources } = fixtures[fixture]
  const runner = process.platform === "darwin" ? "macos-latest" : "ubuntu-latest"
  const tree: Record<string, string> = {
    ".github/workflows/ci.yml": [
      "on: [push]",
      "jobs:",
      `  ${fixture}:`,
      `    runs-on: ${runner}`,
      "    steps:",
      "      - uses: actions/checkout@v4",
      `      - run: ${command}`,
      ""
    ].join("\n"),
    "input.txt": "1\n",
    [fixture === "processes" ? "step.sh" : "step.mjs"]: script
  }
  for (let index = 0; index < sources; index += 1) {
    tree[`src/file-${index}.txt`] = `source ${index}\n${"x".repeat(2000)}\n`
  }
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

/** Wall and CPU time of one run, in milliseconds. */
interface Time {
  readonly wall: number
  readonly cpu: number
}

/** One commit's baseline, normal mode's step with its reading, and the reading alone. */
interface Pair {
  readonly baseline: Time
  readonly normal: Time
  readonly reads: Time
}

const pairOf = (commit: Commit): Pair => {
  const part = (name: string, of: "ms" | "cpuMs"): number => commit.normal.parts?.[of]?.[name] ?? 0
  return {
    baseline: { wall: commit.baseline.wallMs, cpu: commit.baseline.cpuMs ?? Number.NaN },
    normal: { wall: part("step", "ms") + part("reads", "ms"), cpu: part("step", "cpuMs") + part("reads", "cpuMs") },
    reads: { wall: part("reads", "ms"), cpu: part("reads", "cpuMs") }
  }
}

const least = (one: Time, other: Time): Time => ({
  wall: Math.min(one.wall, other.wall),
  cpu: Math.min(one.cpu, other.cpu)
})

/** A pair run twice back to back: each side keeps the lesser of its two runs. */
const lesser = (one: Pair, other: Pair): Pair => ({
  baseline: least(one.baseline, other.baseline),
  normal: least(one.normal, other.normal),
  reads: least(one.reads, other.reads)
})

const median = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((x, y) => x - y)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

/** The median ratio of normal mode over the baseline among some pairs, wall and CPU apart. */
const medianRatio = (pairs: ReadonlyArray<Pair>): Time => ({
  wall: median(pairs.map((pair) => pair.normal.wall / pair.baseline.wall)),
  cpu: median(pairs.map((pair) => pair.normal.cpu / pair.baseline.cpu))
})

const load = (): number => Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0])

/** How many double replays a fixture runs: two counted commits each, so ten pairs. */
const doubles = 5

const recordable = process.platform === "linux"

/** The recorder the build picks on x86_64 Linux, where the build holds it. */
const observer = fileURLToPath(
  new URL("../../../../node_modules/@smthrs/build-cli/native/out/linux-x64/smthrs-observe", import.meta.url)
)

/**
 * The median ratios of a fixture's ten double pairs, with what was measured. Normal mode's step does the baseline's
 * work, recorded: far less CPU than the baseline's says the build did not count the step's processes, and then the
 * CPU bound says nothing.
 */
const cost = async (fixture: keyof typeof fixtures): Promise<{ readonly ratio: Time; readonly seen: string }> => {
  const root = repository(fixture)
  // Not timed: a smthrs run from source compiles itself here, as no installed one does.
  await measure(root)
  const pairs: Array<Pair> = []
  const runs: Array<{ readonly load: ReadonlyArray<number>; readonly pairs: ReadonlyArray<Pair> }> = []
  for (let double = 0; double < doubles; double += 1) {
    const twice: Array<ReadonlyArray<Commit>> = []
    for (let time = 0; time < 2; time += 1) {
      const before = load()
      const report = await measure(root)
      expect(report.mismatches).toBe(0)
      expect(report.commits).toHaveLength(2)
      for (const commit of report.commits) {
        expect(commit.baseline.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
        expect(commit.normal.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
      }
      runs.push({ load: [before, load()], pairs: report.commits.map(pairOf) })
      twice.push(report.commits)
    }
    const [first, second] = twice as [ReadonlyArray<Commit>, ReadonlyArray<Commit>]
    for (const [index, commit] of first.entries()) {
      expect(second[index]!.commit).toBe(commit.commit)
      pairs.push(lesser(pairOf(commit), pairOf(second[index]!)))
    }
  }
  const ratio = medianRatio(pairs)
  const at = (time: Time): string => `${Math.round(time.wall)} ms ${Math.round(time.cpu)} ms CPU`
  const seen = [
    ...runs.map((run, index) =>
      `replay ${index + 1}, load ${run.load.join(" to ")}: ` +
      run.pairs.map((pair) => `baseline ${at(pair.baseline)}, normal ${at(pair.normal)} (reads ${at(pair.reads)})`)
        .join("; ")
    ),
    ...pairs.map((pair, index) =>
      `pair ${index + 1}: ${(pair.normal.wall / pair.baseline.wall).toFixed(2)} wall, ` +
      `${(pair.normal.cpu / pair.baseline.cpu).toFixed(2)} CPU`
    ),
    `median of ${pairs.length}: ${ratio.wall.toFixed(2)} wall, ${ratio.cpu.toFixed(2)} CPU`
  ].join("\n")
  const out = process.env["RECORD_COST_OUT"] ?? tmpdir()
  mkdirSync(out, { recursive: true })
  appendFileSync(
    join(out, `record-cost-${fixture}.jsonl`),
    `${JSON.stringify({ at: new Date().toISOString(), fixture, runs, pairs, median: ratio })}\n`
  )
  for (const pair of pairs) {
    expect(pair.normal.cpu - pair.reads.cpu, `normal mode's CPU does not count the step\n${seen}`)
      .toBeGreaterThanOrEqual(0.7 * pair.baseline.cpu)
  }
  return { ratio, seen }
}

describe.skipIf(!recordable)("a step that has to run, recorded", () => {
  it.runIf(process.arch === "x64")("is recorded with smthrs-observe, as the build records it on x86_64 Linux", () => {
    expect(process.env["SMTHRS_OBSERVE_WITH"], "SMTHRS_OBSERVE_WITH asks for strace").not.toBe("strace")
    expect(
      existsSync(observer),
      `${observer} is not built: run \`node packages/smithers/build/build-cli/scripts/build-observe.mjs\` with zig 0.17.1`
    ).toBe(true)
  })

  for (const fixture of ["processes", "files"] as const) {
    it(
      `costs at most 1.20 times its wall time and 1.30 times its CPU time when it ${
        fixture === "files" ? "reads many files" : "starts many processes"
      }`,
      async () => {
        const { ratio, seen } = await cost(fixture)
        expect(ratio.wall, seen).toBeLessThanOrEqual(1.2)
        expect(ratio.cpu, seen).toBeLessThanOrEqual(1.3)
      },
      1_800_000
    )
  }

  // A known failure: a step that reads 4,000 files a second of CPU, as a type check over an installed tree does, costs
  // more than the bound. Measured on nyc-01, 2026-11-21, eight rounds at load 18 to 155: the median 1.01 to 1.08 wall
  // and 1.46 to 1.57 CPU, every round over. This test turns red the day such a step holds the bound.
  it.fails(
    "costs at most 1.20 times its wall time and 1.30 times its CPU time when it reads 4,000 files a second of CPU",
    async () => {
      const { ratio, seen } = await cost("dense")
      expect(ratio.wall, seen).toBeLessThanOrEqual(1.2)
      expect(ratio.cpu, seen).toBeLessThanOrEqual(1.3)
    },
    1_800_000
  )
})
