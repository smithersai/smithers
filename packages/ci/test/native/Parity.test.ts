/**
 * What the docs promise of every replay, held for a repository's own targets:
 * real repositories with their own `WORKSPACE.ts` and `PACKAGE.ts`, the real
 * `smthrs`, and a faulty service only where a failure is needed.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import type { Failure, ReplayParts, ReplayRequest } from "../../src/contract/Parts.vibe"
import { ReplayReport } from "../../src/contract/ReplayReport.vibe"
import { read } from "../../src/inventory/index.vibe"
import { type Host, own } from "../../src/native/index.vibe"
import { Options, type Probe, Progress } from "../../src/replay/index.vibe"
import { probe } from "../../src/replay/Jail.ts"
import { unavailable } from "../../src/select/Failure.vibe"
import { score } from "../../src/select/index.vibe"
import { unconfined } from "../replay/place.ts"
import { modelFailingAfter, rowsOfEachCommit } from "../replay/TestParts.vibe"
import { hour, jumping } from "../replay/WallClock.vibe"
import {
  installScript,
  lockfile,
  makeOwnWith,
  manifest,
  ownFiles,
  packageOf,
  packageWithOpenTarget,
  smthrs,
  workflowFor,
  workspace
} from "./own.ts"
import { commit, git, repository, temporary } from "./repo.ts"
import { rows, scoreKeeping } from "./support.vibe"

const made: Array<string> = []
const keep = (root: string): string => {
  made.push(root)
  return root
}
afterAll(() => made.forEach((root) => rmSync(root, { recursive: true, force: true })))

type Parts = ReplayParts<Host>

const said: Array<string> = []
beforeEach(() => {
  said.length = 0
})

const never = () => Effect.fail({ code: "invalid-document", message: "nothing may be generated", part: "generate" })
const partsFor = (first: string): Parts => ({
  read,
  files: never as never,
  rows,
  score: scoreKeeping("//:c", first)
})

interface Machine {
  readonly confine?: () => Probe
  readonly stepTimeout?: Duration.Input
}

const hostWith = (machine: Machine) =>
  Layer.mergeAll(
    Layer.succeed(Options, { smthrs: [smthrs], reruns: 1, prepare: () => Effect.void, ...machine }),
    Layer.succeed(Progress, { say: (line) => Effect.sync(() => void said.push(line)) })
  )

const replay = (
  work: Effect.Effect<ReplayReport, Failure, never>,
  machine: Machine = {},
  extra: Layer.Layer<never> = Layer.empty
): Promise<ReplayReport> =>
  Effect.runPromise(
    Effect.provide(
      work,
      Layer.provideMerge(Layer.merge(hostWith(machine), extra), NodeServices.layer)
    ) as Effect.Effect<
      ReplayReport,
      Failure
    >
  )

const ownOf = (request: ReplayRequest, parts: Parts, file = "WORKSPACE.ts") =>
  own(request, parts, file) as unknown as Effect.Effect<ReplayReport, Failure, never>

const refused = (attempt: Promise<unknown>): Promise<Failure> =>
  attempt.then(
    () => {
      throw new Error("the replay succeeded")
    },
    (cause: Failure) => JSON.parse(JSON.stringify(cause)) as Failure
  )

const fastSettings = { scoreCutoff: 0.5, countCutoff: 0 }
const allPass = { hit: 0, ran: 3, failed: 0, skipped: 0 }

/** Three commits, each changing what one target reads. */
const threeCommits = (): { readonly root: string; readonly commits: ReadonlyArray<string> } => {
  const root = keep(repository(ownFiles()))
  const first = git(root, "rev-parse", "HEAD").trim()
  return {
    root,
    commits: [
      first,
      commit(root, "change b", { "b.sh": "# two\nexit 0\n" }),
      commit(root, "change c", { "c.sh": "# three\nexit 0\n" })
    ]
  }
}

