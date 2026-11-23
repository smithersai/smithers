/**
 * A baseline job's keeper where it cannot be had: a job with no jail, a jail that cannot start a program, and a
 * keeper that never listens. Each ends in bounded time with no keeper, so a program a step leaves running ends with
 * its step and nothing waits without a limit.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import { ChildProcessSpawner, make as makeSpawner } from "effect/process/ChildProcessSpawner"
import type * as Scope from "effect/Scope"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import type { Confined } from "../../src/replay/Confine.vibe"
import { reaperProgram } from "../../src/replay/Environment.ts"
import { endLeftIn, keeperIn, keepsPrograms, processesBefore, reapedBy, reaperIn } from "../../src/replay/Job.vibe"
import { placeIn } from "./place.ts"

const made: Array<string> = []
afterAll(() => made.forEach((directory) => rmSync(directory, { recursive: true, force: true })))

const work = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "replay-job-"))
  made.push(directory)
  return directory
}

const onNode = <A, E>(
  body: Effect.Effect<A, E, NodeServices.NodeServices | Scope.Scope>,
  spawner?: Layer.Layer<ChildProcessSpawner>
): Promise<A> => {
  const scoped = Effect.scoped(body)
  const withSpawner = spawner === undefined ? scoped : Effect.provide(scoped, spawner)
  return Effect.runPromise(Effect.provide(withSpawner, NodeServices.layer) as Effect.Effect<A, E>)
}

/** The baseline's place under `root`, in a jail whose bubblewrap is `program`. */
const jailedBy = (root: string, program: string): Confined => ({
  ...placeIn(root, "baseline"),
  jail: {
    bwrap: program,
    masks: [],
    tmp: join(root, "tmp", "baseline"),
    temporary: [],
    visible: [],
    filter: "/dev/null"
  }
})

const denied = PlatformError.systemError({ _tag: "PermissionDenied", module: "test", method: "spawn" })

/** Says nothing: a test that expects no line. */
const quiet = (_line: string): Effect.Effect<void> => Effect.void

describe("a job's keeper where it cannot be had", () => {
  it("is not started for a job with no jail, and such a jail keeps no program", async () => {
    const root = work()
    const place = placeIn(root, "baseline")
    expect(await onNode(keeperIn(place, [], join(root, "jobs"), quiet))).toBeUndefined()
    expect(await onNode(keepsPrograms(place))).toBe(false)
    expect(existsSync(join(root, "jobs"))).toBe(false)
  })

  it("reports the keeper directory when cleanup cannot remove it", async () => {
    const root = work()
    const jobs = join(root, "jobs")
    const said: Array<string> = []
    const locked = Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function*() {
        const real = yield* FileSystem.FileSystem
        return { ...real, remove: () => Effect.fail(denied) }
      })
    )
    await onNode(
      Effect.provide(
        Effect.scoped(
          keeperIn(jailedBy(root, "/bin/true"), [], jobs, (line) => Effect.sync(() => void said.push(line)))
        ),
        locked
      )
    )
    expect(said).toEqual([
      `smithers-ci: replay left a keeper directory it could not remove: ${join(jobs, readdirSync(jobs)[0]!)}`
    ])
  })

  it("keeps no program where the jail's probe cannot start at all", async () => {
    const root = work()
    const noPrograms = Layer.succeed(ChildProcessSpawner, makeSpawner(() => Effect.fail(denied)))
    expect(await onNode(keepsPrograms(jailedBy(root, "/bin/true")), noPrograms)).toBe(false)
    expect(await onNode(keepsPrograms(jailedBy(work(), "/bin/false")))).toBe(false)
  })

  it.each([
    { state: "exited", command: "exit 0" },
    { state: "live but unresponsive", command: "exec /bin/sleep 60" }
  ])("cleans up a $state keeper, waiting for readiness only while it is live", async ({ state, command }) => {
    const root = work()
    // A bubblewrap that starts nothing: the keeper's socket never appears.
    const deaf = join(root, "bwrap")
    writeFileSync(deaf, `#!/bin/sh\n${command}\n`)
    chmodSync(deaf, 0o755)
    const started = Date.now()
    expect(await onNode(keeperIn(jailedBy(root, deaf), [], join(root, "jobs"), quiet))).toBeUndefined()
    const waited = Date.now() - started
    if (state === "exited") expect(waited).toBeLessThan(10_000)
    else expect(waited).toBeGreaterThanOrEqual(10_000)
    expect(waited).toBeLessThan(60_000)
    expect(readdirSync(join(root, "jobs"))).toEqual([])
  })
})

/** A program at `path` that runs this shell text. */
const program = (path: string, text: string): string => {
  writeFileSync(path, `#!/bin/sh\n${text}\n`)
  chmodSync(path, 0o755)
  return path
}

