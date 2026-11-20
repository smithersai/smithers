/**
 * A step that starts a program whose file asks for rights gets the verdict a
 * CI runner gives it.
 *
 * `ping` has `cap_net_raw` in its file; `sudo` is set-user-id. A process with
 * no new privileges never gets what such a file asks for, and both recorders
 * and a machine's jail give a step no new privileges. The fifth ship review's
 * blocker 4: `ping` failed in every recorded run where a runner's passes, and
 * a step that tests for it took its other branch and passed a commit the CI
 * fails. Such a step runs again with no jail and no recorder, as a runner runs
 * it, and nothing of it is stored.
 *
 * Every case plans and executes real targets on a machine, in a real git
 * checkout, under each recorder this host has. The program of the run's own
 * is a copy of `id` with its set-user-id bit set: the build cannot tell it from
 * a privileged one, so no privileged program is needed. `ping` is the host's,
 * where its file carries the capability.
 */
import { Smithers as S } from "@smthrs/targets"
import * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import * as Effect from "effect/Effect"
import { execFileSync, spawnSync } from "node:child_process"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type * as Executor from "../src/Executor.ts"
import * as CacheEvidence from "../src/internal/CacheEvidence.ts"
import * as Machine from "../src/internal/Machine.ts"
import * as ObservedReads from "../src/internal/ObservedReads.ts"
import { executeEffect, ExecutionServices, executionServicesLive } from "../src/internal/PackageRunner.ts"
import { plan } from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"

const temporary: Array<string> = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => Machine.remove(root)))
})

const host = ExecSandbox.host()

/** Each recorder this host has: `smthrs-observe` where it runs, and strace. */
const recorders = [
  [
    "smthrs-observe",
    ObservedReads.observer({
      ...host,
      supervisor: ObservedReads.supervisorPath(process.platform, process.arch, {
        SMTHRS_OBSERVE_WITH: "smthrs-observe"
      })
    })
  ],
  ["strace", ObservedReads.observer({ ...host, supervisor: undefined })]
] as const

/** Whether `ping` carries a capability in its file here and works plainly. */
const ping = process.platform === "linux" && ObservedReads.askingRights(["/usr/bin/ping"]).length === 1 &&
  spawnSync("/usr/bin/ping", ["-c1", "-W2", "127.0.0.1"]).status === 0

/** The bubblewrap of this host that gives a command a `/tmp` of its own, when it has one. */
const mount = await Machine.mounting(process.env, "/var/tmp")

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-c", "user.name=Rights", "-c", "user.email=rights@example.invalid", "-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim()

/** A shell test on a machine, observed. */
const on = (machine: string, shell: string) =>
  S.Shell.Test({ shell, machine, sandbox: "none", observe: true, data: [S.glob("**")] as never })

type Targets = Parameters<typeof S.Package>[0]["targets"]
type Result = Executor.Summary["results"][number]