describe("a model that stops answering at the second of three commits", { timeout: 900_000 }, () => {
  const asking: Parts = { ...partsFor("none"), rows: rowsOfEachCommit as never, score: score as never }
  const request = (root: string): ReplayRequest => ({
    root,
    commits: 3,
    modes: ["normal", "fast"],
    settings: fastSettings
  })

  it("keeps the baseline and normal mode of every commit, and the report says why fast mode has no number", async () => {
    const { commits, root } = threeCommits()
    const report = await replay(ownOf(request(root), asking), {}, modelFailingAfter(1) as never)

    expect(Schema.decodeUnknownSync(ReplayReport)(report)).toEqual(report)
    expect(report.commits.map((entry) => entry.commit)).toEqual(commits)
    expect(report.commits.every((entry) => entry.baseline.ok && entry.normal.ok)).toBe(true)
    expect(report.commits.every((entry) => !("fast" in entry))).toBe(true)
    expect(report.fastNotMeasured).toBe(
      unavailable({ _tag: "flows/model/ClassifierError", code: "unreachable" } as never)
    )
    expect(report).not.toHaveProperty("fastWallMs")
    expect(report).not.toHaveProperty("selection")
    expect(report.targets).toEqual(["//:a", "//:b", "//:c"])

    const at = (index: number) => `${index + 1}/3 ${commits[index]!.slice(0, 7)}`
    expect(said).toContain(`${at(0)} fast`)
    expect(said).toContain(`${at(1)} fast not measured`)
    expect(said).not.toContain(`${at(1)} fast`)
    expect(said).toContain(`${at(2)} normal`)
    expect(said).not.toContain(`${at(2)} fast`)
    expect(said).not.toContain(`${at(2)} fast not measured`)
  })

  it("keeps fast mode's numbers when the model answers every commit", async () => {
    const { root } = threeCommits()
    const report = await replay(ownOf(request(root), asking), {}, modelFailingAfter(10) as never)
    expect(report.fastNotMeasured).toBeUndefined()
    expect(report.commits.every((entry) => entry.fast !== undefined)).toBe(true)
    expect(report.selection).toBeDefined()
  })

  it("stays a failure when scoring fails for any other reason", async () => {
    const { root } = threeCommits()
    const failing: Parts = {
      ...partsFor("none"),
      score: () => Effect.fail({ code: "command-failed", message: "the ledger is full", part: "select" })
    }
    const failure = await refused(replay(ownOf(request(root), failing)))
    expect(failure).toMatchObject({ code: "command-failed", message: "the ledger is full" })
  })
})

describe("a commit fast mode cannot plan", { timeout: 900_000 }, () => {
  it("is one failed result in fast mode too, and the replay goes on", async () => {
    const { "WORKSPACE.ts": workspaceText, "PACKAGE.ts": packageText, ...before } = ownFiles()
    const root = keep(repository(before))
    commit(root, "add the workspace", { "WORKSPACE.ts": workspaceText ?? "", "PACKAGE.ts": packageText ?? "" })
    const report = await replay(
      ownOf({ root, commits: 2, modes: ["normal", "fast"], settings: fastSettings }, partsFor("none"))
    )
    expect(report.commits[0]?.fast).toMatchObject({ ok: false, counts: { hit: 0, ran: 0, failed: 1, skipped: 0 } })
    expect(report.commits[1]?.fast?.counts).toEqual({ hit: 0, ran: 1, failed: 0, skipped: 2 })
    expect(report.mismatches).toBe(0)
  })

  it("is one failed result in fast mode when it cannot be installed", async () => {
    const root = keep(repository({ ...ownFiles(), "tools/install.mjs": "process.exit(1)\n" }))
    commit(root, "fix the install", { "tools/install.mjs": installScript(smthrs) })
    const report = await replay(
      ownOf({ root, commits: 2, modes: ["fast"], settings: fastSettings }, partsFor("none"))
    )
    expect(report.commits[0]?.fast).toMatchObject({ ok: false, counts: { hit: 0, ran: 0, failed: 1, skipped: 0 } })
    expect(report.mismatches).toBe(0)
  })
})