describe("the program a step runs under where nothing keeps what it leaves running", () => {
  it("is smthrs-observe where it answers --reap, for a place with no jail only", async () => {
    const root = work()
    const answering = program(
      join(root, "answering"),
      "[ \"$1\" = --probe ] && [ \"$2\" = --reap ] && exit 0\nexit 125"
    )
    const older = program(join(root, "older"), "exit 125")
    const place = placeIn(root, "baseline")
    expect(await onNode(reaperIn(place, () => answering))).toBe(answering)
    expect(await onNode(reaperIn(place, () => older))).toBeUndefined()
    expect(await onNode(reaperIn(place, () => undefined))).toBeUndefined()
    // A jail's process namespace ends what a step leaves with the step.
    expect(await onNode(reaperIn(jailedBy(root, "/bin/true"), () => answering))).toBeUndefined()
    const noPrograms = Layer.succeed(ChildProcessSpawner, makeSpawner(() => Effect.fail(denied)))
    expect(await onNode(reaperIn(place, () => answering), noPrograms)).toBeUndefined()
    expect(reapedBy(["sh", "-c", "true"], answering)).toEqual([answering, "--reap", "--", "sh", "-c", "true"])
    expect(reapedBy(["sh", "-c", "true"], undefined)).toEqual(["sh", "-c", "true"])
  })

  it("is found beside the smthrs this program runs, on Linux for x86_64 and aarch64", () => {
    const root = work()
    // An installation as npm lays it out: @smthrs/cli, and the @smthrs/build-cli it depends on.
    const cli = join(root, "node_modules", "@smthrs", "cli")
    const build = join(root, "node_modules", "@smthrs", "build-cli")
    for (const directory of [cli, join(build, "native", "out", "linux-x64")]) mkdirSync(directory, { recursive: true })
    writeFileSync(join(cli, "package.json"), JSON.stringify({ name: "@smthrs/cli" }))
    writeFileSync(join(build, "package.json"), JSON.stringify({ name: "@smthrs/build-cli" }))
    const built = program(join(build, "native", "out", "linux-x64", "smthrs-observe"), "exit 0")
    const resolve = (specifier: string): string => {
      if (specifier !== "@smthrs/cli/package.json") throw new Error(`cannot find ${specifier}`)
      return join(cli, "package.json")
    }
    expect(reaperProgram(resolve, "linux", "x64")).toBe(built)
    expect(reaperProgram(resolve, "linux", "arm64")).toBeUndefined()
    expect(reaperProgram(resolve, "linux", "ia32")).toBeUndefined()
    expect(reaperProgram(resolve, "darwin", "arm64")).toBeUndefined()
    expect(reaperProgram(
      () => {
        throw new Error("no @smthrs/cli")
      },
      "linux",
      "x64"
    )).toBeUndefined()
    // This program's own installation: one built for this machine, or none.
    const own = reaperProgram()
    if (own !== undefined) expect(own).toMatch(/native\/out\/linux-(x64|arm64)\/smthrs-observe$/)
  })
})

describe.runIf(process.platform === "linux")("what a step leaves where nothing else ends it", () => {
  it(
    "is listed before the step only where no keeper and no reaper ends it, and ended in the job's directory",
    async () => {
      const root = work()
      const seconds = 95_000 + (process.pid % 900)
      expect(await onNode(processesBefore({ directory: root, pid: 1 }, undefined))).toBeUndefined()
      expect(await onNode(processesBefore(undefined, "/r/smthrs-observe"))).toBeUndefined()
      const before = await onNode(processesBefore(undefined, undefined))
      expect(before?.get(process.pid)).toBe(process.ppid)
      // A step that left a program in a session of its own, in the job's directory.
      spawnSync("/bin/sh", ["-c", `setsid -f sleep ${seconds} > /dev/null 2>&1 < /dev/null`], { cwd: root })
      const alive = (): string =>
        spawnSync("pgrep", ["-x", "-f", `sleep ${seconds}`], { encoding: "utf8" }).stdout.trim()
      for (let waited = 0; alive() === "" && waited < 5_000; waited += 50) await new Promise((r) => setTimeout(r, 50))
      expect(alive()).not.toBe("")
      await onNode(endLeftIn(undefined, root))
      expect(alive()).not.toBe("")
      await onNode(endLeftIn(before, root))
      for (let waited = 0; alive() !== "" && waited < 5_000; waited += 50) await new Promise((r) => setTimeout(r, 50))
      expect(alive()).toBe("")
    },
    60_000
  )
})

describe.runIf(process.platform === "linux")("the end of a job's keeper", () => {
  it("names what still runs ten seconds after the job was told to end, and goes on", async () => {
    const root = work()
    const seconds = 96_000 + (process.pid % 900)
    // A bubblewrap that says it listens, leaves a program in a session of its own that its end does not reach, and
    // runs on.
    const leaving = join(root, "bwrap")
    // Every program by its path, and a session of its own made by the program itself, so nothing depends on the PATH
    // or on how setsid(1) starts it.
    const python = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" }).stdout.trim()
    const sleep = spawnSync("sh", ["-c", "command -v sleep"], { encoding: "utf8" }).stdout.trim()
    const daemon = `import os, time; os.setsid(); open("ready", "w").close(); time.sleep(${seconds})`
    // It says it listens only once the program is in its session, out of reach of the end of the keeper's group.
    writeFileSync(
      leaving,
      `#!/bin/sh\n${python} -c '${daemon}' > /dev/null 2>&1 < /dev/null &\n` +
        `while [ ! -e ready ]; do ${sleep} 0.05; done\n: > keeper.sock\nexec ${sleep} ${seconds + 1}\n`
    )
    chmodSync(leaving, 0o755)
    const lines: Array<string> = []
    const said = (line: string): Effect.Effect<void> => Effect.sync(() => void lines.push(line))
    try {
      const keeper = await onNode(keeperIn(jailedBy(root, leaving), [], join(root, "jobs"), said))
      expect(keeper?.pid).toBeGreaterThan(1)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatch(
        new RegExp(
          `^smithers-ci: what a step left running did not end within 10 seconds and still runs: [0-9]+ \\S*python3 -c ${
            daemon.replace(/[.()]/g, "\\$&")
          }$`
        )
      )
    } finally {
      spawnSync("pkill", ["-f", `time.sleep.${seconds}`])
    }
  }, 60_000)
})
