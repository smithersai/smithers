import { describe, expect, it } from "@effect/vitest"
import * as ContainedSpawner from "@smthrs/kernel/ContainedSpawner"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Sink, Stream } from "effect"
import * as PlatformError from "effect/PlatformError"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner, ExitCode, make, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import * as Cleanup from "../src/internal/ProcessCleanup.ts"
import { bootstrapArguments, failure, targetPidOf } from "../src/internal/ProcessSupervisor.ts"

const refusal = PlatformError.systemError({ _tag: "Unknown", module: "ChildProcess", method: "kill" })

describe("prepared process policy", () => {
  it.effect("isolates ordinary runtimes and refuses compiled application recursion", () =>
    Effect.gen(function*() {
      expect(yield* bootstrapArguments({ bun: false, main: "", sea: false })).toEqual([])
      expect(yield* bootstrapArguments({ bun: true, main: "/app/entry.ts", sea: false }))
        .toEqual(["--no-env-file", "--config=/dev/null"])
      for (
        const runtime of [
          { bun: false, main: "", sea: true },
          { bun: true, main: "/$bunfs/root/app.ts", sea: false }
        ]
      ) {
        const result = yield* Effect.exit(bootstrapArguments(runtime))
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) expect(Cause.hasDies(result.cause)).toBe(false)
      }
    }))
  it.effect("resolves defaults, duration inputs and explicit zero grace", () =>
    Effect.gen(function*() {
      expect(yield* Cleanup.policy({})).toEqual({ killSignal: "SIGTERM", graceMs: 2000 })
      expect(yield* Cleanup.policy({}, { killSignal: "SIGINT", forceKillAfter: "3 seconds" }))
        .toEqual({ killSignal: "SIGINT", graceMs: 3000 })
      expect(yield* Cleanup.policy({ killSignal: "SIGKILL", forceKillAfter: 0 }, { forceKillAfter: 20 }))
        .toEqual({ killSignal: "SIGKILL", graceMs: 0 })
    }))

  for (
    const options of [
      { killSignal: "SIGSTOP" },
      { killSignal: "SIGINVALID" },
      { forceKillAfter: Number.POSITIVE_INFINITY },
      { forceKillAfter: -1 },
      { forceKillAfter: 2_147_483_648 },
      { forceKillAfter: "not a duration" }
    ]
  ) {
    it.effect(`refuses invalid policy through the typed error channel: ${JSON.stringify(options)}`, () =>
      Effect.gen(function*() {
        const result = yield* Effect.exit(Cleanup.policy(options as ChildProcess.KillOptions))
        expect(Exit.isFailure(result)).toBe(true)
        if (Exit.isFailure(result)) {
          expect(Cause.hasDies(result.cause)).toBe(false)
          expect(Cause.hasFails(result.cause)).toBe(true)
        }
      }))
  }

  for (
    const [code, tag] of [
      ["ENOENT", "NotFound"],
      ["EACCES", "PermissionDenied"],
      ["EEXIST", "AlreadyExists"],
      ["EISDIR", "BadResource"],
      ["ENOTDIR", "BadResource"],
      ["ELOOP", "BadResource"],
      ["EBUSY", "Busy"],
      ["other", "Unknown"]
    ]
  ) {
    it(`preserves native ${code} as ${tag}`, () => {
      const error = failure("spawn", "/command", {
        code,
        syscall: "spawn /command",
        errno: -2,
        message: "native failure"
      })
      expect(error.reason).toMatchObject({
        _tag: tag,
        module: "ChildProcess",
        method: "spawn",
        pathOrDescriptor: "/command",
        syscall: "spawn /command",
        cause: { code, errno: -2, message: "native failure" }
      })
    })
  }
  it("keeps existing errors and actual signal causes", () => {
    const cause = Object.assign(new Error("stopped"), { signal: "SIGINT" })
    expect(failure("exitCode", "command", cause).reason).toMatchObject({ cause })
    expect(failure("spawn", "command", null).reason).toMatchObject({
      _tag: "Unknown",
      cause: { message: "The process supervisor failed" }
    })
  })
})

