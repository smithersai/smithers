/**
 * A machine a build keeps when it ends (`Machine.keepVariable`), end to end: real targets planned and executed
 * through the PACKAGE.ts surface, in a real git checkout, with real shell commands. A workflow step after the build,
 * such as an upload of what a job's tests wrote, finds the job's checkout there.
 */
import { Smithers as S } from "@smthrs/targets"
import * as Exec from "@smthrs/targets/Exec"
import * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import * as Effect from "effect/Effect"
import { execFileSync } from "node:child_process"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as Machine from "../src/internal/Machine.ts"
import * as ObservedReads from "../src/internal/ObservedReads.ts"
import { executeEffect, ExecutionServices, executionServicesLive } from "../src/internal/PackageRunner.ts"
import { plan } from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"

const temporary: Array<string> = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => Machine.remove(root)))
})

const tracing = ObservedReads.observer(ExecSandbox.host())
const tracedIt = it.skipIf("reason" in tracing)
const posixIt = it.skipIf(process.platform === "win32")
/** A host that cannot record what a run reads. */
const untraced: ExecutionServices = {
  ...executionServicesLive,
  observer: () => ({ reason: "strace is not installed" })
}

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-c", "user.name=Machine", "-c", "user.email=machine@example.invalid", "-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim()

/** A shell test on a machine, observed. */
const on = (machine: string, shell: string, data: ReadonlyArray<unknown> = []) =>
  S.Shell.Test({ shell, machine, sandbox: "none", observe: true, data: [S.glob("**"), ...data] as never })

const fixture = async (targets: Parameters<typeof S.Package>[0]["targets"]) => {
  const base = await Fs.realpath(await Fs.mkdtemp(Path.join("/var/tmp", "smithers-machine-keep-")))
  temporary.push(base)
  const root = Path.join(base, "ws")
  await Fs.mkdir(root)
  git(root, "init", "--quiet", "--initial-branch=main")
  await Fs.writeFile(Path.join(root, ".gitignore"), ".flows\n")
  await Fs.writeFile(Path.join(root, "a.txt"), "a\n")
  await Fs.writeFile(Path.join(root, "b.txt"), "b\n")
  git(root, "add", "-A")
  git(root, "commit", "--quiet", "-m", "one")
  const index = PackageIndex.make({
    root,
    workspace: S.Workspace("keep", {
      repository: "git+https://example.invalid/keep.git",
      cache: S.Cache({ directory: ".flows" }),
      host: S.Host({ bins: ["sh"] })
    }),
    factory: undefined,
    packages: [{ file: "PACKAGE.ts", packagePath: "", value: S.Package({ targets }) }]
  })
  const environment: Record<string, string> = {
    PATH: [...("tracer" in tracing ? [Path.dirname(tracing.tracer)] : []), "/usr/bin", "/bin"].join(Path.delimiter),
    HOME: Path.join(base, "home"),
    [Machine.holdingVariable]: Path.join(base, "machines")
  }
  await Fs.mkdir(environment["HOME"]!, { recursive: true })
  const logs: Array<string> = []
  const options = (names: ReadonlyArray<string>) => ({
    index,
    cacheDirectory: ".flows",
    verb: "auto" as const,
    patterns: names.map((name) => `//:${name}`),
    environment,
    jobs: 1,
    log: (line: string) => void logs.push(line)
  })
  /** Plans and executes the named targets; answers each one's status by name. */
  const run = async (
    names: ReadonlyArray<string>,
    services: ExecutionServices = executionServicesLive
  ): Promise<Record<string, string>> => {
    const previous = process.env["PATH"]
    process.env["PATH"] = environment["PATH"]
    try {
      const summary = await Effect.runPromise(
        executeEffect(await plan(options(names)), options(names)).pipe(
          Effect.provideService(ExecutionServices, services)
        )
      )
      return Object.fromEntries(summary.results.map((result) => [result.label.split(":")[1]!, result.status]))
    } finally {
      process.env["PATH"] = previous
    }
  }
  const kept = (name: string): string => Path.join(base, "kept", name)
  const keep = (wanted: Readonly<Record<string, string>>): void => {
    environment[Machine.keepVariable] = JSON.stringify(wanted)
  }
  return { base, root, run, logs, kept, keep, environment }
}

