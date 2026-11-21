/**
 * A recorder killed while its step runs, end to end: the step, a program it
 * started and a program that left its session all end with the recorder, the
 * target fails with the build's own failure, and nothing is stored. Without
 * this a step outlives its recorder, adopted by the nearest subreaper above,
 * which can be the session's own service manager.
 *
 * The step's machine is its job's: one process namespace, held by the job's
 * keeper, which the build ends with the job. Each step kills its recorder only
 * when an ancestor of it is the recorder; run the suite by hand inside a
 * process namespace of its own (`bwrap --unshare-pid`).
 */
import { Smithers as S } from "@smthrs/targets"
import * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import * as Effect from "effect/Effect"
import { execFileSync, spawn } from "node:child_process"
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

const supervisor = ObservedReads.supervisorPath(process.platform, process.arch, {
  SMTHRS_OBSERVE_WITH: "smthrs-observe"
})
const strace = ObservedReads.observer({ ...ExecSandbox.host(), supervisor: undefined })
const recorders: ReadonlyArray<readonly [string, ObservedReads.Observer | undefined]> = [
  ["smthrs-observe", supervisor === undefined ? undefined : { tracer: supervisor, supervisor: true }],
  ["strace", "tracer" in strace ? strace : undefined]
]

/** The processes of this namespace whose command line holds `mark`. */
const holding = (mark: string): ReadonlyArray<string> =>
  NodeFs.readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).flatMap((pid) => {
    try {
      return NodeFs.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(mark) ? [pid] : []
    } catch {
      return []
    }
  })

/**
 * A step that starts a program, starts one that leaves its session, kills its recorder, and waits. The recorder is
 * the nearest of the step's first four ancestors whose program it is: strace runs the step under a shell of its own.
 * With no such ancestor nothing is killed, and the step says which parent it found.
 */
const step = (recorder: string, mark: string): string =>
  [
    `sleep ${mark}1 &`,
    `setsid sh -c 'exec sleep ${mark}2' &`,
    "sleep 1",
    "p=$PPID; n=0",
    `while [ -n "$p" ] && [ "$n" -lt 4 ]; do c=$(ps -o comm= -p "$p"); [ "\${c##*/}" = ${recorder} ] && break; ` +
    `p=$(ps -o ppid= -p "$p" | tr -d " "); n=$((n + 1)); done`,
    `[ -n "$p" ] && [ "$n" -lt 4 ] || { echo "no ancestor is ${recorder}: nothing is killed" >&2; exit 97; }`,
    `kill -9 "$p"`,
    `exec sleep ${mark}3`
  ].join("\n")

/** The bubblewrap of this host, which gives a machine's job a process namespace of its own. */
const mount = await Machine.mounting(process.env, "/var/tmp")

const fixture = async (recorder: string, mark: string, machine: boolean) => {
  const base = await Fs.realpath(await Fs.mkdtemp(Path.join("/var/tmp", "smithers-recorder-killed-")))
  temporary.push(base)
  const root = Path.join(base, "ws")
  await Fs.mkdir(root)
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch=main"])
  await Fs.writeFile(Path.join(root, "input.txt"), "in\n")
  const index = PackageIndex.make({
    root,
    workspace: S.Workspace("killed", {
      repository: "git+https://example.invalid/killed.git",
      cache: S.Cache({ directory: ".flows" }),
      host: S.Host({ bins: ["sh"] })
    }),
    factory: undefined,
    packages: [{
      file: "PACKAGE.ts",
      packagePath: "",
      value: S.Package({
        targets: {
          check: S.Shell.Test({
            shell: step(recorder, mark),
            sandbox: "none",
            observe: true,
            data: [S.glob("**")],
            ...(machine ? { machine: "job" } : {})
          })
        }
      })
    }]
  })
  const environment: Record<string, string> = {
    PATH: [...("bwrap" in mount ? [Path.dirname(mount.bwrap)] : []), "/usr/bin", "/bin"].join(Path.delimiter),
    HOME: Path.join(base, "home"),
    [Machine.holdingVariable]: Path.join(base, "machines")
  }
  await Fs.mkdir(environment["HOME"]!, { recursive: true })
  const logs: Array<string> = []
  const options = {
    index,
    cacheDirectory: ".flows",
    verb: "auto" as const,
    patterns: ["//:check"],
    environment,
    jobs: 1,
    log: (line: string) => void logs.push(line)
  }
  return {
    logs,
    run: async (services: ExecutionServices) =>
      Effect.runPromise(
        executeEffect(await plan(options), options).pipe(Effect.provideService(ExecutionServices, services))
      )
  }
}

describe.each(recorders)("a step on a machine whose recorder %s is killed", (recorder, observer) => {
  it.skipIf(observer === undefined || process.platform !== "linux" || !("bwrap" in mount))(
    "ends with everything it started, and fails the build",
    async () => {
      const mark = `${process.pid}${Math.floor(Math.random() * 1e6)}.`
      const { logs, run } = await fixture(recorder, mark, true)
      const services = { ...executionServicesLive, observer: () => observer! }
      const gone = async (): Promise<void> => {
        const until = Date.now() + 2_000
        while (holding(mark).length > 0 && Date.now() < until) await new Promise((done) => setTimeout(done, 50))
        expect(holding(mark)).toEqual([])
      }
      for (let time = 0; time < 2; time++) {
        if (recorder === "smthrs-observe") {
          // The recorder's failure is the build's: nothing of the run is stored, and the next run runs it again.
          await expect(run(services)).rejects.toThrow("smthrs-observe stopped before the step ended")
        } else {
          // strace's runs it again without the recording, where it finds no recorder to kill, and fails; nothing is
          // stored.
          const summary = await run(services)
          expect(summary.results.map((result) => result.status)).toEqual(["failed"])
          expect(logs).toContain("//:check  failed while its reads were recorded; it runs again without the recording")
        }
        await gone()
      }
    },
    60_000
  )
})

describe("smthrs-observe killed while its command runs", () => {
  it.skipIf(supervisor === undefined || process.platform !== "linux")(
    "takes the command down with it, so nothing adopts the command",
    async () => {
      const base = await Fs.realpath(await Fs.mkdtemp(Path.join("/var/tmp", "smithers-recorder-killed-")))
      temporary.push(base)
      const mark = `${process.pid}${Math.floor(Math.random() * 1e6)}.`
      const recorder = spawn(supervisor!, [Path.join(base, "trace"), "--", "sh", "-c", `exec sleep ${mark}4`], {
        stdio: "ignore"
      })
      // The command once it is running: `sleep` with the mark, never the recorder, whose arguments hold it too.
      const command = (): ReadonlyArray<string> => holding(`sleep\0${mark}4\0`)
      const started = Date.now() + 10_000
      while (command().length === 0 && Date.now() < started) await new Promise((done) => setTimeout(done, 20))
      expect(command()).toHaveLength(1)
      recorder.kill("SIGKILL")
      const until = Date.now() + 1_000
      while (command().length > 0 && Date.now() < until) await new Promise((done) => setTimeout(done, 20))
      expect(command()).toEqual([])
    },
    30_000
  )
})
