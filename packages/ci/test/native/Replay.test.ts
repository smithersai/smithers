import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { execFileSync } from "node:child_process"
import { rmSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { Failure, ReplayParts, ReplayRequest, RunReplay } from "../../src/contract/Parts.ts"
import { ReplayReport } from "../../src/contract/ReplayReport.ts"
import { read } from "../../src/inventory/index.ts"
import {
  committedWorkspace,
  generatedMark,
  type Host,
  installLabel,
  notTargets,
  own,
  run,
  Targets
} from "../../src/native/index.ts"
import { Options, Progress } from "../../src/replay/index.ts"
import { fakeSmthrs, makeOwn, makeOwnWith, type Own, ownFiles, smthrs } from "./own.ts"
import { git, repository, temporary } from "./repo.ts"
import { cannotStart, noTemporaryDirectories, rows, scoreKeeping } from "./support.vibe"

const made: Array<string> = []
const keep = (root: string): string => {
  made.push(root)
  return root
}
afterAll(() => made.forEach((root) => rmSync(root, { recursive: true, force: true })))

type Parts = ReplayParts<Host>

/** The real reader, a fixed scorer, and a generator that must never be asked. */
const partsFor = (first: string): Parts => ({
  read,
  files: () => Effect.fail({ code: "invalid-document", message: "nothing may be generated", part: "generate" }),
  rows,
  score: scoreKeeping("//:c", first)
})

const said: Array<string> = []
const host = Layer.mergeAll(
  Layer.succeed(Options, { smthrs: ["never-used"], reruns: 1, prepare: () => Effect.void }),
  Layer.succeed(Progress, { say: (line) => Effect.sync(() => void said.push(line)) })
)

const request = (root: string, extra: Partial<ReplayRequest> = {}): ReplayRequest => ({
  root,
  commits: 1,
  modes: ["normal"],
  ...extra
})

const onNode = <A, E>(work: Effect.Effect<A, E, Host | Layer.Success<typeof host>>): Promise<A> =>
  Effect.runPromise(Effect.provide(work, Layer.provideMerge(host, NodeServices.layer)) as Effect.Effect<A, E>)

const failureOf = (attempt: Promise<unknown>): Promise<Failure> =>
  attempt.then(
    () => {
      throw new Error("the replay succeeded")
    },
    (cause: { readonly message: string }) => JSON.parse(JSON.stringify(cause)) as Failure
  )

const neverGeneric: RunReplay<Host> = () =>
  Effect.fail({ code: "invalid-document", message: "the generic replay was called", part: "replay" })

describe("replaying six real commits of a repository's own targets", () => {
  let repo: Own
  let report: ReplayReport

  beforeAll(async () => {
    repo = makeOwn()
    keep(repo.root)
    report = await onNode(
      run(neverGeneric)(
        request(repo.root, { commits: 6, modes: ["normal", "fast"], settings: { scoreCutoff: 0.5, countCutoff: 0 } }),
        partsFor(repo.commits[0]!)
      )
    )
  }, 600_000)

  const commit = (index: number) => report.commits[index]!
  const normalMismatches = (index: number) => commit(index).mismatches.filter((entry) => entry.mode === "normal")

  it("writes a report the contract decodes, oldest commit first", () => {
    expect(Schema.decodeUnknownSync(ReplayReport)(report)).toEqual(report)
    expect(report.commits.map((entry) => entry.commit)).toEqual(repo.commits)
    expect(report.commits.map((entry) => entry.changedFiles)).toEqual([1, 1, 1, 1, 1, 1])
    expect(report.speedup).toBe(report.baselineWallMs / report.normalWallMs)
  })

  it("names the repository, not the copy it ran in", () => {
    expect(report.repository).toBe(repo.root.slice(repo.root.lastIndexOf("/") + 1))
  })

  it("runs every target cold in the baseline and only what changed in normal mode", () => {
    expect(commit(0).baseline.counts).toEqual({ hit: 0, ran: 3, failed: 0, skipped: 0 })
    expect(commit(0).normal.counts).toEqual({ hit: 0, ran: 3, failed: 0, skipped: 0 })
    expect(commit(1).baseline.counts).toEqual({ hit: 0, ran: 3, failed: 0, skipped: 0 })
    expect(commit(1).normal.counts).toEqual({ hit: 2, ran: 1, failed: 0, skipped: 0 })
    // The fix restores a script the cache has seen, so nothing runs.
    expect(commit(3).baseline.counts).toEqual({ hit: 0, ran: 3, failed: 0, skipped: 0 })
    expect(commit(3).normal.counts).toEqual({ hit: 3, ran: 0, failed: 0, skipped: 0 })
  })

  it("gives a broken commit the same verdicts in both, the target behind the broken one included", () => {
    expect(commit(2).baseline).toMatchObject({ ok: false, counts: { hit: 0, ran: 1, failed: 1, skipped: 1 } })
    expect(commit(2).normal).toMatchObject({ ok: false, counts: { hit: 1, ran: 0, failed: 1, skipped: 1 } })
    expect(normalMismatches(2)).toEqual([])
  })

  it("reports a commit whose install fails as failed in every mode, and goes on", () => {
    for (const totals of [commit(4).baseline, commit(4).normal, commit(4).fast]) {
      expect(totals).toMatchObject({ ok: false, counts: { hit: 0, ran: 0, failed: 1, skipped: 0 } })
    }
    expect(commit(4).mismatches).toEqual([])
    expect(said).toContain(
      `${repo.commits[4]!.slice(0, 7)} is not installed: npm ci --no-audit --no-fund exited 1 in the repository root`
    )
    // The install script is no target's input, so the next commit comes back from the cache.
    expect(commit(5).baseline.counts).toEqual({ hit: 0, ran: 3, failed: 0, skipped: 0 })
    expect(commit(5).normal.counts).toEqual({ hit: 3, ran: 0, failed: 0, skipped: 0 })
  })

  it("has no mismatch between the baseline and normal mode on any commit", () => {
    expect(report.commits.flatMap((_, index) => normalMismatches(index))).toEqual([])
  })

  it("runs fast mode on what the scorer keeps", () => {
    // Every score of the first commit is low, so fast mode runs nothing there; nothing failed, so nothing differs.
    expect(commit(0).fast?.counts).toEqual({ hit: 0, ran: 0, failed: 0, skipped: 3 })
    expect(commit(0).mismatches).toEqual([])
    // Only b ran in normal mode and its score is low; a and c have no score, so they run.
    expect(commit(1).fast?.counts).toEqual({ hit: 0, ran: 2, failed: 0, skipped: 1 })
    expect(report.fastWallMs).toBe(report.commits.reduce((total, entry) => total + (entry.fast?.wallMs ?? 0), 0))
    expect(report.selection).toBeDefined()
  })

  it("says which targets it replays and which CI job it leaves out", () => {
    expect(said).toContain("replaying the repository's own targets (WORKSPACE.ts): //:a //:b //:c")
    expect(report.notReplayed).toEqual([{
      job: "ci.yml:docs",
      reasons: [{ feature: notTargets, detail: ".github/workflows/ci.yml: no step runs Smithers build targets" }]
    }])
  })

  it("leaves the repository as it found it", () => {
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: repo.root, encoding: "utf8" })).toBe("")
    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo.root, encoding: "utf8" }).trim()).toBe(
      repo.commits[5]
    )
  })
})

