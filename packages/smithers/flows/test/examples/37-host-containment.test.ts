import { afterAll, describe, expect, it } from "@effect/vitest"
import { NodeHost } from "@smthrs/platform-node"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { killHost, main } from "../../examples/37-host-containment.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-examples-containment-"))
const realSpawner = NodeHost.NodeChildProcessSpawner.layer.pipe(
  Layer.provide(Layer.mergeAll(NodeHost.NodeFileSystem.layer, NodeHost.NodePath.layer))
)
const fault = PlatformError.systemError({
  _tag: "Unknown",
  module: "ChildProcessSpawner",
  method: "stdout",
  description: "startup failed"
})

describe("host startup cleanup", () => {
  const setup = (code: string, options: {
    readonly startupFailure?: boolean
    readonly delayExit?: boolean
    readonly delayReaper?: boolean
  } = {}) =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const killed = yield* Deferred.make<void>()
      const finishExit = yield* Deferred.make<void>()
      const reaping = yield* Deferred.make<void>()
      const finishReaper = yield* Deferred.make<void>()
      const events: Array<string> = []
      let pid = 0
      const spawner = Layer.effect(
        ChildProcessSpawner.ChildProcessSpawner,
        Effect.gen(function*() {
          const real = yield* ChildProcessSpawner.ChildProcessSpawner
          return ChildProcessSpawner.make(() =>
            Effect.gen(function*() {
              const child = yield* real.spawn(
                ChildProcess.make(process.execPath, ["-e", code], { killSignal: "SIGKILL" })
              )
              pid = child.pid
              const handle = ChildProcessSpawner.makeHandle({
                ...child,
                stdout: options.startupFailure ? Stream.fail(fault) : child.stdout,
                kill: (signal) =>
                  child.kill(signal).pipe(Effect.tap(() =>
                    Effect.gen(function*() {
                      events.push("kill")
                      yield* Deferred.succeed(killed, undefined)
                    })
                  )),
                exitCode: child.exitCode.pipe(Effect.ensuring(Effect.gen(function*() {
                  if (options.delayExit) yield* Deferred.await(finishExit)
                  events.push("exit")
                })))
              })
              yield* Deferred.succeed(started, undefined)
              return handle
            })
          )
        })
      ).pipe(Layer.provide(realSpawner))
      const reap = Effect.gen(function*() {
        // The real process must be gone before any reaper starts.
        expect(() => process.kill(pid, 0)).toThrow()
        events.push("reap")
        yield* Deferred.succeed(reaping, undefined)
        if (options.delayReaper) yield* Deferred.await(finishReaper)
      })
      const fiber = yield* killHost(join(directory, "startup.sqlite"), reap).pipe(
        Effect.scoped,
        Effect.provide(spawner),
        Effect.forkScoped
      )
      yield* Deferred.await(started)
      return { fiber, events, killed, finishExit, reaping, finishReaper }
    })

  it.effect("kills and reaps even when interrupted before the PID announcement", () =>
    Effect.gen(function*() {
      const f = yield* setup("setInterval(() => {}, 1000)")
      yield* Fiber.interrupt(f.fiber)
      expect(f.events).toEqual(["kill", "exit", "reap"])
    }))

  it.effect("terminates and reaps a silent host at the startup deadline", () =>
    Effect.gen(function*() {
      const f = yield* setup("setInterval(() => {}, 1000)")
      yield* TestClock.adjust("30 seconds")
      const exit = yield* Fiber.await(f.fiber)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.pretty(exit.cause)).toContain("TimeoutError")
      expect(f.events).toEqual(["kill", "exit", "reap"])
    }))

  it.effect("waits for host termination before starting the reaper on interruption", () =>
    Effect.gen(function*() {
      const f = yield* setup("setInterval(() => {}, 1000)", { delayExit: true })
      const interrupt = yield* Fiber.interrupt(f.fiber).pipe(Effect.forkScoped)
      yield* Deferred.await(f.killed)
      expect(f.events).toEqual(["kill"])
      expect(f.fiber.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(f.finishExit, undefined)
      yield* Fiber.join(interrupt)
      expect(f.events).toEqual(["kill", "exit", "reap"])
    }))

  it.effect("runs the reaper exactly once when the spawner rejects acquisition", () =>
    Effect.gen(function*() {
      let reaped = 0
      const rejected = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.fail(fault))
      )
      const exit = yield* killHost(
        join(directory, "rejected.sqlite"),
        Effect.sync(() => {
          reaped += 1
        })
      ).pipe(
        Effect.scoped,
        Effect.provide(rejected),
        Effect.exit
      )
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.pretty(exit.cause)).toContain("startup failed")
      expect(reaped).toBe(1)
    }))

  it.effect("reaps on a startup stream error", () =>
    Effect.gen(function*() {
      const f = yield* setup("setInterval(() => {}, 1000)", { startupFailure: true })
      const exit = yield* Fiber.await(f.fiber)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.pretty(exit.cause)).toContain("startup failed")
      expect(f.events).toEqual(["kill", "exit", "reap"])
    }))

  it.effect("reaps when the host closes before announcing its group", () =>
    Effect.gen(function*() {
      const f = yield* setup("process.stderr.write(\"startup diagnostics\")")
      const exit = yield* Fiber.await(f.fiber)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.pretty(exit.cause)).toContain("startup diagnostics")
      expect(f.events.at(-1)).toBe("reap")
      expect(f.events).not.toContain("kill")
    }))

  it.effect("finishes the reaper even if interrupted after the PID announcement", () =>
    Effect.gen(function*() {
      const f = yield* setup("console.log(process.pid); setInterval(() => {}, 1000)", { delayReaper: true })
      yield* Deferred.await(f.reaping)
      const interrupt = yield* Fiber.interrupt(f.fiber).pipe(Effect.forkScoped)
      expect(f.fiber.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(f.finishReaper, undefined)
      yield* Fiber.join(interrupt)
      expect(f.events.filter((event) => event === "kill")).toHaveLength(1)
      expect(f.events.at(-1)).toBe("reap")
    }))

  it.effect("reaps once on success after reading a real announcement", () =>
    Effect.gen(function*() {
      const f = yield* setup(
        "process.stdout.write(String(process.pid)); process.stdout.write(String.fromCharCode(10)); setInterval(() => {}, 1000)"
      )
      const result = yield* Fiber.join(f.fiber)
      expect(result.pgid).toBeGreaterThan(0)
      expect(result.hostStderr).toBe("")
      expect(f.events.filter((event) => event === "kill")).toHaveLength(1)
      expect(f.events.at(-1)).toBe("reap")
    }))

  it.effect("rejects an invalid group and still terminates the real host", () =>
    Effect.gen(function*() {
      const f = yield* setup("console.log(\"invalid\"); setInterval(() => {}, 1000)")
      const exit = yield* Fiber.await(f.fiber)
      expect(exit._tag).toBe("Failure")
      if (exit._tag === "Failure") expect(Cause.pretty(exit.cause)).toContain("invalid group")
      expect(f.events).toEqual(["kill", "exit", "reap"])
    }))
})

