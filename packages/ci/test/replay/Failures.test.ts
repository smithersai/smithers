import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner, make as makeSpawner } from "effect/process/ChildProcessSpawner"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { basename, join, relative } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Failure, ReplayParts, ReplayRequest } from "../../src/contract/Parts.vibe"
import type { ReplayReport } from "../../src/contract/ReplayReport.vibe"
import { path as targetMapPath, type TargetMap } from "../../src/contract/TargetMap.vibe"
import { generatedMark } from "../../src/native/Workspace.vibe"
import { Options, Progress, run } from "../../src/replay/index.vibe"
import { probe } from "../../src/replay/Jail.ts"
import { cannotRecord } from "../../src/replay/Reads.vibe"
import {
  job,
  linkTargets,
  makeEmptyDirectory,
  makeEmptyRepository,
  makeSmallRepository,
  recordingSmthrs,
  smthrs
} from "./fixture.ts"
import { unconfined } from "./place.ts"
import {
  generated,
  gitFails,
  noGeneratedWrites,
  noTemporaryDirectories,
  noWrites,
  options,
  parts,
  workspacePath
} from "./TestParts.vibe"

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
const request = (root: string, extra: Partial<ReplayRequest> = {}): ReplayRequest => ({
  root,
  commits: 1,
  modes: ["normal"],
  ...extra
})

// A command the test wrote in the temporary directory, which records there: it runs with no jail.
const withCommand = (command: string) =>
  Layer.succeed(Options, {
    smthrs: [command],
    reruns: 1,
    prepare: (directory) => Effect.sync(() => linkTargets(directory)),
    confine: unconfined
  })

const withSmthrs = (command: string) =>
  Layer.succeed(Options, { smthrs: [command], reruns: 1, prepare: () => Effect.void, confine: unconfined })

const replay = (
  root: string,
  overrides: Partial<Parts> = {},
  extra: Partial<ReplayRequest> = {},
  host: Layer.Layer<never, never, never> = options as never
): Promise<ReplayReport> =>
  Effect.runPromise(
    run(request(root, extra), { ...base, ...overrides }).pipe(
      Effect.provide(Layer.provideMerge(host, NodeServices.layer))
    ) as Effect.Effect<ReplayReport, Failure>
  )

const failureOf = (attempt: Promise<ReplayReport>): Promise<Failure> =>
  attempt.then(
    () => {
      throw new Error("the replay succeeded")
    },
    (cause: { readonly message: string }) => JSON.parse(JSON.stringify(cause)) as Failure
  )

const passing = [job("a", "sh a.sh")]

