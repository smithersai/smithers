import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { execFileSync } from "node:child_process"
import { rmSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
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
  run
} from "../../src/native/index.ts"
import { noPushUrl } from "../../src/replay/Environment.ts"
import { Options, type Probe, Progress } from "../../src/replay/index.ts"
import { cannotRecord } from "../../src/replay/Reads.ts"
import { unconfined } from "../replay/place.ts"
import {
  fakeSmthrs,
  installScript,
  makeOwn,
  makeOwnWith,
  type Own,
  ownFiles,
  packageWithUncached,
  smthrs
} from "./own.ts"
import { commit, git, refusedAt, repository, temporary } from "./repo.ts"

const head = (root: string): string => git(root, "rev-parse", "HEAD").trim()
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
const hostWith = (confine: { readonly confine?: () => Probe }) =>
  Layer.mergeAll(
    Layer.succeed(Options, { smthrs: [smthrs], reruns: 1, prepare: () => Effect.void, ...confine }),
    Layer.succeed(Progress, { say: (line) => Effect.sync(() => void said.push(line)) })
  )
const host = hostWith({})

const request = (root: string, extra: Partial<ReplayRequest> = {}): ReplayRequest => ({
  root,
  commits: 1,
  modes: ["normal"],
  ...extra
})

const onNodeWith =
  (chosen: typeof host) => <A, E>(work: Effect.Effect<A, E, Host | Layer.Success<typeof host>>): Promise<A> =>
    Effect.runPromise(Effect.provide(work, Layer.provideMerge(chosen, NodeServices.layer)) as Effect.Effect<A, E>)

