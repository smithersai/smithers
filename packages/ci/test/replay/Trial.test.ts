/** The run that finds what can pass here when no way runs first, in real repositories, with the real `smthrs`. */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { failsHere, needsLeftOut } from "../../src/contract/Inventory.vibe"
import type { Failure, ReplayParts, ReplayRequest } from "../../src/contract/Parts.vibe"
import type { ReplayReport } from "../../src/contract/ReplayReport.vibe"
import { Options, run } from "../../src/replay/index.vibe"
import { job, linkTargets, makeSmallRepository, smthrs } from "./fixture.ts"
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

const start = (root: string, commits: number, extra: Partial<ReplayRequest> = {}) =>
  Effect.runPromise(
    run({ root, commits, modes: ["normal"], trial: true, ...extra }, base).pipe(
      Effect.provide(Layer.provideMerge(options as never, NodeServices.layer))
    ) as Effect.Effect<ReplayReport, Failure>
  )

const refusal = (root: string, commits = 1): Promise<Failure> =>
  start(root, commits).then(
    () => {
      throw new Error("the replay succeeded")
    },
    (cause: { readonly message: string }) => JSON.parse(JSON.stringify(cause)) as Failure
  )

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-c", "user.name=Replay", "-c", "user.email=replay@example.com", ...args], {
    cwd: root,
    encoding: "utf8"
  }).trim()

/** How a reason names the commits a job failed at: `(at 3f2a1c9 and 8d1e0b2)`. */
const at = (root: string, ...revisions: ReadonlyArray<string>): string =>
  `(at ${revisions.map((revision) => git(root, "rev-parse", revision).slice(0, 7)).join(" and ")})`

/** A new commit that changes `a.sh`, so each commit is its own. */
const another = (root: string, content = "# again\nexit 0\n"): void => {
  writeFileSync(join(root, "a.sh"), content)
  git(root, "add", "-A")
  git(root, "commit", "--quiet", "-m", "another")
}

const scratch = (): string => track(mkdtempSync(join(tmpdir(), "replay-trial-")))

/** A command that fails with `message`, and adds a line to `log` each time it runs. */
const failing = (log: string, message: string): string => `echo ran >> ${log}; echo '${message}' >&2; exit 1`

