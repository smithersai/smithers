import * as ScopedProcess from "@smthrs/platform-node/ScopedProcess"
import { Cause, Deferred, Effect, Exit, Fiber, PlatformError, Sink, Stream } from "effect"
import { ExitCode, makeHandle, ProcessId } from "effect/process/ChildProcessSpawner"
import { expect, it } from "vitest"
import * as ContainedProcess from "../src/internal/ContainedProcess.ts"

const fixture = (
  kill: ScopedProcess.Handle["kill"],
  exitCode: ScopedProcess.Handle["exitCode"] = Effect.succeed(ExitCode(0))
) => {
  const handle = Object.assign(
    makeHandle({
      pid: ProcessId(12345),
      exitCode,
      // A completed target still requires its owner's tree cleanup.
      isRunning: Effect.succeed(false),
      kill,
      stdin: Sink.drain,
      stdout: Stream.empty,
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void)
    }),
    { targetPid: 12346 }
  )
  return {
    spawn: () => Effect.succeed(handle),
    command: "fixture",
    args: ["literal argument"],
    cwd: "/fixture",
    stdout: () => {},
    stderr: () => {}
  }
}

const runEffect = (options: ReturnType<typeof fixture>) =>
  ContainedProcess.runEffect(options).pipe(
    Effect.provideService(ContainedProcess.ProcessSpawner, { spawn: options.spawn })
  )

const run = async (options: ReturnType<typeof fixture>) => {
  const result = await Effect.runPromiseExit(runEffect(options))
  if (Exit.isFailure(result)) throw Cause.squash(result.cause)
  return result.value
}

it.skipIf(process.platform === "win32")(
  "joins process cleanup on native fiber interruption",
  () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const killing = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const options = fixture(() =>
        Deferred.succeed(killing, undefined).pipe(
          Effect.andThen(Deferred.await(release))
        ), Effect.never)
      const process = yield* runEffect(options).pipe(Effect.forkScoped({ startImmediately: true }))
      let closed = false
      const closing = yield* Fiber.interrupt(process).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            closed = true
          })
        ),
        Effect.forkScoped({ startImmediately: true })
      )
      yield* Deferred.await(killing)
      expect(closed).toBe(false)
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(closing)
      expect(closed).toBe(true)
    })))
)

it.skipIf(process.platform === "win32")(
  "awaits the owner's declared stop contract even after the target exits",
  async () => {
    let release!: () => void
    let stopped = false
    const killed = new Promise<void>((resolve) => {
      release = resolve
    })
    const killing = Promise.withResolvers<void>()
    const kill: ScopedProcess.Handle["kill"] = (options) =>
      Effect.sync(() => {
        expect(options).toEqual({ killSignal: "SIGTERM", forceKillAfter: 5000 })
        killing.resolve()
      }).pipe(Effect.andThen(Effect.promise(() => killed)))
    const options = fixture(kill)
    const pending = run(options).then((code) => {
      stopped = true
      return code
    })
    await killing.promise
    expect(stopped).toBe(false)

    release()
    expect(await pending).toBe(0)
    expect(stopped).toBe(true)
  }
)

it.skipIf(process.platform === "win32")(
  "preserves refused cleanup instead of reporting an exited command as successful",
  async () => {
    const denied = PlatformError.systemError({
      _tag: "PermissionDenied",
      module: "ChildProcess",
      method: "kill",
      cause: Object.assign(new Error("cleanup observation denied"), { code: "EPERM" })
    })
    const options = fixture(() => Effect.fail(denied))
    await expect(run(options)).rejects.toMatchObject({
      _tag: "smithers-build/ProcessError",
      code: "cleanup_failed",
      cause: denied
    })
  }
)

it.skipIf(process.platform === "win32")(
  "retains a supervisor failure rather than inventing a nonzero target exit",
  async () => {
    const failure = PlatformError.systemError({
      _tag: "Unknown",
      module: "ChildProcess",
      method: "exitCode",
      cause: new Error("owner lost before target status")
    })
    let kills = 0
    const kill = () =>
      Effect.sync(() => {
        kills++
      })
    const options = fixture(kill, Effect.fail(failure))
    await expect(run(options)).rejects.toMatchObject({
      _tag: "smithers-build/ProcessError",
      code: "process_failed",
      cause: failure
    })
    expect(kills).toBe(1)
  }
)
