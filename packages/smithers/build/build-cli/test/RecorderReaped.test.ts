/**
 * A recorder killed while a step with no machine of its own runs, end to end:
 * what the step started still holds the build's output, so the build ends it
 * and does not wait for ever. A program that let go of that output and
 * detached is left alone, as a plain run leaves it.
 *
 * Each step kills its recorder only when an ancestor of it is the recorder;
 * run the suite by hand inside a process namespace of its own
 * (`bwrap --unshare-pid`).
 */
import { Smithers as S } from "@smthrs/targets"
import * as ExecSandbox from "@smthrs/targets/ExecSandbox"
import * as Effect from "effect/Effect"
import { execFileSync } from "node:child_process"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as Path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as ObservedReads from "../src/internal/ObservedReads.ts"
import { executeEffect, ExecutionServices, executionServicesLive } from "../src/internal/PackageRunner.ts"
import { plan } from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"

const temporary: Array<string> = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
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
 * A step that finds its recorder among its first five ancestors (strace runs it under a shell of its own, and a
 * reaper may stand above), starts a program and one that leaves its session, both of which write to the build and
 * then wait in a program of their own, holding its output, and one that lets go of its output and detaches; then kills
 * the recorder and waits. Without its recorder a process can start no other: the holders are already in theirs. With no recorder above it the step
 * starts nothing and says so.
 */
const step = (recorder: string, mark: string): string =>
  [
    "p=$PPID; n=0",
    `while [ -n "$p" ] && [ "$n" -lt 5 ]; do c=$(ps -o comm= -p "$p"); [ "\${c##*/}" = ${recorder} ] && break; ` +
    `p=$(ps -o ppid= -p "$p" | tr -d " "); n=$((n + 1)); done`,
    `[ -n "$p" ] && [ "$n" -lt 5 ] || { echo "no ancestor is ${recorder}: nothing is killed" >&2; exit 97; }`,
    `sh -c 'echo "$0"; exec sleep "$0"' ${mark}1 &`,
    `setsid sh -c 'echo "$0" >&2; exec sleep "$0"' ${mark}2 &`,
    `setsid sh -c 'exec sleep ${mark}4' < /dev/null > /dev/null 2>&1 &`,
    "sleep 1",
    `kill -9 "$p"`,
    `exec sleep ${mark}3`
  ].join("\n")

const fixture = async (recorder: string, mark: string) => {
  const base = await Fs.realpath(await Fs.mkdtemp(Path.join("/var/tmp", "smithers-recorder-reaped-")))
  temporary.push(base)
  const root = Path.join(base, "ws")
  await Fs.mkdir(root)
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch=main"])
  await Fs.writeFile(Path.join(root, "input.txt"), "in\n")
  const index = PackageIndex.make({
    root,
    workspace: S.Workspace("reaped", {
      repository: "git+https://example.invalid/reaped.git",
      cache: S.Cache({ directory: ".flows" }),
      host: S.Host({ bins: ["sh"] })
    }),
    factory: undefined,
    packages: [{
      file: "PACKAGE.ts",
      packagePath: "",
      value: S.Package({
        targets: {
          check: S.Shell.Test({ shell: step(recorder, mark), sandbox: "none", observe: true, data: [S.glob("**")] })
        }
      })
    }]
  })
  const logs: Array<string> = []
  const options = {
    index,
    cacheDirectory: ".flows",
    verb: "auto" as const,
    patterns: ["//:check"],
    environment: { PATH: ["/usr/bin", "/bin"].join(Path.delimiter), HOME: base },
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

describe.each(recorders)("a step with no machine whose recorder %s is killed", (recorder, observer) => {
  it.skipIf(observer === undefined || process.platform !== "linux")(
    "ends what holds the build's output within ten seconds, and leaves a program that let go of it",
    async () => {
      const mark = `${process.pid}${Math.floor(Math.random() * 1e6)}.`
      const { logs, run } = await fixture(recorder, mark)
      const services = { ...executionServicesLive, observer: () => observer! }
      const began = Date.now()
      try {
        if (recorder === "smthrs-observe") {
          await expect(run(services)).rejects.toThrow("smthrs-observe stopped before the step ended")
        } else {
          // strace's runs again without the recording, where it finds no recorder, starts nothing and fails.
          const summary = await run(services)
          expect(summary.results.map((result) => result.status)).toEqual(["failed"])
          expect(logs).toContain("//:check  failed while its reads were recorded; it runs again without the recording")
        }
        expect(Date.now() - began).toBeLessThan(10_000)
        for (const held of [1, 2, 3]) {
          expect(
            holding(`${mark}${held}`).map((pid) =>
              NodeFs.readdirSync(`/proc/${pid}/fd`).map((fd) => NodeFs.readlinkSync(`/proc/${pid}/fd/${fd}`)).join(" ")
            ),
            `program ${held}`
          ).toEqual([])
        }
        // A program that let go of the output and detached is left as a plain run leaves it. strace follows it too,
        // and a killed strace takes every program it follows with it.
        expect(holding(`sleep\0${mark}4`)).toHaveLength(recorder === "strace" ? 0 : 1)
      } finally {
        for (const pid of holding(mark)) {
          try {
            process.kill(Number(pid), "SIGKILL")
          } catch {
            // Gone already.
          }
        }
      }
    },
    60_000
  )
})
