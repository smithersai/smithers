/** How the baseline runs a CI's steps: in what order, in which checkout, for how long. */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { basename, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Failure, ReplayParts, ReplayRequest } from "../../src/contract/Parts.ts"
import type { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { path as targetMapPath } from "../../src/contract/TargetMap.ts"
import { Options, run } from "../../src/replay/index.ts"
import { job, linkTargets, makeEmptyDirectory, makeSmallRepository, smthrs } from "./fixture.ts"
import { unconfined } from "./place.ts"
import { options, parts } from "./TestParts.vibe"

const created: Array<string> = []
const track = (root: string): string => {
  created.push(root)
  return root
}
afterAll(() => {
  for (const root of created) rmSync(root, { recursive: true, force: true })
})

type Parts = ReplayParts<never>
const base = parts("none") as unknown as Parts

const replay = (
  root: string,
  overrides: Partial<Parts> = {},
  extra: Partial<ReplayRequest> = {},
  host: Layer.Layer<never, never, never> = options as never
): Promise<ReplayReport> =>
  Effect.runPromise(
    run({ root, commits: 1, modes: ["normal"], ...extra }, { ...base, ...overrides }).pipe(
      Effect.provide(Layer.provideMerge(host, NodeServices.layer))
    ) as Effect.Effect<ReplayReport, Failure>
  )

/** A recipe of the repository's Justfile, as the importer reads one. */
const recipe = (
  name: string,
  commands: ReadonlyArray<string>,
  needs: ReadonlyArray<string> = [],
  env: Readonly<Record<string, string>> = {}
) => ({
  ...job(`justfile:${name}`, "true"),
  source: "justfile",
  file: "Justfile",
  triggers: [],
  needs: needs.map((need) => `justfile:${need}`),
  steps: commands.map((command, index) => ({ id: `${name}${index}`, command, cwd: "", env, secrets: [] }))
})

describe("how many baseline jobs run at once", () => {
  /**
   * Six jobs that note when they start and end. The first `together` wait for one another, so that many are running
   * at one moment however busy the machine is. Normal mode's copy only passes: the file shows the baseline.
   */
  const sixJobs = (log: string, together: number) =>
    ["a", "b", "c", "d", "e", "f"].map((name) =>
      job(
        name,
        [
          "case $PWD in */normal/*) exit 0;; esac",
          `echo + >> ${log}`,
          `for i in $(seq 240); do [ "$(grep -c + ${log})" -ge ${together} ] && break; sleep 0.25; done`,
          "sleep 0.2",
          `echo - >> ${log}`
        ].join("\n")
      )
    )
  const peakOf = (log: string): number => {
    let running = 0
    let peak = 0
    for (const line of readFileSync(log, "utf8").trim().split("\n")) {
      running += line === "+" ? 1 : -1
      peak = Math.max(peak, running)
    }
    return peak
  }
  const withCores = (cores: number) =>
    Layer.succeed(Options, {
      smthrs: [smthrs],
      reruns: 1,
      prepare: (directory) => Effect.sync(() => linkTargets(directory)),
      confine: unconfined,
      cores
    })

  it("is the machine's core count when nothing is asked for", async () => {
    const log = join(track(makeEmptyDirectory()), "log")
    await replay(track(makeSmallRepository(sixJobs(log, 2))), {}, {}, withCores(2) as never)
    expect(peakOf(log)).toBe(2)
  }, 600_000)

  it("is what --jobs says, above the core count too", async () => {
    const log = join(track(makeEmptyDirectory()), "log")
    await replay(track(makeSmallRepository(sixJobs(log, 3))), {}, { jobs: 3 }, withCores(1) as never)
    expect(peakOf(log)).toBe(3)
  }, 600_000)

  it("never passes what the target map allows normal mode", async () => {
    const log = join(track(makeEmptyDirectory()), "log")
    const files: Parts["files"] = (inventory) =>
      Effect.map(
        base.files(inventory),
        (all) =>
          all.map((file) =>
            file.path === targetMapPath ? { ...file, content: file.content.replace("{", `{"maxJobs":1,`) } : file
          )
      )
    await replay(track(makeSmallRepository(sixJobs(log, 1))), { files }, { jobs: 4 }, withCores(4) as never)
    expect(peakOf(log)).toBe(1)
  }, 600_000)
})

describe("the recipes of one Justfile, in the baseline", () => {
  it("run in the order the `ci` recipe lists them, in one working tree", async () => {
    // Review finding 9: `ci: build test`. Each recipe got a fresh checkout, so `test` never saw what `build` made.
    const root = track(makeSmallRepository([
      recipe("ci", [], ["build", "test"]),
      recipe("test", ["test -f out/artifact"]),
      recipe("build", ["mkdir out && touch out/artifact"])
    ]))
    const [commit] = (await replay(root)).commits
    expect(commit?.baseline.counts).toEqual({ hit: 0, ran: 2, failed: 0, skipped: 0 })
  }, 600_000)

  it("stop at the first failure, as `just ci` does", async () => {
    const out = track(makeEmptyDirectory())
    const root = track(makeSmallRepository([
      recipe("ci", [], ["lint", "build", "test"]),
      recipe("lint", ["true"]),
      recipe("test", [`touch ${out}/test-ran`]),
      recipe("build", ["exit 1"])
    ]))
    const [commit] = (await replay(root)).commits
    expect(commit?.baseline.counts).toEqual({ hit: 0, ran: 1, failed: 1, skipped: 1 })
    expect(existsSync(join(out, "test-ran"))).toBe(false)
  }, 600_000)

  it("rerun a failed recipe after the recipes before it, so a flaky one is flaky and not failed", async () => {
    const out = track(makeEmptyDirectory())
    const counter = join(out, "runs")
    // Fails the first time it runs and passes the second, and needs what `build` made both times.
    const flaky =
      "test -f out/artifact && n=$(cat \"$COUNTER\" 2>/dev/null || echo 0) && echo $((n + 1)) > \"$COUNTER\" && test $n -ge 1"
    const root = track(makeSmallRepository([
      recipe("ci", [], ["build", "test"]),
      recipe("build", ["mkdir out && touch out/artifact"]),
      recipe("test", [flaky], [], { COUNTER: counter })
    ]))
    const report = await replay(root)
    expect(report.commits[0]?.baseline.counts).toEqual({ hit: 0, ran: 2, failed: 0, skipped: 0 })
    expect(readFileSync(counter, "utf8").trim()).toBe("2")
    expect(report.flaky).toBeGreaterThanOrEqual(1)
  }, 600_000)
})

describe("a baseline step", () => {
  it("is stopped at its time limit and has failed", async () => {
    // Review finding 14: nothing ended a step. The target of this one sleeps its 20 seconds and passes.
    const root = track(makeSmallRepository([job("slow", "sleep 20"), job("ok", "sh a.sh")]))
    const limited = Layer.succeed(Options, {
      smthrs: [smthrs],
      reruns: 0,
      prepare: (directory) => Effect.sync(() => linkTargets(directory)),
      stepTimeout: "2 seconds"
    })
    const [commit] = (await replay(root, {}, {}, limited as never)).commits
    expect(commit?.baseline.counts).toEqual({ hit: 0, ran: 1, failed: 1, skipped: 0 })
    expect(commit?.baseline.wallMs).toBeLessThan(15_000)
    expect(commit?.mismatches).toEqual([{ label: "//:slow0_0", mode: "normal", baseline: "fail", got: "pass" }])
  }, 600_000)

  it("runs in a checkout that is clean, named as the repository is, and never prepared", async () => {
    // Review finding 13: the baseline's copy held the linked package, so a "tree is clean" check failed there.
    const out = track(makeEmptyDirectory())
    const seen = [`test -z "$(git status --porcelain)"`, `basename "$PWD" > ${out}/name`].join(" && ")
    const root = track(makeSmallRepository([job("clean", seen)]))
    const prepared: Array<string> = []
    const recording = Layer.succeed(Options, {
      smthrs: [smthrs],
      reruns: 0,
      prepare: (directory) =>
        Effect.sync(() => {
          prepared.push(directory)
          linkTargets(directory)
        }),
      confine: unconfined
    })
    // Fast mode's rows are built in the copy the targets ran in: what does git say about that copy?
    const status: Array<string> = []
    const rows: Parts["rows"] = (copy, record) => {
      status.push(execFileSync("git", ["-C", copy, "status", "--porcelain"], { encoding: "utf8" }))
      return base.rows(copy, record)
    }
    const report = await replay(root, { rows }, { modes: ["normal", "fast"] }, recording as never)
    expect(report.commits[0]?.baseline.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
    expect(readFileSync(join(out, "name"), "utf8").trim()).toBe(basename(root))
    // The copies the targets run in hold generated files, the cache and the linked package, and git calls them clean.
    expect(status).toEqual([""])
    expect(prepared.map((directory) => basename(join(directory, ".."))).sort()).toEqual(["fast", "normal"])
  }, 600_000)
})