describe("a replay that cannot run", () => {
  it("refuses a directory that is not a repository", async () => {
    const failure = await failureOf(replay(track(makeEmptyDirectory())))
    expect(failure).toMatchObject({ code: "not-a-repository", part: "replay" })
  })

  it("says in one sentence that a repository with no commit has nothing to replay", async () => {
    const root = track(makeEmptyRepository())
    expect(await failureOf(replay(root))).toEqual({
      code: "not-a-repository",
      part: "replay",
      message: `${root} is a git repository with no commit to replay`
    })
  })

  it("is unsupported when no job runs on a change", async () => {
    const root = track(makeSmallRepository([{ ...job("nightly", "exit 0"), triggers: ["schedule"] }]))
    expect(await failureOf(replay(root))).toMatchObject({
      code: "unsupported",
      part: "replay",
      message: "no job runs on a push or a pull request, and the repository root has no `ci` recipe or script"
    })
  })

  it("refuses jobs that need each other", async () => {
    const root = track(makeSmallRepository([job("a", "true", { needs: ["b"] }), job("b", "true", { needs: ["a"] })]))
    const failure = await failureOf(replay(root))
    expect(failure.code).toBe("invalid-document")
    expect(failure.message).toContain("job a")
  })

  it("refuses generated files with no target map", async () => {
    const root = track(makeSmallRepository(passing))
    const failure = await failureOf(replay(root, { files: () => Effect.succeed([]) }))
    expect(failure.code).toBe("invalid-document")
    expect(failure.message).toContain(targetMapPath)
  })

  it("refuses generated files with no workspace file", async () => {
    const root = track(makeSmallRepository(passing))
    const files: Parts["files"] = (inventory) =>
      Effect.succeed(generated(inventory).filter((file) => file.path !== workspacePath))
    expect(await failureOf(replay(root, { files }))).toEqual({
      code: "invalid-document",
      part: "replay",
      message: "the generated files have no workspace file"
    })
  })

  it("refuses a target map it cannot read", async () => {
    const root = track(makeSmallRepository(passing))
    const files: Parts["files"] = () => Effect.succeed([{ path: targetMapPath, content: "{" }])
    expect(await failureOf(replay(root, { files }))).toMatchObject({ code: "invalid-document" })
  })

  it("is unsupported when no step has a target", async () => {
    const root = track(makeSmallRepository(passing))
    const files: Parts["files"] = (inventory) => Effect.succeed(generated(inventory, () => false))
    expect(await failureOf(replay(root, { files }))).toEqual({
      code: "unsupported",
      part: "replay",
      message:
        "no CI step that runs on a change has a target on this machine\n  a  has a step Smithers CI could not turn into a build step"
    })
  })

  it("refuses a generated file outside the repository and writes nothing there", async () => {
    const root = track(makeSmallRepository(passing))
    const name = `escaped-${created.length}`
    const files: Parts["files"] = (inventory) =>
      Effect.succeed([...generated(inventory), { path: `../../../../../../../../tmp/${name}`, content: "x" }])
    const failure = await failureOf(replay(root, { files }))
    expect(failure).toMatchObject({ code: "unsupported", part: "replay" })
    expect(failure.message).toContain("outside the repository")
    expect(existsSync(join("/tmp", name))).toBe(false)
  })

  it(
    "does not replay a commit that holds a link where a generated file goes, and writes nothing through it",
    async () => {
      // Review finding 5, in a replay's copy: an older commit can hold a link the newest commit does not.
      const root = track(makeSmallRepository(passing))
      const outside = track(join(root, "..", `outside-${basename(root)}`))
      const commit = (message: string): void => {
        execFileSync("git", ["-C", root, "add", "-A"])
        execFileSync("git", [
          "-C",
          root,
          "-c",
          "user.name=Replay",
          "-c",
          "user.email=replay@example.com",
          "commit",
          "-qm",
          message
        ])
      }
      symlinkSync(outside, join(root, "PACKAGE.ts"))
      commit("a link where PACKAGE.ts goes")
      rmSync(join(root, "PACKAGE.ts"))
      commit("the link is gone")
      const report = await replay(root, {}, { commits: 2 })
      expect(report.commits).toHaveLength(1)
      expect(report.notReplayedCommits?.map((entry) => entry.reason)).toEqual([
        `PACKAGE.ts is a link to ${outside}, which does not exist`
      ])
      expect(existsSync(outside)).toBe(false)
    },
    600_000
  )

  it("replays a commit that holds the files of an earlier apply, as apply would leave it", async () => {
    const root = track(makeSmallRepository(passing))
    const git = (...args: ReadonlyArray<string>) => execFileSync("git", args, { cwd: root, stdio: "pipe" })
    // The root package as an earlier smithers-ci wrote it: Smithers build refuses it beside the generated workspace.
    writeFileSync(join(root, "PACKAGE.ts"), "// Generated by smithers-ci. Do not edit.\nexport const Package = 1\n")
    git("add", "-A")
    git("-c", "user.name=Replay", "-c", "user.email=replay@example.com", "commit", "-qm", "an earlier apply")
    // The run as `apply` leaves the repository removes that file too, as `apply` does.
    const report = await replay(root, {}, { applied: true })
    expect(report.commits).toHaveLength(1)
    expect(report.mismatches).toBe(0)
    expect(report.commits[0]?.normal.ok).toBe(true)
    // The repository itself is as it was.
    expect(existsSync(join(root, "PACKAGE.ts"))).toBe(true)
  }, 600_000)

  it("passes a step that fails beside a generated file: no copy holds one", async () => {
    const root = track(makeSmallRepository([job("a", "sh seen.sh")]))
    // A spell checker told to read dot directories: it passes on a fresh clone and would fail on a generated file.
    writeFileSync(
      join(root, "seen.sh"),
      `if [ -e .smithers ] || [ -e .flows ]; then\n  echo "${workspacePath}:2:19 - Unknown word (smthrs)"\n  exit 1\nfi\n`
    )
    execFileSync("git", ["add", "-A"], { cwd: root })
    execFileSync("git", ["-c", "user.name=Replay", "-c", "user.email=replay@example.com", "commit", "-qm", "check"], {
      cwd: root
    })
    const report = await replay(root)
    expect(report.mismatches).toBe(0)
    expect(report.commits[0]?.baseline).toMatchObject({ ok: true, counts: { ran: 1 } })
    expect(report.commits[0]?.normal).toMatchObject({ ok: true, counts: { ran: 1 } })
  }, 600_000)

  it("says which tool read a file apply writes: the newest commit runs once more as apply leaves it", async () => {
    // A third step reads neither: it passes with the generated files committed too.
    const root = track(makeSmallRepository([job("a", "sh seen.sh"), job("b", "sh quiet.sh"), job("c", "sh a.sh")]))
    // A spell checker told to read dot directories: it passes on a fresh clone and fails on the generated workspace.
    writeFileSync(
      join(root, "seen.sh"),
      `if [ -e ${workspacePath} ]; then\n  echo "${workspacePath}:2:19 - Unknown word (smthrs)"\n  exit 1\nfi\n`
    )
    // A step that fails beside the generated files and names none of them failed for a reason of its own.
    writeFileSync(join(root, "quiet.sh"), "test ! -e .smithers\n")
    const commit = (message: string): void => {
      execFileSync("git", ["add", "-A"], { cwd: root })
      execFileSync("git", ["-c", "user.name=Replay", "-c", "user.email=replay@example.com", "commit", "-qm", message], {
        cwd: root
      })
    }
    commit("two checks")
    writeFileSync(join(root, "b.txt"), "b\n")
    commit("another file")
    // Each step's target may read the whole repository, as a generated target that names no inputs may.
    const reading: Parts["files"] = (inventory) =>
      Effect.succeed(
        generated(inventory).map((file) =>
          file.path === workspacePath
            ? { ...file, content: file.content.replace(/S\.file\("\/\/(seen|quiet)\.sh"\)/g, `S.glob("//**")`) }
            : file
        )
      )
    const said: Array<string> = []
    const progress = Layer.succeed(Progress, { say: (line) => Effect.sync(() => void said.push(line)) })
    const asked = { commits: 2, applied: true }
    const report = await replay(root, { files: reading }, asked, Layer.merge(options, progress) as never)
    expect(report.commits).toHaveLength(2)
    // No copy a way runs in holds a generated file: both steps pass in the baseline and in normal mode.
    for (const commit of report.commits) {
      expect(commit.baseline).toMatchObject({ ok: true, counts: { failed: 0 } })
      expect(commit.normal).toMatchObject({ ok: true, counts: { failed: 0 } })
    }
    // The older commit is not the one `apply` is run on.
    expect(report.commits[0]?.mismatches).toEqual([])
    expect(report.commits[1]?.mismatches).toEqual([
      {
        label: "//:a0_0",
        mode: "normal",
        baseline: "pass",
        got: "fail",
        cause:
          `cspell read ${workspacePath}, which Smithers CI wrote. Add .smithers to "ignorePaths" in the cspell configuration.`
      },
      // A step that names none of the files is told what happened, and which files.
      {
        label: "//:b0_0",
        mode: "normal",
        baseline: "pass",
        got: "fail",
        cause:
          `This step passes on the commit's files and fails once the files smithers-ci apply writes are committed: ${workspacePath}.`
      }
    ])
    expect(report.mismatches).toBe(2)
    expect(said.filter((line) => line.endsWith("with the files apply writes"))).toHaveLength(1)
    expect(said.at(-1)).toMatch(/^2\/2 [0-9a-f]{7} with the files apply writes$/)
    // The run's time is its own number, beside the ways' times.
    expect(report.appliedMs).toBeGreaterThan(0)

    // Not asked for, the run does not happen: every step passes, and nothing more is said.
    said.length = 0
    const plain = await replay(root, { files: reading }, { commits: 2 }, Layer.merge(options, progress) as never)
    expect(plain.mismatches).toBe(0)
    expect(plain.appliedMs).toBeUndefined()
    expect(said.filter((line) => line.endsWith("with the files apply writes"))).toEqual([])
    // The repository itself is as it was.
    expect(existsSync(join(root, ".smithers"))).toBe(false)
  }, 900_000)

  it.each(["identical", "different", "obsolete"])(
    "checks a commit with %s generated files as apply would",
    async (state) => {
      const root = track(makeSmallRepository(passing))
      // The generated workspace file, as `apply` wrote it and a person committed it.
      let content = ""
      const files: Parts["files"] = (inventory) =>
        Effect.sync(() => {
          return generated(inventory).map((file) => {
            if (file.path !== workspacePath) return file
            content = `${generatedMark} Do not edit.\n${file.content}`
            return { ...file, content }
          })
        })
      await replay(root, { files })
      mkdirSync(join(root, ".smithers"))
      writeFileSync(join(root, workspacePath), state === "different" ? `${content}\n// old version\n` : content)
      if (state === "obsolete") {
        mkdirSync(join(root, ".smithers", "ci"))
        writeFileSync(
          join(root, ".smithers", "ci", "NOT-REPRODUCED.md"),
          "# Earlier notes\n\nGenerated by smithers-ci.\n"
        )
      }
      execFileSync("git", ["add", "-A"], { cwd: root })
      execFileSync("git", ["-c", "user.name=Replay", "-c", "user.email=replay@example.com", "commit", "-qm", "apply"], {
        cwd: root
      })
      const said: Array<string> = []
      const progress = Layer.succeed(Progress, { say: (line) => Effect.sync(() => void said.push(line)) })
      const report = await replay(root, { files }, { applied: true }, Layer.merge(options, progress) as never)
      expect(report.mismatches).toBe(0)
      if (state === "identical") expect(report.appliedMs).toBeUndefined()
      else expect(report.appliedMs).toBeGreaterThan(0)
      expect(report.commits[0]?.normal).toMatchObject({ ok: true, counts: { ran: 1 } })
      const phases = said.filter((line) => /^1\/1 /.test(line)).map((line) => line.replace(/^1\/1 [0-9a-f]{7} /, ""))
      expect(phases).toEqual(
        state === "identical" ? ["baseline", "normal"] : ["baseline", "normal", "with the files apply writes"]
      )
    },
    900_000
  )

  it("preserves the date of an applied commit with an empty committer name and email", async () => {
    const root = track(makeSmallRepository(passing))
    const date = "2024-01-02T03:04:05+00:00"
    let amended: Readonly<Record<string, unknown>> = {}
    const metadata = Layer.effect(
      ChildProcessSpawner,
      Effect.map(ChildProcessSpawner, (real) =>
        makeSpawner((command) => {
          if (command._tag === "StandardCommand") {
            if (command.args.includes("--format=%cn%n%ce%n%cI")) {
              return real.spawn(ChildProcess.make("printf", ["\\n\\n%s\\n", date]))
            }
            if (command.args.includes("--amend")) amended = command.options.env ?? {}
          }
          return real.spawn(command)
        }))
    )
    const report = await replay(root, {}, { applied: true }, Layer.merge(options, metadata) as never)
    expect(report.appliedMs).toBeGreaterThan(0)
    expect(amended).toMatchObject({
      GIT_COMMITTER_NAME: "Replay",
      GIT_COMMITTER_EMAIL: "replay@localhost",
      GIT_COMMITTER_DATE: date
    })
  }, 120_000)

  it("has nothing to run as apply leaves the repository when no step passes", async () => {
    const root = track(makeSmallRepository(passing))
    writeFileSync(join(root, "a.sh"), "exit 1\n")
    execFileSync("git", ["-c", "user.name=Replay", "-c", "user.email=replay@example.com", "commit", "-qam", "broken"], {
      cwd: root
    })
    const said: Array<string> = []
    const progress = Layer.succeed(Progress, { say: (line) => Effect.sync(() => void said.push(line)) })
    const failure = await failureOf(replay(root, {}, { applied: true }, Layer.merge(options, progress) as never))
    expect(failure.code).toBe("unsupported")
    expect(said.filter((line) => line.endsWith("with the files apply writes"))).toEqual([])
  }, 600_000)

  it("reports a Smithers build that cannot start", async () => {
    const root = track(makeSmallRepository(passing))
    const failure = await failureOf(replay(root, {}, {}, withSmthrs("/no/such/smthrs") as never))
    expect(failure.code).toBe("command-failed")
    expect(failure.message).toContain("could not run /no/such/smthrs")
  })

  it("rejects a passing record from a command that exited with a failure", async () => {
    const root = track(makeSmallRepository(passing))
    const command = join(track(makeEmptyDirectory()), "smthrs")
    writeFileSync(command, `#!/bin/sh\n"${smthrs}" "$@" || exit $?\nexit 19\n`, { mode: 0o755 })
    const result = await failureOf(replay(root, {}, {}, withCommand(command) as never))
    expect(result.message).toContain("exited 19 with a passing run record")
  }, 120_000)

  it("reports a Smithers build that writes no run record", async () => {
    const root = track(makeSmallRepository(passing))
    const failure = await failureOf(replay(root, {}, {}, withSmthrs("true") as never))
    expect(failure.code).toBe("command-failed")
    expect(failure.message).toContain("wrote no run record")
  })

  it("reports a workspace Smithers build cannot load, with its reason", async () => {
    const broken: Parts["files"] = (inventory) =>
      Effect.succeed(
        generated(inventory).map((file) =>
          file.path === workspacePath ? { ...file, content: `${file.content}export const Root = Package\n` } : file
        )
      )
    const failure = await failureOf(replay(track(makeSmallRepository(passing)), { files: broken }))
    expect(failure.code).toBe("command-failed")
    expect(failure.message).toContain("wrote no run record")
    expect(failure.message).toContain("ci_failed")
  }, 600_000)

  it("reports a git command that fails, with what git said", async () => {
    const root = track(makeSmallRepository(passing))
    const failure = await failureOf(replay(root, {}, {}, gitFails("clean") as never))
    expect(failure).toEqual({
      code: "command-failed",
      part: "replay",
      message: "git clean failed: fatal: bad object\n"
    })
  })

  it.skipIf("refusal" in probe())("refuses to run steps after a probed job keeper exits before readiness", async () => {
    const root = track(makeSmallRepository(passing))
    const lostKeeper = Layer.effect(
      ChildProcessSpawner,
      Effect.map(
        ChildProcessSpawner,
        (real) =>
          makeSpawner((command) =>
            command._tag === "StandardCommand" && /\/jobs\/[^/]+\/job-[^/]+$/.test(String(command.options.cwd))
              ? real.spawn(ChildProcess.make("/bin/true", []))
              : real.spawn(command)
          )
      )
    )
    const host = Layer.succeed(Options, {
      smthrs: [smthrs],
      reruns: 0,
      prepare: (checkout) => Effect.sync(() => linkTargets(checkout))
    })
    const result = await failureOf(replay(root, {}, {}, Layer.merge(host, lostKeeper) as never))
    expect(result.message).toContain("the keeper of a job ended before accepting steps")
  }, 120_000)

  it("reports a temporary directory it cannot make", async () => {
    const root = track(makeSmallRepository(passing))
    const failure = await failureOf(replay(root, {}, {}, noTemporaryDirectories as never))
    expect(failure.code).toBe("command-failed")
    expect(failure.message).toContain("could not make a directory")
  })

  it("reports a generated file it cannot write", async () => {
    const root = track(makeSmallRepository(passing))
    const failure = await failureOf(replay(root, {}, {}, noGeneratedWrites as never))
    expect(failure.code).toBe("command-failed")
    expect(failure.message).toContain(`could not write ${workspacePath}`)
  })

  it("reports a write failure while preparing the steps' confinement", async () => {
    const root = track(makeSmallRepository(passing))
    const failure = await failureOf(replay(root, {}, {}, noWrites as never))
    expect(failure.code).toBe("command-failed")
    expect(failure.message).toContain("could not prepare replay confinement")
    expect(failure.message).toContain("PermissionDenied")
  })
})