const windows = (
  running: boolean,
  use: (handle: ReturnType<typeof makeHandle>) => Effect.Effect<unknown, unknown> = () => Effect.void,
  onKill: () => Effect.Effect<void, PlatformError.PlatformError> = () => Effect.void
) =>
  Effect.gen(function*() {
    const calls: Array<ChildProcess.KillOptions | "unref"> = []
    const handle = makeHandle({
      pid: ProcessId(4321),
      exitCode: Effect.succeed(ExitCode(0)),
      isRunning: Effect.succeed(running),
      kill: (options) => Effect.andThen(Effect.sync(() => calls.push(options ?? {})), onKill()),
      stdin: Sink.drain,
      stdout: Stream.empty,
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.sync(() => {
        calls.push("unref")
        return Effect.void
      })
    })
    const spawned: Array<ChildProcess.Command> = []
    const ledger = yield* ProcessLedger.makeMemory({ hostId: "windows-test", ownerPid: 99 })
    const outcome = yield* Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const child = yield* spawner.spawn(ChildProcess.make("literal", ["arg"], { detached: false, windowsHide: false }))
      expect(child.pid).toBe(handle.pid)
      expect(targetPidOf(child)).toBeUndefined()
      yield* use(child)
    }).pipe(
      Effect.provide(ContainedSpawner.layer(
        { graceMs: 7, platform: "win32" },
        Cleanup.lifecycle({
          platform: "win32",
          snapshot: () => {
            throw new Error("Windows must not inspect POSIX groups")
          },
          vacant: () => {
            throw new Error("Windows must not inspect POSIX groups")
          }
        })
      )),
      Effect.provide(
        Layer.succeed(ChildProcessSpawner)(make((command) => {
          spawned.push(command)
          return Effect.succeed(handle)
        }))
      ),
      Effect.provideService(ProcessLedger.ProcessLedger, ledger),
      Effect.scoped,
      Effect.exit
    )
    return { outcome, calls, spawned, live: yield* ledger.live }
  })

describe("native Windows fallback", () => {
  for (const running of [true, false]) {
    it.effect(`retains the original launch/options and releases running=${running}`, () =>
      Effect.gen(function*() {
        const result = yield* windows(running)
        expect(Exit.isSuccess(result.outcome)).toBe(true)
        expect(result.spawned).toHaveLength(1)
        expect(result.spawned[0]).toMatchObject({
          command: "literal",
          args: ["arg"],
          options: {
            detached: false,
            windowsHide: false,
            killSignal: "SIGTERM",
            forceKillAfter: 7
          }
        })
        expect(result.calls).toHaveLength(running ? 1 : 0)
        expect(result.live).toEqual([])
      }))
  }
  it.effect("honors one explicit kill and reuses its completion", () =>
    Effect.gen(function*() {
      const result = yield* windows(true, (handle) =>
        Effect.andThen(
          handle.kill({ killSignal: "SIGINT", forceKillAfter: 0 }),
          handle.kill({ killSignal: "SIGTERM" })
        ))
      expect(result.calls).toEqual([{ killSignal: "SIGINT", forceKillAfter: 0 }])
      expect(result.live).toEqual([])
    }))
  it.effect("retains a failed cleanup and disables the raw finalizer", () =>
    Effect.gen(function*() {
      const result = yield* windows(true, undefined, () => Effect.fail(refusal))
      expect(Exit.isFailure(result.outcome)).toBe(true)
      expect(result.calls.at(-1)).toBe("unref")
      expect(result.live).toHaveLength(1)
    }))
  it.live("completes an interrupted explicit kill before scope release", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const done = yield* Deferred.make<void>()
      const result = yield* windows(true, (handle) =>
        Effect.gen(function*() {
          const fiber = yield* handle.kill().pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(started)
          const interrupted = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.succeed(done, undefined)
          yield* Fiber.join(interrupted)
        }), () => Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(done)))
      expect(result.calls).toHaveLength(1)
      expect(result.live).toEqual([])
    }))
})