const fixture = async (
  observer: ObservedReads.Observer,
  targets: (base: string) => Targets,
  environment: Readonly<Record<string, string>> = {}
) => {
  // Beside the temporary directory, as a runner's work directory is.
  const base = await Fs.realpath(await Fs.mkdtemp(Path.join("/var/tmp", "smithers-rights-")))
  temporary.push(base)
  const root = Path.join(base, "ws")
  await Fs.mkdir(root, { recursive: true })
  git(root, "init", "--quiet", "--initial-branch=main")
  await Fs.writeFile(Path.join(root, ".gitignore"), ".flows\n")
  await Fs.writeFile(Path.join(root, "data.txt"), "bad\n")
  // The program of the run's own whose file asks for rights, outside the checkout: git keeps no set-user-id bit.
  await Fs.mkdir(Path.join(base, "tools"))
  await Fs.copyFile("/usr/bin/id", Path.join(base, "tools", "id"))
  await Fs.chmod(Path.join(base, "tools", "id"), 0o4755)
  git(root, "add", "-A")
  git(root, "commit", "--quiet", "-m", "one")
  const index = PackageIndex.make({
    root,
    workspace: S.Workspace("rights", {
      repository: "git+https://example.invalid/rights.git",
      cache: S.Cache({ directory: ".flows" }),
      host: S.Host({ bins: ["sh"] })
    }),
    factory: undefined,
    packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets: targets(base) }) }]
  })
  const env: Record<string, string> = {
    PATH: [
      ...("bwrap" in mount ? [Path.dirname(mount.bwrap)] : []),
      ...("tracer" in observer ? [Path.dirname(observer.tracer)] : []),
      "/usr/bin",
      "/bin"
    ].join(Path.delimiter),
    HOME: Path.join(base, "home"),
    [Machine.holdingVariable]: Path.join(base, "machines"),
    ...environment
  }
  await Fs.mkdir(env["HOME"]!, { recursive: true })
  const logs: Array<string> = []
  const services: ExecutionServices = { ...executionServicesLive, observer: () => observer }
  /** Plans and executes the named targets; answers each one's result by name. */
  const run = async (names: ReadonlyArray<string>, given: ExecutionServices = services) => {
    const options = {
      index,
      cacheDirectory: ".flows",
      verb: "auto" as const,
      patterns: names.map((name) => `//:${name}`),
      environment: env,
      jobs: 1,
      log: (line: string) => {
        logs.push(line)
      }
    }
    const previous = process.env["PATH"]
    process.env["PATH"] = env["PATH"]
    try {
      const summary = await Effect.runPromise(
        executeEffect(await plan(options), options).pipe(Effect.provideService(ExecutionServices, given))
      )
      return Object.fromEntries(summary.results.map((result) => [result.label.split(":")[1]!, result])) as Record<
        string,
        Result
      >
    } finally {
      process.env["PATH"] = previous
    }
  }
  /** How many times the steps that count their runs in `name` ran. */
  const runs = (name: string): number =>
    NodeFs.existsSync(Path.join(base, name)) ? NodeFs.readFileSync(Path.join(base, name), "utf8").length : 0
  return { base, root, run, runs, logs, services }
}

/** The program of the run's own whose file asks for rights. */
const idOf = (base: string): string => Path.join(base, "tools", "id")

/** A command that counts its run in `name` beside the workspace. */
const counted = (base: string, name: string): string => `printf x >> ${Path.join(base, name)}`

const why = /^it started \/.*\/tools\/id, which needs rights its jail takes away$/
const theirs = expect.stringMatching(/^\/.*\/tools\/id$/)
/** Whether this host gives a machine a `/tmp` of its own, which a run with no jail goes without. */
const mountedIt = it.skipIf(!("bwrap" in mount))