afterAll(() => rmSync(directory, { recursive: true, force: true }))

it("reaps the process group a killed host left running", async () => {
  const summary = await Effect.runPromise(main(join(directory, "containment", "host.sqlite")))

  // The killed host really did leave a live process group behind: without that
  // the reaping below would be a statement about nothing.
  // Node reports experimental SQLite and unavailable localStorage on stderr
  // even when this host starts successfully. Permit only those warnings; every other byte
  // remains a failed diagnostic assertion.
  expect(summary.hostStderr.replace(
    /^\(node:\d+\) ExperimentalWarning: (?:SQLite is an experimental feature and might change at any time|localStorage is not available because --localstorage-file was not provided\.)\r?\n\(Use \x60node --trace-warnings \.\.\.\x60 to show where the warning was created\)\r?\n/gm,
    ""
  )).toBe("")
  expect(summary.orphaned).toBe(true)
  expect(summary.survivedTheReaper).toBe(false)
  // This flow uses processes, so jj is never probed. The dead host's process
  // group is spawned and then reaped on their shared journal run.
  expect(summary.hostEvents).toEqual([
    "flows.host.process-spawned.v1",
    "flows.host.process-snapshot.v1",
    "flows.host.process-reaped.v1"
  ])
}, 120_000)

it("reports a host startup failure on stderr and exits unsuccessfully", () => {
  const databaseDirectory = join(directory, "database-directory")
  mkdirSync(databaseDirectory)
  const child = spawnSync(process.execPath, [
    "--import",
    import.meta.resolve("vibelang/register"),
    new URL("../../examples/37-host-containment-host.ts", import.meta.url).pathname,
    databaseDirectory,
    "failed-host"
  ], {
    env: process.env,
    encoding: "utf8",
    timeout: 30_000
  })
  expect(child.error).toBeUndefined()
  expect(child.signal).toBeNull()
  expect(child.status).toBe(1)
  expect(child.stdout).toBe("")
  expect(child.stderr).toContain("unable to open database file")
})