describe("a machine the build is told to keep", () => {
  posixIt("is left where it is told, as its targets left it, and the workspace is untouched", async () => {
    const { kept, keep, logs, root, run } = await fixture({
      test: on("job", "echo covered > coverage.txt && mkdir -p report && echo x > report/x"),
      other: on("other", "echo other > other.txt")
    })
    keep({ job: kept("0") })
    expect(await run(["test", "other"], untraced)).toEqual({ test: "ran", other: "ran" })
    expect(await Fs.readFile(Path.join(kept("0"), "coverage.txt"), "utf8")).toBe("covered\n")
    expect(await Fs.readFile(Path.join(kept("0"), "report", "x"), "utf8")).toBe("x\n")
    expect(await Fs.readFile(Path.join(kept("0"), "a.txt"), "utf8")).toBe("a\n")
    // Only the machine it was told to keep, and nothing of either in the workspace.
    expect(NodeFs.existsSync(Path.join(kept("0"), "other.txt"))).toBe(false)
    expect(NodeFs.existsSync(Path.join(root, "coverage.txt"))).toBe(false)
    expect(git(root, "status", "--porcelain")).toBe("")
    expect(logs).toContain(`smthrs: machine job is kept in ${kept("0")}`)
  })

  tracedIt("holds what its steps left when the cache answered every one of them", async () => {
    const { kept, keep, logs, root, run } = await fixture((() => {
      const install = on("job", "mkdir -p deps && cp a.txt deps/a")
      return {
        install,
        test: on("job", "grep -q a deps/a && grep -q b b.txt && echo covered > coverage.txt", [install])
      }
    })())
    expect(await run(["test"])).toEqual({ install: "ran", test: "ran" })
    // Nothing runs, and the machine is made for the keep alone, with what both steps left put back.
    keep({ job: kept("0") })
    await Fs.mkdir(kept("0"), { recursive: true })
    await Fs.writeFile(Path.join(kept("0"), "stale.txt"), "from before\n")
    expect(await run(["test"])).toEqual({ install: "hit", test: "hit" })
    expect(await Fs.readFile(Path.join(kept("0"), "coverage.txt"), "utf8")).toBe("covered\n")
    expect(await Fs.readFile(Path.join(kept("0"), "deps", "a"), "utf8")).toBe("a\n")
    expect(NodeFs.existsSync(Path.join(kept("0"), "stale.txt"))).toBe(false)
    expect(logs.filter((line) => line.includes("has a fresh checkout"))).toHaveLength(2)
    // What the install left was put back for the test that ran: the keep puts it back no second time.
    await Fs.writeFile(Path.join(root, "b.txt"), "b, changed\n")
    logs.length = 0
    expect(await run(["test"])).toEqual({ install: "hit", test: "ran" })
    expect(logs.filter((line) => line.includes("what it left is put back"))).toEqual([
      "//:install  what it left is put back for //:test"
    ])
    expect(await Fs.readFile(Path.join(kept("0"), "b.txt"), "utf8")).toBe("b, changed\n")
  })

  posixIt("keeps nothing of a machine no target of the run is on, and says so", async () => {
    const { kept, keep, logs, run } = await fixture({ test: on("job", "true") })
    keep({ nobody: kept("0") })
    expect(await run(["test"], untraced)).toEqual({ test: "ran" })
    expect(NodeFs.existsSync(kept("0"))).toBe(false)
    expect(logs).toContain("smthrs: no target of this run is on machine nobody, so nothing of it is kept")
  })

  posixIt("fails the run when it is not told where in a way it can read", async () => {
    const { environment, run } = await fixture({ test: on("job", "true") })
    for (const value of ["{", "[]", "null", "{\"job\":\"relative/dir\"}", "{\"job\":3}"]) {
      environment[Machine.keepVariable] = value
      await expect(run(["test"], untraced)).rejects.toThrow(
        `${Machine.keepVariable} is not a JSON object from machine names to absolute directories`
      )
    }
    environment[Machine.keepVariable] = ""
    expect(await run(["test"], untraced)).toEqual({ test: "hit" })
  })
  tracedIt("runs a step again whose files cannot be put back, and fails when that run fails", async () => {
    const { kept, keep, logs, run } = await fixture((() => {
      const install = on("job", "mkdir -p deps && cp a.txt deps/a")
      return { install, test: on("job", "grep -q a deps/a && echo covered > coverage.txt", [install]) }
    })())
    expect(await run(["test"])).toEqual({ install: "ran", test: "ran" })
    keep({ job: kept("0") })
    // A host with no tar cannot put back what a step left: the step runs again for the keep.
    const without = (names: ReadonlyArray<string>): ExecutionServices => ({
      ...executionServicesLive,
      findOnPath: (name, ...rest) =>
        names.includes(name) ? Effect.succeed(undefined) : executionServicesLive.findOnPath(name, ...rest)
    })
    expect(await run(["test"], without(["tar"]))).toEqual({ install: "hit", test: "hit" })
    expect(await Fs.readFile(Path.join(kept("0"), "coverage.txt"), "utf8")).toBe("covered\n")
    expect(logs).toContain(`smthrs: machine job is kept in ${kept("0")}`)
    // A step that fails when it runs again leaves nothing to keep, and the run says which.
    const failing: ExecutionServices = {
      ...without(["tar"]),
      exec: (_config, payload) =>
        Effect.fail(Exec.ExecError.make({
          _tag: "smithers-build/ExecError",
          argv: payload.argv,
          cwd: payload.cwd,
          code: "exit_status",
          exitCode: 1,
          stdout: "",
          stderr: "the disk is gone"
        }))
    }
    await expect(run(["test"], failing)).rejects.toThrow(
      "machine job cannot be kept: //:install failed when it ran again"
    )
  })
})