for (const [name, observer] of recorders) {
  describe.skipIf("reason" in observer)(`a step recorded with ${name} that starts a program asking for rights`, () => {
    it("runs again with no jail, is never stored, and then goes straight to that run", async () => {
      const { run, runs, logs } = await fixture(observer, (base) => ({
        own: on("job", `${idOf(base)} -u > /dev/null && ${counted(base, "own")}`),
        other: on("job", `${idOf(base)} -g > /dev/null && ${counted(base, "other")}`),
        fails: on("job", `${idOf(base)} -u > /dev/null; exit 3`)
      }))
      expect((await run(["own"]))["own"]).toMatchObject({
        status: "ran",
        rights: [theirs],
        notStored: expect.stringMatching(why)
      })
      expect(
        logs.filter((line) =>
          /tools\/id, which needs rights its jail takes away; it runs again without the jail$/.test(line)
        )
      ).toHaveLength(1)
      // Recorded, then again with no jail.
      expect(runs("own")).toBe(2)
      // The next run of the declaration goes straight to the run with no jail, never stored.
      expect((await run(["own"]))["own"]).toMatchObject({
        status: "ran",
        rights: [theirs],
        notStored: expect.stringMatching(why)
      })
      expect(runs("own")).toBe(3)
      // Another declaration is recorded first.
      expect((await run(["other"]))["other"]).toMatchObject({ status: "ran", rights: [theirs] })
      expect(runs("other")).toBe(2)
      // The run with no jail is the verdict, a failure too.
      expect((await run(["fails"]))["fails"]).toMatchObject({ status: "failed", rights: [theirs] })
    })

    it("records again at every run where what it needs cannot be remembered", async () => {
      const { root, run, runs } = await fixture(observer, (base) => ({
        own: on("job", `${idOf(base)} -u > /dev/null && ${counted(base, "own")}`)
      }))
      // A file stands where the build keeps what it remembers.
      await Fs.mkdir(Path.join(root, ".flows"), { recursive: true })
      await Fs.writeFile(Path.join(root, ".flows", "evidence"), "")
      expect((await run(["own"]))["own"]).toMatchObject({ status: "ran", rights: [theirs] })
      expect((await run(["own"]))["own"]).toMatchObject({ status: "ran", rights: [theirs] })
      expect(runs("own")).toBe(4)
    })

    it("runs again in the tree the recorded run left, with what the jailed step was given", async () => {
      const { base, run } = await fixture(
        observer,
        (base) => ({
          twice: on(
            "job",
            `echo run >> runs.log; ${idOf(base)} -u > /dev/null; ` +
              `env > ${Path.join(base, "env")}; test "$(wc -l < runs.log)" -eq 2`
          )
        }),
        { SMITHERS_CACHE_TOKEN: "rights-canary-token-0123456789" }
      )
      // The second run found the line the first run wrote: it runs in the tree that run left.
      expect((await run(["twice"]))["twice"]?.status).toBe("ran")
      const seen = Object.fromEntries(
        (await Fs.readFile(Path.join(base, "env"), "utf8")).split("\n").filter((line) => line.includes("=")).map(
          (line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]
        )
      )
      // The machine's home and temporary directory, and none of the build's tokens.
      expect(seen["HOME"]).not.toBe(Path.join(base, "home"))
      expect(seen["HOME"]).toContain(Path.join(base, "machines"))
      expect(seen["TMPDIR"]).toContain(Path.join(base, "machines"))
      expect(JSON.stringify(seen)).not.toContain("rights-canary-token-0123456789")
    })

    it("fails, and says what to do, where this build itself has no new privileges", async () => {
      const { run, services } = await fixture(observer, (base) => ({ own: on("job", `${idOf(base)} -u > /dev/null`) }))
      const result = (await run(["own"], { ...services, noNewPrivileges: () => true }))["own"]
      expect(result).toMatchObject({
        status: "failed",
        rights: [theirs],
        error: expect.stringContaining(
          "which needs rights its jail takes away, and this run has no new privileges itself: " +
            "write this job back into the workflow as the repository had it"
        )
      })
    })

    mountedIt("shares the host's /tmp with another machine's run only while neither left a name there", async () => {
      const left = (base: string, machine: string): string =>
        `${idOf(base)} -u > /dev/null && touch /tmp/${Path.basename(base)}-${machine}`
      const { base, run } = await fixture(
        observer,
        (base) => ({
          one: on("one", `${idOf(base)} -u > /dev/null`),
          two: on("two", `${idOf(base)} -u > /dev/null`),
          three: on("three", left(base, "three")),
          four: on("four", left(base, "four"))
        }),
        { [Machine.ownTmpVariable]: "required" }
      )
      try {
        // Neither run left a name in /tmp: each runs with no jail.
        const quiet = await run(["one", "two"])
        expect([quiet["one"]?.status, quiet["two"]?.status]).toEqual(["ran", "ran"])
        // The first to run left one, and the other would find it there.
        const results = await run(["three", "four"])
        const statuses = [results["three"]?.status, results["four"]?.status].sort()
        expect(statuses).toEqual(["failed", "ran"])
        const failed = [results["three"], results["four"]].find((result) => result?.status === "failed")
        expect(failed?.error).toMatch(
          /which needs rights its jail takes away, and machine (three|four) left \/tmp\/.*-(three|four) in this build: write this job back/
        )
      } finally {
        for (const machine of ["three", "four"]) await Fs.rm(`/tmp/${Path.basename(base)}-${machine}`, { force: true })
      }
    })

    it.skipIf(!ping)("gets the verdict of a runner, where ping works", async () => {
      const { run } = await fixture(observer, () => ({
        ping: on("job", "ping -c1 -W2 127.0.0.1 > /dev/null"),
        skips: on(
          "job",
          "if ping -c1 -W2 127.0.0.1 > /dev/null 2>&1; then grep -qx ok data.txt; else echo 'no ICMP here: skipped'; fi"
        )
      }))
      const results = await run(["ping", "skips"])
      // ping works, so the step passes; the step that tests for it checks the file, which is bad, and fails.
      expect(results["ping"]).toMatchObject({ status: "ran", rights: ["/usr/bin/ping"] })
      expect(results["skips"]).toMatchObject({ status: "failed", rights: ["/usr/bin/ping"] })
    })
  })
}

