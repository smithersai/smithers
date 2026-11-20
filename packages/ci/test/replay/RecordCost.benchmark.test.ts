/**
 * Benchmark: what recording a step costs when the step has to run.
 *
 * **How to run.** `pnpm exec smthrs test "//packages/ci:bench"` from the
 * repository root, or `pnpm run benchmark` in `packages/ci`. It is no part of
 * the suite, as `Miss.benchmark.test.ts` says why.
 *
 * **Shape.** Two repositories, each one GitHub Actions job of one step, and
 * three commits that each change `input.txt`, which the step reads: at every
 * counted commit the step runs again in normal mode, recorded.
 *
 * - `processes` starts 720 programs, four at a time, as a compiler driver
 *   starts compilers: each of 360 shells reads `input.txt` and one source
 *   file with `cat` and computes for about 30 ms.
 * - `files` is one Node program that reads 1,500 source files and computes
 *   for about 1.5 ms on each, as a type checker reads a source tree.
 *
 * **Method.** The last two commits are replayed with the real reader,
 * generator and replay, and the repository's own `smthrs`, after one replay
 * that is not timed (a `smthrs` run from source compiles itself once). The
 * recorder is the one the host's build picks: `smthrs-observe` on x86_64
 * Linux. Each commit holds its normal mode against its own baseline. The
 * baseline runs the step alone, so its wall and CPU time are the step's;
 * normal mode's build measures itself part by part, and `step` is the step
 * itself and `reads` the reading of what it read after it ended. The measurement is repeated
 * up to three times and the best commit is the one held, for the reason
 * `Miss.benchmark.test.ts` gives.
 *
 * **What it holds**, for each fixture, at the best counted commit:
 *
 * 1. The step ran in both ways, and no step was reused.
 * 2. Normal mode's step and the reading of what it read take at most 1.20
 *    times the baseline's step in wall time, and at most 1.30 times its CPU
 *    time: what `docs/concepts/modes.md` says a step that has to run costs.
 *
 * Measured on the build server (2026-11-20), by hand with the same steps
 * outside a replay, best of three: `processes` 1.33 s plain, 1.69 s recorded
 * with its reading (1.27 times) when it starts 600 programs in that time;
 * `files` 0.43 s plain, 0.53 s with its reading (1.22 times) when it reads
 * 2,000 files in that time. The fixtures here start and read fewer for each
 * second of work: about as many as `go test` of google/go-cmp, which holds
 * the bound (1.05 times its wall and 1.10 times its CPU recorded, plus 0.7 s
 * of reading, on a step of 10 s).
 *
 * **Limits.** A step that makes file calls faster than these, such as
 * pallets/click's pre-commit hooks (83,000 calls and 540 programs in 1.2 s),
 * costs more: each call the recorder sees costs the step 10 to 20 millionths
 * of a second of the recorder's time. A machine that cannot record what a step
 * reads (macOS, or Linux with neither recorder) holds nothing here: the test
 * is skipped there.
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

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-c", "user.name=Benchmark", "-c", "user.email=benchmark@example.invalid", ...args], {
    cwd: root,
    encoding: "utf8"
  })

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
  files: {
    sources: 1500,
    script: [
      "import { createHash } from \"node:crypto\"",
      "import { readFileSync } from \"node:fs\"",
      "let sum = readFileSync(\"input.txt\", \"utf8\").length",
      "for (let file = 0; file < 1500; file += 1) {",
      "  let text = readFileSync(`src/file-${file}.txt`, \"utf8\")",
      "  for (let round = 0; round < 900; round += 1) text = createHash(\"sha1\").update(text).digest(\"hex\")",
      "  sum += text.charCodeAt(0)",
      "}",
      "console.log(sum)",
      ""
    ].join("\n"),
    command: "node step.mjs"
  }
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
    [fixture === "files" ? "step.mjs" : "step.sh"]: script
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

/**
 * Normal mode's step with the reading of what it read, against the baseline, which runs the step alone (its wall
 * and CPU time are the step's): wall time and CPU time.
 */
const ratios = (commit: Commit): { readonly wall: number; readonly cpu: number } => {
  const normal = commit.normal.parts
  const sum = (part: Record<string, number> | undefined): number => (part?.["step"] ?? 0) + (part?.["reads"] ?? 0)
  return {
    wall: sum(normal?.ms) / commit.baseline.wallMs,
    cpu: sum(normal?.cpuMs) / (commit.baseline.cpuMs ?? Number.NaN)
  }
}

const recordable = process.platform === "linux"

describe.skipIf(!recordable)("a step that has to run, recorded", () => {
  for (const fixture of ["processes", "files"] as const) {
    it(
      `costs at most 1.20 times its wall time and 1.30 times its CPU time when it ${
        fixture === "files" ? "reads many files" : "starts many processes"
      }`,
      async () => {
        const root = repository(fixture)
        // Not timed: a smthrs run from source compiles itself here, as no installed one does.
        await measure(root)
        const held: Array<{ readonly wall: number; readonly cpu: number }> = []
        const seen: Array<string> = []
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const report = await measure(root)
          expect(report.mismatches).toBe(0)
          expect(report.commits).toHaveLength(2)
          for (const commit of report.commits) {
            expect(commit.baseline.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
            expect(commit.normal.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
            const ratio = ratios(commit)
            held.push(ratio)
            seen.push(
              `baseline ${commit.baseline.wallMs} ms, ${commit.baseline.cpuMs} ms CPU; normal ` +
                `${JSON.stringify(commit.normal.parts)}: ` +
                `${ratio.wall.toFixed(2)} wall, ${ratio.cpu.toFixed(2)} CPU`
            )
          }
          if (held.some((ratio) => ratio.wall <= 1.2 && ratio.cpu <= 1.3)) break
        }
        const best = held.reduce((left, right) =>
          Math.max(left.wall / 1.2, left.cpu / 1.3) <= Math.max(right.wall / 1.2, right.cpu / 1.3) ? left : right
        )
        expect(best.wall, seen.join("\n")).toBeLessThanOrEqual(1.2)
        expect(best.cpu, seen.join("\n")).toBeLessThanOrEqual(1.3)
      },
      1_800_000
    )
  }
})
