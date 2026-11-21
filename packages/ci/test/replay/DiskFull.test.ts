/**
 * A replay on a disk its jobs would fill, in real temporary repositories run by the real `smthrs`. The disk is a
 * small one (`SmallDisk.vibe`): each byte of a file named `ballast` a step writes takes a megabyte of it.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { execFileSync } from "node:child_process"
import { existsSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Failure, ReplayParts } from "../../src/contract/Parts.ts"
import { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { files } from "../../src/generate/index.ts"
import { gigabyte } from "../../src/replay/DiskSpace.ts"
import { Options, Progress, run, WorkDirectory } from "../../src/replay/index.ts"
import { text } from "../../src/report/Text.ts"
import { job, linkTargets, makeSmallRepository, smthrs } from "./fixture.ts"
import { unconfined } from "./place.ts"
import { smallDisk } from "./SmallDisk.vibe"
import { parts } from "./TestParts.vibe"

const created: Array<string> = []
const track = (root: string): string => {
  created.push(root)
  return root
}
afterAll(() => {
  for (const root of created) rmSync(root, { recursive: true, force: true })
})

const base = parts("none") as unknown as ReplayParts<never>
/** The real generator in place of the test one: a job's targets run on a machine of its own, as `smithers-ci` runs them. */
const generating = { ...base, files } as unknown as ReplayParts<never>
const gb = (n: number): number => n * gigabyte

/** What a replay said, the folder it kept its copies in, and its report or failure. */
interface Outcome {
  readonly said: ReadonlyArray<string>
  readonly folders: ReadonlyArray<string>
  readonly result: ReplayReport | Failure
  readonly ms: number
}

/**
 * Replays `commits` commits of `root` on a small disk with `free` bytes free, where the ballast counts while the
 * replay runs a way `counted` names (`baseline`, `normal`).
 */
const replay = async (
  root: string,
  commits: number,
  free: number,
  counted: ReadonlyArray<string>,
  jobs = 2,
  taken: (since: (way: string) => number | undefined) => number = () => 0,
  trial = false,
  chosen: ReplayParts<never> = base
): Promise<Outcome> => {
  const said: Array<string> = []
  const folders: Array<string> = []
  let way = ""
  // When each way was first said to start.
  const started = new Map<string, number>()
  const host = Layer.mergeAll(
    Layer.succeed(Options, {
      smthrs: [smthrs],
      reruns: 0,
      prepare: (directory) => Effect.sync(() => linkTargets(directory)),
      confine: unconfined,
      diskTick: "100 millis"
    }),
    Layer.succeed(Progress, {
      say: (line) =>
        Effect.sync(() => {
          said.push(line)
          way = line.split(" ").at(-1) as string
          if (!started.has(way)) started.set(way, Date.now())
        })
    }),
    Layer.succeed(WorkDirectory, { at: (directory) => Effect.sync(() => void folders.push(directory)) }),
    smallDisk(free, () => counted.includes(way), () => taken((name) => started.get(name)))
  )
  const start = Date.now()
  const result = await Effect.runPromise(
    run({ root, commits, modes: ["normal"], jobs, trial }, chosen).pipe(
      Effect.catch((failure: Failure) => Effect.succeed(failure)),
      Effect.provide(Layer.provideMerge(host, NodeServices.layer))
    ) as Effect.Effect<ReplayReport | Failure>
  )
  return { said, folders, result, ms: Date.now() - start }
}

/** Writes `bytes` bytes of ballast into the job's temporary directory. */
const ballast = (bytes: number): string => `head -c ${bytes} /dev/zero > "$TMPDIR/ballast"`

/** A second commit, `two`, on `root`. */
const commitTwo = (root: string): void => {
  writeFileSync(join(root, "two.txt"), "two\n")
  execFileSync("git", ["add", "-A"], { cwd: root })
  execFileSync("git", [
    "-c",
    "user.name=Replay",
    "-c",
    "user.email=replay@example.com",
    "commit",
    "--quiet",
    "-m",
    "two"
  ], {
    cwd: root
  })
}

const stoppedHere =
  /^the replay stopped before the disk filled: the disk that holds \S+ has (\S+) GB free, under the (\S+) GB a replay leaves free \(5 GB, or 2% of the disk when that is more\); the replay held (\S+) GB there, (\S+) GB of it in its jobs' machines\. (Run it with fewer jobs at once \(--jobs\) or with more free space|Free \S+ GB more on that disk, or set TMPDIR to a folder on a disk with more room)$/

