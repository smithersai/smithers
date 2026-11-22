/**
 * A baseline job's keeper where it cannot be had: a job with no jail, a jail that cannot start a program, and a
 * keeper that never listens. Each ends in bounded time with no keeper, so a program a step leaves running ends with
 * its step and nothing waits without a limit.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
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

describe("a job's keeper where it cannot be had", () => {
  it("is not started for a job with no jail, and such a jail keeps no program", async () => {
    const root = work()
    const place = placeIn(root, "baseline")
    expect(await onNode(keeperIn(place, [], join(root, "jobs")))).toBeUndefined()
    expect(await onNode(keepsPrograms(place))).toBe(false)
    expect(existsSync(join(root, "jobs"))).toBe(false)
  })

  it("keeps no program where the jail's probe cannot start at all", async () => {
    const root = work()
    const noPrograms = Layer.succeed(ChildProcessSpawner, makeSpawner(() => Effect.fail(denied)))
    expect(await onNode(keepsPrograms(jailedBy(root, "/bin/true")), noPrograms)).toBe(false)
  })

  it("gives up on a keeper that never listens after ten seconds, and leaves no directory of it", async () => {
    const root = work()
    // A bubblewrap that starts nothing: the keeper's socket never appears.
    const quiet = join(root, "bwrap")
    writeFileSync(quiet, "#!/bin/sh\nexit 0\n")
    chmodSync(quiet, 0o755)
    const started = Date.now()
    expect(await onNode(keeperIn(jailedBy(root, quiet), [], join(root, "jobs")))).toBeUndefined()
    const waited = Date.now() - started
    expect(waited).toBeGreaterThanOrEqual(10_000)
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