describe.skipIf(process.platform !== "linux")("the programs a run started that ask for rights", () => {
  it("are what smthrs-observe names, or which are set-user-id or set-group-id where there is none", async () => {
    const base = await Fs.realpath(await Fs.mkdtemp(Path.join("/var/tmp", "smithers-rights-")))
    temporary.push(base)
    const own = Path.join(base, "id")
    await Fs.copyFile("/usr/bin/id", own)
    await Fs.chmod(own, 0o2755)
    const missing = Path.join(base, "missing")
    expect(ObservedReads.askingRights([])).toEqual([])
    expect(ObservedReads.askingRights([own, "/usr/bin/id", missing], false)).toEqual([own])
    expect(ObservedReads.askingRights([own, base], Path.join(base, "no-such-observer"))).toEqual([own])
    // A trace smthrs-observe wrote names them; any other trace is asked about the programs it started.
    const named = ObservedReads.read(
      () => ["1 +++ smthrs-observe 1 +++", `1 +++ rights: ${own} +++`, "1 +++ complete +++"],
      "/"
    )
    expect(ObservedReads.rightsIn(named, () => ["never asked"])).toEqual([own])
    const traced = ObservedReads.read(() => [`1 execve("${own}", ["id"], 0x1 /* 1 vars */) = 0`], "/")
    expect(ObservedReads.rightsIn(traced, (programs) => programs)).toEqual([own])
  })
})

describe("a remembered need for rights", () => {
  it("answers the build and the recorder that wrote it, and nothing for a record that is not one", async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(Path.join("/var/tmp", "smithers-rights-")))
    temporary.push(root)
    const identity = "e".repeat(64)
    const writer = { build: "build-1", recorder: "strace" }
    expect(await CacheEvidence.rightsNeeded(root, ".flows", identity, writer)).toBeUndefined()
    await CacheEvidence.rememberRights(root, ".flows", identity, writer, {
      label: "//:ping",
      programs: ["/usr/bin/ping"]
    })
    const file = CacheEvidence.rightsPath(root, ".flows", identity)
    expect(file).toBe(Path.join(root, ".flows", "evidence", `${identity}.rights.json`))
    expect(JSON.parse(await Fs.readFile(file, "utf8"))).toEqual({
      format: "smthrs-rights/1",
      build: "build-1",
      recorder: "strace",
      label: "//:ping",
      programs: ["/usr/bin/ping"]
    })
    expect(await CacheEvidence.rightsNeeded(root, ".flows", identity, writer)).toEqual(["/usr/bin/ping"])
    // Another build, or another recorder, records once more: the memory may be the old build's mistake.
    expect(await CacheEvidence.rightsNeeded(root, ".flows", identity, { ...writer, build: "build-2" })).toBeUndefined()
    expect(await CacheEvidence.rightsNeeded(root, ".flows", identity, { build: "build-1" })).toBeUndefined()
    // A writer that names no recorder is remembered without one.
    await CacheEvidence.rememberRights(root, ".flows", identity, { build: "build-1" }, {
      label: "//:ping",
      programs: ["/usr/bin/ping"]
    })
    expect(await CacheEvidence.rightsNeeded(root, ".flows", identity, { build: "build-1" })).toEqual(["/usr/bin/ping"])
    for (
      const text of [
        "not json",
        "null",
        "7",
        JSON.stringify({ format: "smthrs-reached-outside/1", build: "build-1", programs: ["/usr/bin/ping"] }),
        JSON.stringify({ format: "smthrs-rights/1", build: "build-1", programs: [] }),
        JSON.stringify({ format: "smthrs-rights/1", build: "build-1", programs: [7] }),
        JSON.stringify({ format: "smthrs-rights/1", build: "build-1", programs: "/usr/bin/ping" })
      ]
    ) {
      await Fs.writeFile(file, text)
      expect(await CacheEvidence.rightsNeeded(root, ".flows", identity, { build: "build-1" }), text).toBeUndefined()
    }
  })
})