describe("a replay on a disk its jobs would fill", () => {
  it("starts a job only once what the jobs before it left is gone, and says the most it held", async () => {
    // One job at a time; each holds 6 GB in its temporary directory for a second more, so the disk is read while it
    // holds it, and the job's machine is gone when the job ends, before the next starts.
    const root = track(
      makeSmallRepository([job("first", `${ballast(6000)} && sleep 1`), job("second", `${ballast(6000)} && sleep 1`)])
    )
    const { said, result } = await replay(root, 1, gb(9), ["baseline"], 1)
    const report = result as ReplayReport
    expect(report.commits[0]?.baseline.ok).toBe(true)
    expect(report.commits[0]?.normal.ok).toBe(true)
    expect(report.stopped).toBeUndefined()
    expect(report.diskHeldBytes).toBe(gb(6))
    expect(said.some((line) => line.startsWith("waiting for disk space"))).toBe(false)
    expect(text(report)).toContain(
      "The replay held at most 6 GB of disk at once; fewer jobs at once (--jobs) hold less"
    )
  }, 600_000)

  it("holds no more than the jobs that run at once: each job's machine goes when its last step is judged", async () => {
    // Four jobs, one at a time, each leaving 1 GB in its temporary directory and running a second more, so the disk
    // is read while it holds it. A runner's machine is gone when its job ends; so is a job's machine in the baseline
    // and in normal mode, so the replay holds 1 GB at most, not 4.
    const jobs = ["one", "two", "three", "four"].map((name) => job(name, `${ballast(1000)} && sleep 1`))
    for (const way of ["baseline", "normal"]) {
      const root = track(makeSmallRepository(jobs))
      const { result } = await replay(root, 1, gb(100), [way], 1, () => 0, false, generating)
      const report = result as ReplayReport
      expect([way, report.commits[0]?.baseline.ok, report.commits[0]?.normal.ok]).toEqual([way, true, true])
      expect([way, report.diskHeldBytes]).toEqual([way, gb(1)])
    }
  }, 600_000)

  it("reports no commit and says why when there is no room from the start", async () => {
    const root = track(makeSmallRepository([job("only", "true")]))
    const { folders, result } = await replay(root, 1, gb(4), ["baseline"])
    const report = result as ReplayReport
    expect(report.commits).toEqual([])
    expect(report.stopped).toMatch(stoppedHere)
    expect(report.stopped).toContain("has 4.0 GB free")
    // Nothing a job held could give the room back, so the line says how much to free.
    expect(report.stopped).toContain("Free 1.0 GB more on that disk, or set TMPDIR")
    expect(Schema.decodeUnknownSync(ReplayReport)(report)).toEqual(report)
    expect(text(report).split("\n")[0]).toMatch(/^The replay stopped before the disk filled: /)
    // Its machines and copies are gone with its folder.
    expect(folders).toHaveLength(1)
    expect(existsSync(folders[0] as string)).toBe(false)
  }, 600_000)

  it("reports no commit and says why when the disk stops the run that finds what passes here", async () => {
    const root = track(makeSmallRepository([job("only", "true")]))
    // That run is said as "checking which jobs pass on this machine at <commit>": the disk is small from then on.
    const tip = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
    const { result } = await replay(root, 1, gb(4), [tip], 2, () => 0, true)
    const report = result as ReplayReport
    expect(report.commits).toEqual([])
    expect(report.stopped).toMatch(stoppedHere)
    expect(Schema.decodeUnknownSync(ReplayReport)(report)).toEqual(report)
    expect(text(report).split("\n")[0]).toMatch(/^The replay stopped before the disk filled: /)
  }, 600_000)

  it("ends a running job when the disk would fill, and reports the commits before", async () => {
    // At `two` the step fills the disk to 2 GB free and would then wait ten minutes.
    const step = `if [ "$(git log -1 --format=%s)" = two ]; then ${ballast(7000)}; sleep 600; fi`
    const root = track(makeSmallRepository([job("grow", step)]))
    commitTwo(root)
    const { result, ms } = await replay(root, 2, gb(9), ["baseline", "normal"])
    const report = result as ReplayReport
    expect(report.commits.map((commit) => commit.baseline.ok)).toEqual([true])
    expect(report.stopped).toMatch(stoppedHere)
    expect(report.stopped).toContain("has 2.0 GB free")
    expect(report.diskHeldBytes).toBe(gb(7))
    expect(ms).toBeLessThan(500_000)
    expect(Schema.decodeUnknownSync(ReplayReport)(report)).toEqual(report)
    expect(text(report)).toContain("The replay stopped before the disk filled: the disk that holds")
  }, 600_000)

  it("ends a mode's run when the disk would fill while Smithers build runs it", async () => {
    // Another program takes 7 GB of the disk 10 s after normal mode starts, while its step waits two minutes.
    const root = track(makeSmallRepository([job("wait", "sleep 120")]))
    const filled = (since: (way: string) => number | undefined): number => {
      const normal = since("normal")
      return normal !== undefined && Date.now() - normal > 10_000 ? gb(7) : 0
    }
    const { result } = await replay(root, 1, gb(9), [], 2, filled)
    // Had the run been waited for, the replay would have reported its one commit: it reports none, and why.
    const report = result as ReplayReport
    expect(report.commits).toEqual([])
    expect(report.stopped).toMatch(stoppedHere)
    expect(report.stopped).toContain("has 2.0 GB free")
  }, 600_000)
})