describe("a job that cannot pass on this machine", () => {
  it("is left out and listed, and the speedup covers the job that passes, at every commit", async () => {
    const log = join(scratch(), "runs")
    const jobs = [job("ok", "sh a.sh"), job("fine", "sh a.sh"), job("docker", failing(log, "no docker here"))]
    const root = track(makeSmallRepository(jobs))
    another(root)
    const report = await start(root, 2)
    // The step that failed, its exit code, the first line of its error, and the commits it failed at.
    const why = `docker0: exit 1: no docker here ${at(root, "HEAD^", "HEAD")}`
    expect(report.notReplayed).toEqual([{ job: "docker", reasons: [{ feature: failsHere, detail: why }] }])
    expect(report.jobs).toEqual({ replayed: 2, total: 3 })
    expect(report.speedupCommits).toBe(2)
    expect(report.speedup).toBeGreaterThan(0)
    expect(report.trialMs).toBeGreaterThan(0)
    for (const commit of report.commits) {
      expect(commit.baseline.ok).toBe(true)
      expect(commit.normal.ok).toBe(true)
      expect(commit.baseline.counts.ran).toBe(2)
    }
    // Run once at the oldest commit and once more at the newest, and at no counted commit.
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2)
  }, 600_000)

  it("takes the jobs that need it with it", async () => {
    const root = track(makeSmallRepository([
      job("ok", "sh a.sh"),
      job("fine", "sh a.sh"),
      job("well", "sh a.sh"),
      job("first", "echo broken >&2; exit 1"),
      job("after", "sh a.sh", { needs: ["first"] })
    ]))
    const report = await start(root, 1)
    expect(report.notReplayed).toEqual([
      { job: "first", reasons: [{ feature: failsHere, detail: `first0: exit 1: broken ${at(root, "HEAD")}` }] },
      { job: "after", reasons: [{ feature: needsLeftOut, detail: "after needs first, which is not replayed" }] }
    ])
    expect(report.jobs).toEqual({ replayed: 3, total: 5 })
  }, 600_000)

  it("is judged per matrix variant: the variants that pass stay", async () => {
    const root = track(makeSmallRepository([
      job("ok", "sh a.sh"),
      {
        ...job("m", "test ${{ matrix.size }} -lt 2 || { echo too big >&2; exit 1; }"),
        matrix: [{ size: "1" }, { size: "2" }]
      }
    ]))
    const report = await start(root, 1)
    expect(report.notReplayed).toEqual([
      { job: "m", reasons: [{ feature: failsHere, detail: `m0 (size=2): exit 1: too big ${at(root, "HEAD")}` }] }
    ])
    expect(report.jobs).toEqual({ replayed: 2, total: 2 })
    expect(report.commits[0]?.baseline.counts.ran).toBe(2)
    expect(report.commits[0]?.mismatches).toEqual([])
  }, 600_000)

  it("leaves out only what fails in one working tree, and runs the rest without it", async () => {
    const inTree = (id: string, command: string, needs: ReadonlyArray<string> = []) => ({
      ...job(id, command, { needs }),
      source: "justfile",
      file: "justfile"
    })
    const root = track(makeSmallRepository([
      inTree("broken", "echo broken >&2; exit 1"),
      inTree("later", "sh a.sh"),
      inTree("last", "sh a.sh")
    ]))
    const report = await start(root, 1)
    expect(report.notReplayed).toEqual([
      { job: "broken", reasons: [{ feature: failsHere, detail: `broken0: exit 1: broken ${at(root, "HEAD")}` }] }
    ])
    expect(report.commits[0]?.baseline.ok).toBe(true)
    expect(report.commits[0]?.baseline.counts.ran).toBe(2)
  }, 600_000)

  it("is kept when a second run passes: one failure is a flake", async () => {
    const counter = join(scratch(), "count")
    const flaky = `n=$(cat ${counter} 2>/dev/null || echo 0); echo $((n + 1)) > ${counter}; test "$n" -ge 1`
    const report = await start(track(makeSmallRepository([job("flaky", flaky)])), 1)
    expect(report.notReplayed).toBeUndefined()
    expect(report.jobs).toEqual({ replayed: 1, total: 1 })
  }, 600_000)

  it("runs in a home of its own, so it warms nothing the baseline reads", async () => {
    const once = "test ! -e $HOME/seen && touch $HOME/seen"
    const report = await start(track(makeSmallRepository([job("once", once)])), 1)
    expect(report.notReplayed).toBeUndefined()
    expect(report.commits[0]?.baseline.ok).toBe(true)
  }, 600_000)
})

describe("a job that passes at the newest commit and fails at an older one", () => {
  it("is an ordinary failed baseline at that commit", async () => {
    const root = track(makeSmallRepository([job("a", "sh a.sh")]))
    another(root, "echo old break >&2; exit 1\n")
    another(root)
    const report = await start(root, 2)
    expect(report.notReplayed).toBeUndefined()
    expect(report.commits[0]?.baseline.failures?.[0]?.reason).toBe("old break")
    expect(report.speedupCommits).toBe(1)
  }, 600_000)
})

describe("a CI of which half or more cannot pass here", () => {
  it("is not measured: the replay says which jobs it left out and why, and what to do", async () => {
    const root = track(makeSmallRepository([job("ok", "sh a.sh"), job("bad", "echo broken >&2; exit 1")]))
    const { code, message } = await refusal(root)
    expect(code).toBe("unsupported")
    expect(message.split("\n")).toEqual([
      "this replay cannot measure your CI on this machine: 1 of its 2 jobs does not pass here, and a speedup over the rest would not be your CI's.",
      `  bad  fails on this machine: bad0: exit 1: broken ${at(root, "HEAD")}`,
      "Fix what a line names and run it again, or pass --no-trial to compare every job as it is."
    ])
  }, 600_000)

  it("counts the jobs that need one that cannot pass", async () => {
    const root = track(makeSmallRepository([
      job("ok", "sh a.sh"),
      job("fine", "sh a.sh"),
      job("first", "echo broken >&2; exit 1"),
      job("after", "sh a.sh", { needs: ["first"] })
    ]))
    const { message } = await refusal(root)
    expect(message).toContain("2 of its 4 jobs do not pass here")
    expect(message).toContain("\n  after  ")
  }, 600_000)

  it("is measured with --no-trial, which compares every job as it is", async () => {
    const root = track(makeSmallRepository([job("ok", "sh a.sh"), job("bad", "echo broken >&2; exit 1")]))
    const report = await start(root, 1, { trial: false })
    expect(report.jobs).toEqual({ replayed: 2, total: 2 })
    expect(report.commits[0]?.baseline.failures?.[0]?.reason).toBe("broken")
  }, 600_000)
})