describe("each commit runs its own CI", { timeout: 900_000 }, () => {
  /** A commit whose CI and package call the second target `old`, then the commit that renames it `b`. */
  const renamed = () => {
    const root = keep(repository({
      ...ownFiles(),
      ".github/workflows/ci.yml": workflowFor(["//:a", "//:old"]),
      "PACKAGE.ts": packageOf(["a", "old"]),
      "old.sh": "exit 0\n"
    }))
    const first = git(root, "rev-parse", "HEAD").trim()
    const second = commit(root, "rename old to b", {
      ".github/workflows/ci.yml": workflowFor(["//:a", "//:b", "//:c"]),
      "PACKAGE.ts": packageOf(["a", "b", "c"])
    })
    return { root, first, second }
  }

  it("replays an older commit with the patterns its own CI names", async () => {
    const { first, root, second } = renamed()
    const report = await replay(ownOf({ root, commits: 2, modes: ["normal"] }, partsFor("none")))
    expect(report.commits.map((entry) => entry.commit)).toEqual([first, second])
    expect(report.commits[0]?.baseline.counts).toEqual({ hit: 0, ran: 2, failed: 0, skipped: 0 })
    expect(report.commits[0]?.normal).toMatchObject({ ok: true })
    expect(report.commits[1]?.baseline.counts).toEqual(allPass)
    expect(report.targets).toEqual(["//:a", "//:b", "//:c"])
    expect(report.mismatches).toBe(0)
  })

  it("gives every commit the patterns the request names, without reading its CI", async () => {
    const { root } = renamed()
    let reads = 0
    const counting: Parts = { ...partsFor("none"), read: (at) => Effect.suspend(() => (reads += 1, read(at))) }
    const report = await replay(ownOf({ root, commits: 2, modes: ["normal"], targets: ["//:a"] }, counting))
    expect(reads).toBe(1)
    expect(report.commits.map((entry) => entry.baseline.counts.ran)).toEqual([1, 1])
  })

  it("leaves out an older commit whose CI cannot be read, and lists it with the reason", async () => {
    const { first, root, second } = renamed()
    // A commit with no CI that runs here is `unsupported`, and one whose CI does not parse is `invalid-document`.
    const refusing: Parts = {
      ...partsFor("none"),
      read: (at) =>
        existsSync(join(at, "old.sh"))
          ? Effect.fail({
            code: git(at, "rev-parse", "HEAD").trim() === first ? "unsupported" : "invalid-document",
            message: "the workflow does not parse",
            part: "inventory"
          })
          : read(at)
    }
    git(root, "rm", "--quiet", "old.sh")
    git(
      root,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "commit",
      "--quiet",
      "--message",
      "remove old.sh"
    )
    const head = git(root, "rev-parse", "HEAD").trim()
    const report = await replay(ownOf({ root, commits: 3, modes: ["normal"] }, refusing))
    expect(report.notReplayedCommits?.map((entry) => entry.commit)).toEqual([first, second])
    expect(report.notReplayedCommits?.[0]?.reason).toBe("the workflow does not parse")
    expect(report.commits.map((entry) => entry.commit)).toEqual([head])
    expect(said).toContain(`1/3 ${first.slice(0, 7)} not replayed`)
  })

  it("stops on any other failure to read an older commit", async () => {
    const { root, second } = renamed()
    const refusing: Parts = {
      ...partsFor("none"),
      read: (at) =>
        git(at, "rev-parse", "HEAD").trim() === second
          ? read(at)
          : Effect.fail({ code: "command-failed", message: "the disk is gone", part: "inventory" })
    }
    const failure = await refused(replay(ownOf({ root, commits: 2, modes: ["normal"] }, refusing)))
    expect(failure.message).toBe("the disk is gone")
  })

  it("installs an older commit for the workspace file that commit holds", async () => {
    // The first commit keeps its workspace and its install in `.smithers`, and the root has neither.
    const script = `${installScript(smthrs)}mkdirSync("../node_modules/@smthrs", { recursive: true })\nsymlinkSync(${
      JSON.stringify(join(smthrs, "../../@smthrs/targets"))
    }, "../node_modules/@smthrs/targets")\n`
    const { "WORKSPACE.ts": _w, "package.json": _m, "package-lock.json": _l, "tools/install.mjs": _t, ...shared } =
      ownFiles()
    const root = keep(repository({
      ...shared,
      ".gitignore": "node_modules\n.flows\n",
      ".smithers/WORKSPACE.ts": workspace,
      ".smithers/package.json": manifest,
      ".smithers/package-lock.json": lockfile,
      ".smithers/tools/install.mjs": script
    }))
    git(root, "rm", "--quiet", "-r", ".smithers")
    commit(root, "move the workspace to the root", ownFiles())
    const report = await replay(ownOf({ root, commits: 2, modes: ["normal"] }, partsFor("none")))
    expect(report.commits[0]?.baseline.counts).toEqual(allPass)
    expect(report.commits[1]?.baseline.counts).toEqual(allPass)
  })
})