describe("a replay that runs", () => {
  it("accepts a root relative to the working directory", async () => {
    const root = track(makeSmallRepository(passing))
    const report = await replay(relative(process.cwd(), root), {}, { commits: 0 })
    expect(report.commits).toEqual([])
  })

  it("does not wait for a process a step leaves running", async () => {
    // The process outlives this test, so waiting for its pipe to close would time the test out.
    const root = track(makeSmallRepository([job("x", "sleep 240 & exit 0"), ...passing]))
    // Only the baseline runs the step: the target map names the other job's target for it.
    const files: Parts["files"] = (inventory) =>
      Effect.succeed(
        generated(inventory).map((file) => {
          if (file.path !== targetMapPath) return file
          const map = JSON.parse(file.content) as TargetMap
          const targets = map.targets.map((entry) => entry.step === "x0" ? { ...entry, label: "//:a0_0" } : entry)
          return { ...file, content: JSON.stringify({ ...map, targets }) }
        })
      )
    const report = await replay(root, { files })
    expect(report.commits[0]?.baseline.counts).toEqual({ hit: 0, ran: 2, failed: 0, skipped: 0 })
    expect(report.commits[0]?.normal.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
    expect(report.mismatches).toBe(0)
  }, 600_000)

  it("uses the default fast-mode settings when the request gives none, and gives rows the commit's plan", async () => {
    const root = track(makeSmallRepository(passing))
    const planned: Array<ReadonlyArray<string>> = []
    const rows: Parts["rows"] = (repository, record, plan) => {
      planned.push(plan?.targets.map((target) => target.label) ?? [])
      return base.rows(repository, record)
    }
    // A score of 0 is under every cutoff, but the default keeps the five highest-scoring targets.
    const report = await replay(root, { rows }, { modes: ["normal", "fast"] })
    expect(report.commits[0]?.fast?.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
    expect(report.selection).toMatchObject({ rows: 1, selected: 1 })
    expect(planned).toEqual([["//:a0_0"]])
  }, 600_000)

  it("says once when Smithers build reports that it cannot record what a step reads", async () => {
    const recording = recordingSmthrs(
      false,
      "smthrs: reads are not observed on this host: no tracer; a target that asks for it is keyed by its declared inputs"
    )
    track(recording.directory)
    const said: Array<string> = []
    const progress = Layer.succeed(Progress, { say: (line) => Effect.sync(() => void said.push(line)) })
    await replay(
      track(makeSmallRepository(passing)),
      {},
      { commits: 1 },
      Layer.merge(
        withCommand(recording.command),
        progress
      ) as never
    )
    expect(said.filter((line) => line.startsWith("this machine cannot record"))).toEqual([cannotRecord("no tracer")])
  }, 600_000)

  it("never runs more targets at once than the target map allows", async () => {
    const root = track(makeSmallRepository(passing))
    const recording = recordingSmthrs(false)
    track(recording.directory)
    const files: Parts["files"] = (inventory) =>
      Effect.succeed(
        generated(inventory).map((file) =>
          file.path === targetMapPath ? { ...file, content: file.content.replace("{", `{"maxJobs":1,`) } : file
        )
      )
    await replay(root, { files }, { jobs: 8 }, withCommand(recording.command) as never)
    expect(recording.commands().filter((line) => line.startsWith("ci ")).every((line) => line.endsWith("--jobs 1")))
      .toBe(true)
  }, 600_000)

  it("reports a plan Smithers build did not print", async () => {
    const root = track(makeSmallRepository(passing))
    const recording = recordingSmthrs(true)
    track(recording.directory)
    const failure = await failureOf(
      replay(root, {}, { modes: ["normal", "fast"] }, withCommand(recording.command) as never)
    )
    expect(failure.code).toBe("command-failed")
    expect(failure.message).toContain("printed no plan")
  }, 600_000)

  it("does not replay a job with a step that has no target, nor a job that needs it, and lists both", async () => {
    const out = track(makeEmptyDirectory())
    const root = track(makeSmallRepository([
      job("x", `touch ${out}/x-ran`, { more: ["sh a.sh"] }),
      job("after", `touch ${out}/after-ran`, { needs: ["x"] }),
      job("y", "sh a.sh")
    ]))
    const recording = recordingSmthrs(false)
    track(recording.directory)
    const files: Parts["files"] = (inventory) => Effect.succeed(generated(inventory, (entry) => entry.step !== "x0"))
    const report = await replay(root, { files }, {}, withCommand(recording.command) as never)
    // Review finding 8: the step ran and was timed in the baseline only, and its failure was in no count.
    expect(existsSync(join(out, "x-ran"))).toBe(false)
    expect(existsSync(join(out, "after-ran"))).toBe(false)
    expect(report.commits[0]?.baseline.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
    expect(report.commits[0]?.normal.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
    expect(recording.commands().filter((line) => line.startsWith("ci "))[0]).toMatch(/^ci \/\/:y0_0 --workspace /)
    expect(report.notReplayed).toEqual([
      { job: "x", reasons: [{ feature: "no-target", detail: "x0 has no target" }] },
      { job: "after", reasons: [{ feature: "needs", detail: "after needs x, which is not replayed" }] }
    ])
  }, 600_000)

  it("does not run a job for another operating system, in the baseline or as a target, and lists it", async () => {
    const out = track(makeEmptyDirectory())
    const elsewhere = process.platform === "darwin" ? "ubuntu-latest" : "macos-latest"
    const here = process.platform === "darwin" ? "macos-latest" : "ubuntu-latest"
    const both = {
      ...job("both", `touch ${out}/\${{ matrix.os }}`),
      runsOn: "${{ matrix.os }}",
      matrix: [{ os: here }, { os: elsewhere }]
    }
    const root = track(makeSmallRepository([both, { ...job("other", `touch ${out}/other`), runsOn: elsewhere }]))
    const recording = recordingSmthrs(false)
    track(recording.directory)
    const report = await replay(root, {}, {}, withCommand(recording.command) as never)
    // Review finding 11: the baseline ran the other system's variant here, and Smithers build then refused its target.
    expect(readdirSync(out)).toEqual([here])
    expect(report.commits[0]?.baseline.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
    expect(recording.commands().filter((line) => line.startsWith("ci "))[0]).toMatch(/^ci \/\/:both0_0 --workspace /)
    const system = process.platform === "darwin" ? "linux" : "darwin"
    expect(report.notReplayed).toEqual([
      {
        job: "both",
        reasons: [{
          feature: "other-system",
          detail: `both (os=${elsewhere}) runs on ${system}; this machine is ${process.platform}`
        }]
      },
      {
        job: "other",
        reasons: [{ feature: "other-system", detail: `other runs on ${system}; this machine is ${process.platform}` }]
      }
    ])
  }, 600_000)

  it("lists a job with no command and a file that was not read, beside the jobs it replays", async () => {
    const upload = { feature: "host-action", detail: "ci.yml: actions/upload-artifact@v4 has no command to run" }
    const root = track(
      makeSmallRepository([...passing, { ...job("package", "true"), steps: [], unsupported: [upload] }])
    )
    const unread = { feature: "malformed-file", detail: ".github/workflows/tests.yml: BAD_INDENT at line 3" }
    const read: Parts["read"] = (copy) =>
      Effect.map(base.read(copy), (inventory) => ({ ...inventory, unsupported: [unread] }))
    const report = await replay(root, { read })
    // Review finding 15: the report read as covering the whole CI; one of two jobs ran and a workflow was not read.
    expect(report.commits[0]?.baseline.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 0 })
    expect(report.notReplayed).toEqual([
      { job: "package", reasons: [{ feature: "no-command", detail: "package has no command to run" }] }
    ])
    expect(report.notRead).toEqual([unread])
    expect(report.flaky).toBe(0)
  }, 600_000)

  it("fails a step whose directory is missing, without stopping the replay, and reports the mismatch", async () => {
    const root = track(makeSmallRepository([job("a", "sh a.sh", { cwd: "gone" }), job("ok", "sh a.sh")]))
    const report = await replay(root, {}, { cache: "http://127.0.0.1:9" })
    const [commit] = report.commits
    expect(commit?.baseline.counts).toEqual({ hit: 0, ran: 1, failed: 1, skipped: 0 })
    expect(commit?.normal.ok).toBe(true)
    expect(commit?.mismatches).toEqual([{ label: "//:a0_0", mode: "normal", baseline: "fail", got: "pass" }])
  }, 600_000)
})