describe("replaying a repository's own targets", () => {
  it("replays the patterns asked for instead of the ones its CI runs, with the jobs and the cache named", async () => {
    const calls = keep(temporary("calls"))
    const recording = fakeSmthrs(`echo "cache=$SMITHERS_CACHE_URL $*" >> ${calls}/log\nexec $real "$@"`)
    const root = keep(makeOwnWith(recording))
    const report = await onNode(
      Effect.provideService(
        own(request(root, { jobs: 2, cache: "https://cache.example.invalid" }), partsFor("none"), "WORKSPACE.ts"),
        Targets,
        { patterns: ["//:c"] }
      )
    )
    expect(report.commits[0]?.baseline.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
    expect(report.commits[0]?.normal.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
    expect(report.mismatches).toBe(0)
    const log = execFileSync("cat", [`${calls}/log`], { encoding: "utf8" }).trim().split("\n")
    expect(log).toHaveLength(2)
    // The baseline reads no cache, here or shared; normal mode reads both.
    expect(log[0]).toMatch(
      /^cache= ci \/\/:c --workspace \S+ --cache-dir \.flows --no-cache --results-file \S+ --ui plain --jobs 2$/
    )
    expect(log[1]).toMatch(
      /^cache=https:\/\/cache\.example\.invalid ci \/\/:c --workspace \S+ --cache-dir \.flows --results-file \S+ --ui plain --jobs 2$/
    )
    expect(said).toContain("replaying the repository's own targets (WORKSPACE.ts): //:c")
  })

  it("names the repository by its remote, and runs fast mode with the default settings", async () => {
    const root = keep(makeOwnWith(smthrs))
    git(root, "remote", "add", "origin", "https://example.invalid/acme/own.git")
    const report = await onNode(own(request(root, { modes: ["fast"] }), partsFor("none"), "WORKSPACE.ts"))
    expect(report.repository).toBe("acme/own")
    expect(report.commits[0]?.normal.counts).toEqual({ hit: 0, ran: 3, failed: 0, skipped: 0 })
    expect(report.commits[0]?.fast?.ok).toBe(true)
    expect(report.selection).toBeDefined()
    expect(report.mismatches).toBe(0)
  }, 120_000)

  it("is unsupported, with the reason, when no commit can be installed", async () => {
    const root = keep(repository({ ...ownFiles(), "tools/install.mjs": "process.exit(1)\n" }))
    const failure = await failureOf(onNode(own(request(root), partsFor("none"), "WORKSPACE.ts")))
    expect(failure).toEqual({
      code: "unsupported",
      part: "replay",
      message: "no replayed commit could be installed: npm ci --no-audit --no-fund exited 1 in the repository root"
    })
  })

  it("fails with what smthrs printed when it writes no run record", async () => {
    const root = keep(makeOwnWith(fakeSmthrs(`echo "host binary go is not on the PATH"; exit 1`)))
    const failure = await failureOf(onNode(own(request(root), partsFor("none"), "WORKSPACE.ts")))
    expect(failure).toMatchObject({ code: "command-failed", part: "replay" })
    expect(failure.message).toBe("smthrs ci wrote no run record: host binary go is not on the PATH\n")
  })

  it("fails when the run record is not one", async () => {
    const root = keep(makeOwnWith(fakeSmthrs(`echo '{"ok":' > "$results"`)))
    const failure = await failureOf(onNode(own(request(root), partsFor("none"), "WORKSPACE.ts")))
    expect(failure.code).toBe("command-failed")
    expect(failure.message).toContain("smthrs ci wrote no run record")
  })

  it("fails in fast mode when smthrs prints no plan", async () => {
    const noPlan = fakeSmthrs(`case "$*" in *--plan*) echo "no plan here"; exit 0;; esac\nexec $real "$@"`)
    const root = keep(makeOwnWith(noPlan))
    const failure = await failureOf(onNode(own(request(root, { modes: ["fast"] }), partsFor("none"), "WORKSPACE.ts")))
    expect(failure.code).toBe("command-failed")
    expect(failure.message).toBe("smthrs ci --plan printed no plan: no plan here\n")
  })

  it("fails when it cannot make a directory to work in", async () => {
    const root = keep(makeOwnWith("true"))
    const failure = await failureOf(
      onNode(Effect.provide(own(request(root), partsFor("none"), "WORKSPACE.ts"), noTemporaryDirectories))
    )
    expect(failure.code).toBe("command-failed")
    expect(failure.message).toContain("could not make a directory")
  })

  it("fails with git's words on a directory that is not a repository", async () => {
    const failure = await failureOf(onNode(own(request(keep(temporary("empty"))), partsFor("none"), "WORKSPACE.ts")))
    expect(failure.code).toBe("command-failed")
    expect(failure.message).toContain("git clone failed")
  })

  it("fails when git cannot be started", async () => {
    const root = keep(makeOwnWith("true"))
    const failure = await failureOf(
      onNode(Effect.provide(own(request(root), partsFor("none"), "WORKSPACE.ts"), cannotStart("git")))
    )
    expect(failure.code).toBe("command-failed")
    expect(failure.message).toContain("could not run git")
  })
})

describe("the replay part for any repository", () => {
  const generic: RunReplay<Host> = (given) =>
    Effect.succeed({
      version: 1,
      repository: `generic ${given.commits}`,
      commits: [],
      baselineWallMs: 0,
      normalWallMs: 0,
      speedup: 0,
      mismatches: 0
    })

  it("finds the workspace file an owner committed", async () => {
    expect(await onNode(committedWorkspace(keep(makeOwnWith("true"))))).toBe("WORKSPACE.ts")
    const { "WORKSPACE.ts": text, ...rest } = ownFiles()
    expect(await onNode(committedWorkspace(keep(repository({ ...rest, ".smithers/WORKSPACE.ts": text ?? "" })))))
      .toBe(".smithers/WORKSPACE.ts")
  })

  it("sends a repository without one, or with a generated one, to the generic replay", async () => {
    const plain = keep(repository({ "README.md": "plain\n" }))
    const converted = keep(repository({ ".smithers/WORKSPACE.ts": `${generatedMark} Do not edit.\n` }))
    const uncommitted = keep(repository({ "README.md": "plain\n" }))
    execFileSync("cp", [`${keep(makeOwnWith("true"))}/WORKSPACE.ts`, `${uncommitted}/WORKSPACE.ts`])
    for (const root of [plain, converted, uncommitted, keep(temporary("empty"))]) {
      expect(await onNode(committedWorkspace(root))).toBeUndefined()
      expect((await onNode(run(generic)(request(root, { commits: 4 }), partsFor("none")))).repository).toBe("generic 4")
    }
  })

  it("sends every repository to the generic replay when git cannot be started", async () => {
    const root = keep(makeOwnWith("true"))
    expect(await onNode(Effect.provide(committedWorkspace(root), cannotStart("git")))).toBeUndefined()
  })

  it("marks the result of a failed install with a label no target has", () => {
    expect(installLabel.startsWith("//")).toBe(false)
  })
})