/** On this machine as it is: where it can jail a run, the runs are jailed. */
const onNode = onNodeWith(host)

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
  }, 1_200_000)

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
      `5/6 ${
        repo.commits[4]!.slice(0, 7)
      } baseline: (install) failed: npm ci --no-audit --no-fund exited 1 in the repository root`
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
    const passed = report.commits.filter((entry) => entry.baseline.ok)
    expect(report.speedupCommits).toBe(passed.length)
    expect(report.fastWallMs).toBe(passed.reduce((total, entry) => total + (entry.fast?.wallMs ?? 0), 0))
    expect(report.selection).toBeDefined()
  })

  it("says what each run did as it goes, and why a target failed", () => {
    const short = (index: number) => repo.commits[index]!.slice(0, 7)
    expect(said).toContain(`1/6 ${short(0)} baseline`)
    expect(
      said.some((line) => /^1\/6 \w{7} baseline: 3 ran, 0 from the cache, 0 failed, 0 skipped in \d+ s$/.test(line))
    )
      .toBe(true)
    expect(said.some((line) => /^2\/6 \w{7} normal: 1 ran, 2 from the cache, 0 failed, 0 skipped in \d+ s$/.test(line)))
      .toBe(true)
    expect(said.some((line) => line.startsWith(`3/6 ${short(2)} baseline: //:a failed with exit code `))).toBe(true)
    expect(said.some((line) => line.startsWith(`3/6 ${short(2)} normal: //:a failed with exit code `))).toBe(true)
  })

  it("says which targets it replays and which CI job it leaves out", () => {
    expect(said).toContain("replaying the repository's own targets (WORKSPACE.ts): //:a //:b //:c")
    expect(report.targets).toEqual(["//:a", "//:b", "//:c"])
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

// Each test runs real processes; a loaded machine must not turn that into a failure.
describe("replaying a repository's own targets", { timeout: 300_000 }, () => {
  // These repositories bring a `smthrs` the test wrote in the temporary directory, and the test reads what a run
  // wrote there. A jailed run has a temporary directory of its own, so these run with no jail.
  const onNode = onNodeWith(hostWith({ confine: unconfined }))

  /** A `smthrs` that records the shared-cache variables it was given and its command line, then runs the real one. */
  const recordingSmthrs = () => {
    const calls = keep(temporary("calls"))
    const command = fakeSmthrs(
      `echo "url=$SMITHERS_CACHE_URL tokens=[$SMITHERS_CACHE_TOKEN][$SMITHERS_CACHE_READ_TOKEN][$SMITHERS_CACHE_WRITE_TOKEN] $*" >> ${calls}/log\nexec $real "$@"`
    )
    const all = () => execFileSync("cat", [`${calls}/log`], { encoding: "utf8" }).trim().split("\n")
    // The plan that finds what a commit installs is printed once per commit, before its runs.
    const planned = /^url=\S* tokens=\[\S*\] ci (\S+ )+--plan --format json --workspace \S+$/
    return {
      command,
      log: () => all().filter((line) => !planned.test(line)),
      plans: () => all().filter((line) => planned.test(line))
    }
  }

  /** Runs `work` with the credentials of a shared cache in this process's environment. */
  const withSecrets = async <A>(work: () => Promise<A>): Promise<A> => {
    vi.stubEnv("SMITHERS_CACHE_TOKEN", "t0")
    vi.stubEnv("SMITHERS_CACHE_READ_TOKEN", "r0")
    vi.stubEnv("SMITHERS_CACHE_WRITE_TOKEN", "w0")
    try {
      return await work()
    } finally {
      vi.unstubAllEnvs()
    }
  }

  it("hands the recorder the person chose to every run of the copy's own smthrs", async () => {
    const calls = keep(temporary("recorder"))
    const command = fakeSmthrs(`echo "with=\${SMTHRS_OBSERVE_WITH-unset} $*" >> ${calls}/log\nexec $real "$@"`)
    const runs = () =>
      execFileSync("cat", [`${calls}/log`], { encoding: "utf8" }).trim().split("\n").filter((line) =>
        !line.includes("--plan")
      )
    const root = keep(makeOwnWith(command))
    vi.stubEnv("SMTHRS_OBSERVE_WITH", "strace")
    try {
      await onNode(own(request(root), partsFor("none"), "WORKSPACE.ts"))
    } finally {
      vi.unstubAllEnvs()
    }
    expect(runs().length).toBeGreaterThan(0)
    expect(runs().filter((line) => !line.startsWith("with=strace "))).toEqual([])
  })

  it("puts the stand-ins first on the PATH of what a commit's targets start", async () => {
    const first = "first=${PATH%%:*}\n[ \"${first##*/}\" = guard ]\n"
    const root = keep(makeOwnWith(smthrs, { "a.sh": first }))
    const report = await onNode(own(request(root, { targets: ["//:a"] }), partsFor("none"), "WORKSPACE.ts"))
    expect(report.commits[0]?.baseline.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
    expect(report.commits[0]?.normal.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
  })

  it("says once when a run reports that reads cannot be recorded", async () => {
    const reporting = fakeSmthrs(
      `echo "smthrs: reads are not observed on this host: no tracer; a target that asks for it is keyed by its declared inputs"\nexec $real "$@"`
    )
    const root = keep(makeOwnWith(reporting))
    said.length = 0
    await onNode(own(request(root, { commits: 2 }), partsFor("none"), "WORKSPACE.ts"))
    expect(said.filter((line) => line.startsWith("this machine cannot record"))).toEqual([cannotRecord("no tracer")])
  })

  it("replays the patterns asked for, and gives the shared cache --cache names to normal mode only", async () => {
    const recording = recordingSmthrs()
    const root = keep(makeOwnWith(recording.command))
    const report = await withSecrets(() =>
      onNode(
        own(
          request(root, { jobs: 2, cache: "https://cache.example.invalid", targets: ["//:c"] }),
          partsFor("none"),
          "WORKSPACE.ts"
        )
      )
    )
    expect(report.targets).toEqual(["//:c"])
    expect(report.commits[0]?.baseline.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
    expect(report.commits[0]?.normal.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
    expect(report.mismatches).toBe(0)
    const log = recording.log()
    expect(log).toHaveLength(2)
    // No run gets a credential, so the baseline neither reads a shared cache nor stores into one. Normal mode
    // alone is told where the cache --cache names is.
    expect(log[0]).toMatch(
      /^url= tokens=\[\]\[\]\[\] ci \/\/:c --workspace \S+ --cache-dir \.flows --no-cache --results-file \S+ --ui plain --jobs 2$/
    )
    expect(log[1]).toMatch(
      /^url=https:\/\/cache\.example\.invalid tokens=\[\]\[\]\[\] ci \/\/:c --workspace \S+ --cache-dir \.flows --results-file \S+ --ui plain --jobs 2$/
    )
    expect(said).toContain("replaying the repository's own targets (WORKSPACE.ts): //:c")
  })

  it("gives a commit's install and its own smthrs what a target gets of the environment, and no remote to push to", async () => {
    const seen = keep(temporary("seen"))
    const recording = fakeSmthrs(
      [
        `env > ${seen}/smthrs`,
        `git remote get-url --push origin > ${seen}/push`,
        `git remote get-url origin > ${seen}/fetch`,
        `exec $real "$@"`
      ].join("\n")
    )
    const install = `${installScript(recording)}writeFileSync(${
      JSON.stringify(`${seen}/install`)
    }, Object.keys(process.env).join("\\n"))\n`
    const root = keep(makeOwnWith(recording, { "tools/install.mjs": install }))
    git(root, "remote", "add", "origin", "https://example.invalid/acme/own.git")
    const planted = {
      AI_GATEWAY_API_KEY: "dummy-key-123",
      SMITHERS_CACHE_TOKEN: "dummy-tok-456",
      TOOL_HOME: "/opt/tool"
    }
    Object.assign(process.env, planted)
    try {
      const report = await onNode(
        own(request(root, { cache: "https://cache.example.invalid" }), partsFor("none"), "WORKSPACE.ts")
      )
      expect(report.commits[0]?.normal.counts).toEqual({ hit: 0, ran: 3, failed: 0, skipped: 0 })
    } finally {
      for (const name of Object.keys(planted)) delete process.env[name]
    }
    const text = (name: string): string => execFileSync("cat", [`${seen}/${name}`], { encoding: "utf8" })
    for (const name of Object.keys(planted)) {
      expect(text("install").split("\n")).not.toContain(name)
      expect(text("smthrs")).not.toContain(`${name}=`)
    }
    expect(text("install").split("\n")).toContain("PATH")
    // The last run was normal mode's, which is told where the shared cache is.
    expect(text("smthrs")).toContain("SMITHERS_CACHE_URL=https://cache.example.invalid\n")
    expect(text("fetch").trim()).toBe("https://example.invalid/acme/own.git")
    expect(text("push").trim()).toBe(noPushUrl)
  })

  it("gives no run the credentials of a shared cache the workspace declares, so it is off in every mode", async () => {
    const recording = recordingSmthrs()
    const root = keep(makeOwnWith(recording.command))
    await withSecrets(() => onNode(own(request(root, { targets: ["//:c"] }), partsFor("none"), "WORKSPACE.ts")))
    const log = [...recording.plans(), ...recording.log()]
    expect(log).toHaveLength(3)
    for (const line of log) expect(line.startsWith("url= tokens=[][][] ci //:c ")).toBe(true)
  })

  it("reads no cache in the baseline's first pass only: its reruns reuse what that pass built", async () => {
    const recording = recordingSmthrs()
    const root = keep(makeOwnWith(recording.command, { "a.sh": "exit 1\n" }))
    const report = await onNode(own(request(root, { targets: ["//:a", "//:c"] }), partsFor("none"), "WORKSPACE.ts"))
    expect(report.commits[0]?.baseline.counts).toEqual({ hit: 0, ran: 1, failed: 1, skipped: 0 })
    expect(report.commits[0]?.mismatches).toEqual([])
    const commands = recording.log().map((line) => line.slice(line.indexOf(" ci ") + 1))
    expect(commands).toHaveLength(4)
    expect(commands[0]).toMatch(/^ci \/\/:a \/\/:c --workspace \S+ --cache-dir \.flows --no-cache --results-file/)
    expect(commands[1]).toMatch(/^ci \/\/:a --workspace \S+ --cache-dir \.flows --results-file/)
    expect(commands[2]).toMatch(/^ci \/\/:a \/\/:c --workspace \S+ --cache-dir \.flows --results-file/)
    expect(commands[3]).toMatch(/^ci \/\/:a --workspace \S+ --cache-dir \.flows --results-file/)
  })

  it("names a target that runs again though its key did not change", async () => {
    const root = keep(makeOwnWith(smthrs, { "PACKAGE.ts": packageWithUncached, "u.sh": "exit 0\n" }))
    const second = commit(root, "change the docs", { "docs.sh": "# changed\nexit 0\n" })
    const report = await onNode(
      own(request(root, { commits: 2, targets: ["//..."] }), partsFor("none"), "WORKSPACE.ts")
    )
    // Nothing a target reads changed, yet the target Smithers build does not cache runs at the second commit too.
    expect(report.commits[1]?.normal.counts).toEqual({ hit: 3, ran: 1, failed: 0, skipped: 0 })
    expect(report.mismatches).toBe(0)
    expect(said).toContain(
      `2/2 ${second.slice(0, 7)} normal: 1 ran again though its key did not change: //:u`
    )
  })

  it("names to smthrs only targets the patterns select, in fast mode: what they depend on runs with them", async () => {
    const recording = recordingSmthrs()
    const root = keep(makeOwnWith(recording.command))
    // The scorer keeps a, which b depends on and no pattern selects, and judges b safe to skip.
    const parts = { ...partsFor("none"), score: scoreKeeping("//:a", "none") }
    const asked = request(root, { modes: ["fast"], targets: ["//:b"], settings: { scoreCutoff: 0.5, countCutoff: 0 } })
    const report = await onNode(own(asked, parts, "WORKSPACE.ts"))
    expect(report.commits[0]?.normal.counts).toEqual({ hit: 0, ran: 2, failed: 0, skipped: 0 })
    expect(report.commits[0]?.fast?.counts).toEqual({ hit: 0, ran: 0, failed: 0, skipped: 2 })
    // The baseline and normal mode ran; fast mode had nothing to name. The plans are the one that finds what the
    // commit installs and the one fast mode scores.
    const commands = recording.log()
    expect(commands).toHaveLength(2)
    expect(recording.plans()).toHaveLength(2)
    expect(commands.some((line) => line.includes(" ci //:a "))).toBe(false)
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
  })

  it("is unsupported, with the reason, when no commit can be installed", async () => {
    const root = keep(repository({ ...ownFiles(), "tools/install.mjs": "process.exit(1)\n" }))
    const failure = await failureOf(onNode(own(request(root), partsFor("none"), "WORKSPACE.ts")))
    expect(failure).toEqual({
      code: "unsupported",
      part: "replay",
      message: refusedAt(
        head(root).slice(0, 7),
        "(install)",
        "npm ci --no-audit --no-fund exited 1 in the repository root"
      )
    })
  })

  it("is unsupported, with the reason smthrs printed, when no target passes on this machine", async () => {
    const missing = `host binary "go" is declared in S.Host({ bins }) but is not present on PATH`
    const old = fakeSmthrs(
      [
        `echo '//:a  failed  1ms  ${missing}'`,
        `echo '{"ok":false,"counts":{"hit":0,"ran":0,"failed":1,"skipped":1},"results":[{"label":"//:a","status":"failed","key":"k","durationMs":1},{"label":"//:b","status":"skipped","key":"k","durationMs":0}]}' > "$results"`,
        "exit 1"
      ].join("\n")
    )
    const root = keep(makeOwnWith(old))
    const failure = await failureOf(onNode(own(request(root), partsFor("none"), "WORKSPACE.ts")))
    expect(failure).toEqual({
      code: "unsupported",
      part: "replay",
      message: refusedAt(head(root).slice(0, 7), "//:a", missing)
    })
  })

  it("is unsupported when the patterns select no target", async () => {
    const none = fakeSmthrs(
      `echo '{"ok":true,"counts":{"hit":0,"ran":0,"failed":0,"skipped":0},"results":[]}' > "$results"`
    )
    const root = keep(makeOwnWith(none))
    const failure = await failureOf(onNode(own(request(root), partsFor("none"), "WORKSPACE.ts")))
    expect(failure.code).toBe("unsupported")
    expect(failure.message).toContain("the patterns selected nothing that ran")
  })

  it("is unsupported, with what smthrs printed, when it writes no run record at any commit", async () => {
    const root = keep(makeOwnWith(fakeSmthrs(`echo "code: no_package"; echo "message: no package at //:c"; exit 1`)))
    const failure = await failureOf(onNode(own(request(root), partsFor("none"), "WORKSPACE.ts")))
    expect(failure).toEqual({
      code: "unsupported",
      part: "replay",
      message: refusedAt(head(root).slice(0, 7), "(smthrs)", "no package at //:c")
    })
  })

  it("counts a run record that is not one as no run record", async () => {
    const root = keep(makeOwnWith(fakeSmthrs(`echo '{"ok":' > "$results"`)))
    const failure = await failureOf(onNode(own(request(root), partsFor("none"), "WORKSPACE.ts")))
    expect(failure.code).toBe("unsupported")
    expect(failure.message).toContain("  step     (smthrs)\n  error    smthrs ci wrote no run record")
  })

  it("reports a commit smthrs cannot plan as failed in both modes, and goes on", async () => {
    // The first commit has the install and no workspace yet; the second adds the workspace and its targets.
    const { "WORKSPACE.ts": workspaceText, "PACKAGE.ts": packageText, ...before } = ownFiles()
    const root = keep(repository(before))
    commit(root, "add the workspace", { "WORKSPACE.ts": workspaceText ?? "", "PACKAGE.ts": packageText ?? "" })
    const report = await onNode(own(request(root, { commits: 2 }), partsFor("none"), "WORKSPACE.ts"))
    for (const totals of [report.commits[0]?.baseline, report.commits[0]?.normal]) {
      expect(totals).toMatchObject({ ok: false, counts: { hit: 0, ran: 0, failed: 1, skipped: 0 } })
    }
    expect(report.commits[1]?.baseline.counts).toEqual({ hit: 0, ran: 3, failed: 0, skipped: 0 })
    expect(report.commits[1]?.normal.counts).toEqual({ hit: 0, ran: 3, failed: 0, skipped: 0 })
    expect(report.mismatches).toBe(0)
    expect(said.some((line) => /^1\/2 \w{7} baseline: \(smthrs\) failed: \S/.test(line))).toBe(true)
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

describe("the replay part for any repository", { timeout: 120_000 }, () => {
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
    // A workspace file no commit holds does not count: a replay runs commits.
    for (const root of [plain, converted, uncommitted, keep(temporary("empty"))]) {
      expect(await onNode(committedWorkspace(root))).toBeUndefined()
      expect((await onNode(run(generic)(request(root, { commits: 4 }), partsFor("none")))).repository).toBe("generic 4")
    }
  })

  it("refuses patterns for a repository that has no workspace of its own", async () => {
    const plain = keep(repository({ "README.md": "plain\n" }))
    const failure = await failureOf(onNode(run(generic)(request(plain, { targets: ["//:a"] }), partsFor("none"))))
    expect(failure).toEqual({
      code: "unsupported",
      part: "replay",
      message:
        "--targets names Smithers build patterns, and this repository has no Smithers workspace of its own (.smithers/WORKSPACE.ts or WORKSPACE.ts)"
    })
  })

  it("sends every repository to the generic replay when git cannot be started", async () => {
    const root = keep(makeOwnWith("true"))
    expect(await onNode(Effect.provide(committedWorkspace(root), cannotStart("git")))).toBeUndefined()
  })

  it("marks the result of a failed install with a label no target has", () => {
    expect(installLabel.startsWith("//")).toBe(false)
  })
})