describe("what a commit's commands can reach", { timeout: 900_000 }, () => {
  /** A target script that tries to push to `neighbour` through a repository whose own hooks directory is set. */
  const pushing = (neighbour: string, log: string): string =>
    [
      `echo "home=$HOME" >> ${log}`,
      `work=$(mktemp -d)`,
      `git init --quiet "$work"`,
      `cd "$work"`,
      `git -c user.name=t -c user.email=t@example.invalid commit --quiet --allow-empty --message x`,
      `git config core.hooksPath .own-hooks`,
      `git push --quiet file://${neighbour} HEAD:refs/heads/by-url 2>/dev/null; echo "url=$?" >> ${log}`,
      `git remote add up file://${neighbour}`,
      `git push --quiet up HEAD:refs/heads/by-remote 2>/dev/null; echo "remote=$?" >> ${log}`,
      `exit 0`,
      ``
    ].join("\n")

  it("gives a target the replay's home and a git that pushes nowhere, on a machine with no jail", async () => {
    const neighbour = keep(temporary("neighbour"))
    git(neighbour, "init", "--quiet", "--bare")
    const log = join(keep(temporary("log")), "log")
    const root = keep(
      repository({ ...ownFiles(), "PACKAGE.ts": packageWithOpenTarget, "a.sh": pushing(neighbour, log) })
    )
    const report = await replay(ownOf({ root, commits: 1, modes: ["normal"] }, partsFor("none")), {
      confine: unconfined
    })
    expect(report.commits[0]?.baseline.counts).toEqual(allPass)
    const lines = readFileSync(log, "utf8").trim().split("\n")
    expect(lines.filter((line) => line.startsWith("home="))).not.toContain(`home=${homedir()}`)
    expect(lines.filter((line) => line.startsWith("home=")).every((line) => line.includes("smithers-ci-own-"))).toBe(
      true
    )
    expect(lines.filter((line) => /^(url|remote)=/.test(line)).length).toBeGreaterThan(0)
    expect(lines.filter((line) => /^(url|remote)=0$/.test(line))).toEqual([])
    expect(git(neighbour, "for-each-ref")).toBe("")
  })

  it.skipIf("refusal" in probe())("holds a target in the jail: it cannot write outside its copy", async () => {
    const outside = join(keep(temporary("outside")), "written")
    const root = keep(repository({
      ...ownFiles(),
      "PACKAGE.ts": packageWithOpenTarget,
      "a.sh": `touch ${outside} 2>/dev/null\nexit 0\n`
    }))
    const report = await replay(ownOf({ root, commits: 1, modes: ["normal"] }, partsFor("none")))
    expect(report.commits[0]?.normal.counts).toEqual(allPass)
    expect(existsSync(outside)).toBe(false)
  })

  it("stops an install at a step's time limit, and says so", async () => {
    const root = keep(repository({ ...ownFiles(), "tools/install.mjs": "setTimeout(() => {}, 600000)\n" }))
    const failure = await refused(
      replay(ownOf({ root, commits: 1, modes: ["normal"] }, partsFor("none")), { stepTimeout: "1 second" })
    )
    expect(failure.code).toBe("unsupported")
    expect(failure.message).toContain("  step     (install)")
    expect(failure.message).toContain("npm ci --no-audit --no-fund in the repository root: it ran past the limit of 1s")
  })

  it("never starts the sudo a CI job runs before its targets, or one a target runs", async () => {
    const bin = keep(temporary("bin"))
    const ran = join(bin, "ran")
    writeFileSync(join(bin, "sudo"), `#!/bin/sh\necho "$*" >> ${ran}\n`)
    chmodSync(join(bin, "sudo"), 0o755)
    const root = keep(repository({
      ...ownFiles(),
      ".github/workflows/ci.yml": workflowFor(["//:a", "//:b", "//:c"], ["sudo apt-get install -y strace"]),
      "PACKAGE.ts": packageWithOpenTarget,
      "a.sh": "sudo touch /smithers-ci-must-not-exist 2>/dev/null\nexit 0\n"
    }))
    const path = process.env["PATH"]
    process.env["PATH"] = `${bin}:${path}`
    try {
      const report = await replay(ownOf({ root, commits: 1, modes: ["normal"] }, partsFor("none")))
      expect(report.commits[0]?.normal.counts).toEqual(allPass)
    } finally {
      process.env["PATH"] = path
    }
    expect(existsSync(ran)).toBe(false)
  })
})

describe("what a report of a repository's own targets says", { timeout: 900_000 }, () => {
  it("gives the speedup over the commits whose baseline passed", async () => {
    const root = keep(repository(ownFiles()))
    commit(root, "break a", { "a.sh": "exit 1\n" })
    commit(root, "fix a", { "a.sh": "exit 0\n" })
    const report = await replay(ownOf({ root, commits: 3, modes: ["normal"] }, partsFor("none")))
    expect(report.commits.map((entry) => entry.baseline.ok)).toEqual([true, false, true])
    expect(report.speedupCommits).toBe(2)
    const passed = report.commits.filter((entry) => entry.baseline.ok)
    expect(report.baselineWallMs).toBe(passed.reduce((total, entry) => total + entry.baseline.wallMs, 0))
    expect(report.normalWallMs).toBe(passed.reduce((total, entry) => total + entry.normal.wallMs, 0))
    expect(report.commits[1]?.baseline.failures?.[0]).toMatchObject({ step: "//:a", exitCode: 1 })
  })

  it("holds the checkout in the wall time of the baseline and of each mode", async () => {
    const root = keep(makeOwnWith(smthrs))
    const report = await Effect.runPromise(
      Effect.provide(
        jumping("checkout", ownOf({ root, commits: 1, modes: ["normal", "fast"] }, partsFor("none"))),
        NodeServices.layer
      ) as Effect.Effect<ReplayReport, Failure>
    )
    const entry = report.commits[0]
    for (const wallMs of [entry?.baseline.wallMs, entry?.normal.wallMs, entry?.fast?.wallMs]) {
      expect(wallMs).toBeGreaterThanOrEqual(hour)
      expect(wallMs).toBeLessThan(2 * hour)
    }
  })
})