describe("a CI where no job passes", () => {
  it("is refused with the first failure", async () => {
    const root = track(makeSmallRepository([job("one", "echo first >&2; exit 1"), job("two", "exit 2")]))
    const at = git(root, "rev-parse", "HEAD").slice(0, 7)
    expect(await refusal(root)).toEqual({
      code: "unsupported",
      part: "replay",
      message: [
        `this repository's CI does not pass on this machine, so there is no speedup to measure. No job passed at ${at}.`,
        `First failure at ${at}:`,
        "  step     one0",
        "  command  echo first >&2; exit 1",
        "  exit     1",
        "  error    first"
      ].join("\n")
    })
  }, 600_000)
})

describe("a CI whose only job that could pass needs one that cannot", () => {
  it("is refused with the first failure", async () => {
    const root = track(
      makeSmallRepository([job("first", "echo first >&2; exit 1"), job("after", "sh a.sh", { needs: ["first"] })])
    )
    const { code, message } = await refusal(root)
    expect(code).toBe("unsupported")
    expect(message).toContain("No job passed at")
    expect(message).toContain("  error    first")
  }, 600_000)
})

describe("the run that finds what passes", () => {
  it("runs in the jail, where the machine has one", async () => {
    const jailed = Layer.succeed(Options, {
      smthrs: [smthrs] as const,
      reruns: 0,
      prepare: (directory: string) => Effect.sync(() => linkTargets(directory))
    })
    const jobs = [job("ok", "sh a.sh"), job("fine", "sh a.sh"), job("bad", "echo broken >&2; exit 1")]
    const root = track(makeSmallRepository(jobs))
    const report = await Effect.runPromise(
      run({ root, commits: 1, modes: ["normal"], trial: true }, base).pipe(
        Effect.provide(Layer.provideMerge(jailed as never, NodeServices.layer))
      ) as Effect.Effect<ReplayReport, Failure>
    )
    expect(report.notReplayed).toEqual([
      { job: "bad", reasons: [{ feature: failsHere, detail: `bad0: exit 1: broken ${at(root, "HEAD")}` }] }
    ])
  }, 600_000)

  it("gives up with the reason when the CI can no longer be read", async () => {
    const root = track(makeSmallRepository([job("ok", "sh a.sh"), job("bad", "exit 1")]))
    let reads = 0
    const unreadable: Failure = { code: "invalid-document", message: "no second read", part: "inventory" }
    const once: ReplayParts<never> = {
      ...base,
      read: (directory) => {
        reads += 1
        return reads === 1 ? base.read(directory) : Effect.fail(unreadable)
      }
    }
    const failure = await Effect.runPromise(
      Effect.flip(
        run({ root, commits: 1, modes: ["normal"], trial: true }, once).pipe(
          Effect.provide(Layer.provideMerge(options as never, NodeServices.layer))
        ) as Effect.Effect<ReplayReport, Failure>
      )
    )
    expect(failure).toEqual(unreadable)
  }, 600_000)
})

describe("without the trial", () => {
  it("runs every job at every commit", async () => {
    const log = join(scratch(), "runs")
    const root = track(makeSmallRepository([job("ok", "sh a.sh"), job("bad", failing(log, "broken"))]))
    const report = await start(root, 1, { trial: false })
    expect(report.notReplayed).toBeUndefined()
    expect(report.trialMs).toBeUndefined()
    expect(report.jobs).toEqual({ replayed: 2, total: 2 })
    expect(report.commits[0]?.baseline.ok).toBe(false)
    expect(existsSync(log)).toBe(true)
  }, 600_000)
})
