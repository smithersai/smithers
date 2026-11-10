import { afterEach, describe, expect, it } from "@effect/vitest"
import { Effect, Fiber, PlatformError, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import * as ProviderConformance from "../src/ProviderConformance/index.ts"
import * as RemoteChildProcessSpawner from "../src/RemoteChildProcessSpawner/index.ts"
import type { Provider, RemoteProcess } from "../src/RemoteChildProcessSpawner/Provider.vibe"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.vibe"
import * as SandboxHealth from "../src/SandboxHealth/index.ts"

// Real process startup and V8 coverage can contend with other Vitest workers;
// every case remains bounded without treating normal loaded-machine work as a
// hang. Sixty seconds, not twenty: the megabyte-scale case below spawns a real
// Node process and streams a megabyte through it under an instrumented
// runtime, and at twenty it failed on a machine running the rest of this suite
// in parallel while passing on its own — a budget that convicts the machine
// rather than the code. Nothing here waits on a hang: a genuinely stuck case
// is one this file's provider never answers, and it fails just as surely at
// sixty.
const testBudget = 60_000
const pollBudget = 5_000

interface ChildExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

interface ManagedChild {
  readonly command: string
  readonly child: ChildProcessWithoutNullStreams
  exit: ChildExit | undefined
  error: unknown | undefined
  stdoutChunks: number
}

interface RealProviderState {
  readonly active: Set<ManagedChild>
  readonly started: Array<ManagedChild>
  unavailable: boolean
  releases: number
}

interface RealProvider {
  readonly provider: Provider
  readonly pingProvider: SandboxHealth.PingProvider
  readonly state: RealProviderState
}

const liveChildren = new Set<ChildProcessWithoutNullStreams>()

const isErrno = (cause: unknown, code: string): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === code

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (cause) {
    return !isErrno(cause, "ESRCH")
  }
}

const childPid = (child: ChildProcessWithoutNullStreams): number => {
  if (child.pid === undefined) throw new Error("real provider child did not receive an OS pid")
  return child.pid
}

/** Polls a host-visible condition; the delay only spaces bounded retries. */
const waitFor = async (condition: () => boolean, description: string, timeoutMs = pollBudget): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`)
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
}

const stopChild = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL")
    } catch {
      // It may have exited between the observable state check and kill.
    }
  }
  await waitFor(
    () => child.exitCode !== null || child.signalCode !== null,
    `child ${child.pid ?? "without a pid"} to exit`
  )
}

afterEach(async () => {
  await Promise.all(Array.from(liveChildren, stopChild))
  liveChildren.clear()
})

const unavailable = (): ProviderError =>
  new ProviderError({ code: "unavailable", message: "real provider session is unavailable" })

const terminated = (record: ManagedChild): ProviderError =>
  new ProviderError({
    code: "aborted",
    message: `real provider command \`${record.command}\` terminated by ${record.exit?.signal ?? "an unknown signal"}`
  })

const spawnFailed = (record: ManagedChild): ProviderError =>
  new ProviderError({
    code: "spawn_error",
    message: `real provider command \`${record.command}\` could not start`,
    cause: record.error
  })

const streamFailed = (record: ManagedChild, output: "stdout" | "stderr", cause: unknown): ProviderError =>
  new ProviderError({
    code: "unknown",
    message: `real provider ${output} for \`${record.command}\` failed`,
    cause
  })

const exitCode = (record: ManagedChild): Effect.Effect<number, ProviderError> =>
  Effect.callback((resume) => {
    const settle = () => {
      record.child.off("exit", settle)
      record.child.off("error", settle)
      if (record.error !== undefined) {
        resume(Effect.fail(spawnFailed(record)))
      } else if (record.exit?.signal !== null && record.exit?.signal !== undefined) {
        resume(Effect.fail(terminated(record)))
      } else if (record.exit?.code !== undefined && record.exit.code !== null) {
        resume(Effect.succeed(record.exit.code))
      } else {
        resume(Effect.fail(
          new ProviderError({
            code: "unknown",
            message: `real provider command \`${record.command}\` exited without a status`
          })
        ))
      }
    }

    if (record.error !== undefined || record.exit !== undefined) {
      settle()
      return
    }
    record.child.once("exit", settle)
    record.child.once("error", settle)
    return Effect.sync(() => {
      record.child.off("exit", settle)
      record.child.off("error", settle)
    })
  })

async function* stdoutOf(record: ManagedChild): AsyncGenerator<Uint8Array, void, void> {
  for await (const chunk of record.child.stdout) {
    record.stdoutChunks += 1
    yield new Uint8Array(chunk)
  }
}

/** Lets `kill` find the OS child behind the value `spawn` handed back. */
const childrenOf = new WeakMap<RemoteProcess, ManagedChild>()

const processOf = (record: ManagedChild): RemoteProcess => {
  const remote: RemoteProcess = {
    stdout: Stream.fromAsyncIterable(stdoutOf(record), (cause) => streamFailed(record, "stdout", cause)),
    stderr: Stream.fromAsyncIterable(record.child.stderr, (cause) => streamFailed(record, "stderr", cause)),
    exitCode: exitCode(record)
  }
  childrenOf.set(remote, record)
  return remote
}

const terminateChild = (child: ChildProcessWithoutNullStreams): void => {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    child.kill("SIGKILL")
  } catch {
    // It may have exited between the observable state check and kill.
  }
}

const makeRealProvider = (scripts: Readonly<Record<string, string>>): RealProvider => {
  const state: RealProviderState = {
    active: new Set(),
    started: [],
    unavailable: false,
    releases: 0
  }

  const provider: Provider = {
    session: "real-process-provider",
    open: () =>
      Effect.suspend(() =>
        state.unavailable
          ? Effect.fail(unavailable())
          : Effect.acquireRelease(
            Effect.void,
            () =>
              Effect.sync(() => {
                state.releases += 1
                for (const record of state.active) terminateChild(record.child)
              })
          )
      ),
    ping: Effect.suspend(() => state.unavailable ? Effect.fail(unavailable()) : Effect.void),
    kill: (remote, signal) =>
      Effect.suspend(() => {
        const record = childrenOf.get(remote)
        if (record === undefined) {
          return Effect.fail(
            new ProviderError({ code: "unknown", message: "kill was given a process this provider did not start" })
          )
        }
        return Effect.try({
          try: () => {
            record.child.kill(signal)
          },
          catch: (cause) =>
            new ProviderError({ code: "unknown", message: `failed to signal \`${record.command}\``, cause })
        })
      }),
    spawn: (command, options) =>
      Effect.suspend(() => {
        if (state.unavailable) return Effect.fail(unavailable())
        const script = scripts[command]
        if (script === undefined) {
          return Effect.fail(
            new ProviderError({
              code: "spawn_error",
              message: `no real-process script was configured for \`${command}\``
            })
          )
        }
        return Effect.acquireRelease(
          Effect.try({
            try: () => {
              const child = spawn(process.execPath, ["-e", script], {
                cwd: options.cwd,
                env: options.env === undefined ? process.env : { ...process.env, ...options.env }
              })
              const record: ManagedChild = {
                command,
                child,
                exit: undefined,
                error: undefined,
                stdoutChunks: 0
              }
              state.active.add(record)
              state.started.push(record)
              liveChildren.add(child)
              child.once("exit", (code, signal) => {
                record.exit = { code, signal }
                state.active.delete(record)
                liveChildren.delete(child)
                if (signal !== null) state.unavailable = true
              })
              child.once("error", (cause) => {
                record.error = cause
                state.unavailable = true
                state.active.delete(record)
                liveChildren.delete(child)
              })
              return record
            },
            catch: (cause) =>
              new ProviderError({
                code: "spawn_error",
                message: `failed to launch real provider command \`${command}\``,
                cause
              })
          }),
          (record) =>
            Effect.sync(() => {
              state.active.delete(record)
              terminateChild(record.child)
            })
        ).pipe(Effect.map(processOf))
      })
  }

  return {
    provider,
    pingProvider: {
      ping: Effect.suspend(() => state.unavailable ? Effect.fail(unavailable()) : Effect.void)
    },
    state
  }
}

describe("RemoteChildProcessSpawner real-process provider", () => {
  it.effect("preserves all bytes and order from chunked megabyte-scale stdout", () =>
    Effect.gen(function*() {
      const expectedBytes = 1024 * 1024
      const provider = makeRealProvider({
        chunked: [
          "const chunk = Buffer.alloc(64 * 1024, 120)",
          "let remaining = 16",
          "const write = () => {",
          "  if (remaining === 0) return",
          "  remaining -= 1",
          "  if (process.stdout.write(chunk)) setImmediate(write)",
          "  else process.stdout.once('drain', write)",
          "}",
          "write()"
        ].join("\n")
      })

      const result = yield* (
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const handle = yield* spawner.spawn(ChildProcess.make("chunked"))
          const chunks = yield* Stream.runCollect(handle.stdout)
          const code = yield* handle.exitCode
          return { chunks, code }
        }).pipe(Effect.scoped, Effect.provide(RemoteChildProcessSpawner.layer(provider.provider)))
      )
      const output = Buffer.concat(Array.from(result.chunks, (chunk) => Buffer.from(chunk)))

      expect(result.code).toBe(0)
      expect(output).toEqual(Buffer.alloc(expectedBytes, 120))
      expect(provider.state.started[0]?.stdoutChunks).toBeGreaterThan(1)
    }), testBudget)

  it.effect("propagates a real process's nonzero exit code", () =>
    Effect.gen(function*() {
      const provider = makeRealProvider({ nonzero: "process.exit(37)" })

      const code = yield* (
        Effect.flatMap(ChildProcessSpawner, (spawner) => spawner.exitCode(ChildProcess.make("nonzero"))).pipe(
          Effect.provide(RemoteChildProcessSpawner.layer(provider.provider))
        )
      )

      expect(code).toBe(37)
    }), testBudget)

  it.effect("maps a child killed mid-stream to exitCode PlatformError without hanging", () =>
    Effect.gen(function*() {
      const provider = makeRealProvider({
        streaming: [
          "const chunk = Buffer.alloc(8 * 1024, 107)",
          "const write = () => {",
          "  if (process.stdout.write(chunk)) setImmediate(write)",
          "  else process.stdout.once('drain', write)",
          "}",
          "write()"
        ].join("\n")
      })

      const error = yield* (
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const handle = yield* spawner.spawn(ChildProcess.make("streaming"))
          const consumer = yield* Stream.runDrain(handle.stdout).pipe(Effect.forkChild({ startImmediately: true }))
          const record = provider.state.started[0]
          if (record === undefined) return yield* Effect.die(new Error("real provider did not record its child"))
          yield* Effect.promise(() => waitFor(() => record.stdoutChunks > 0, "the first stdout chunk"))
          yield* Effect.sync(() => {
            record.child.kill("SIGKILL")
          })
          const error = yield* Effect.flip(handle.exitCode)
          yield* Fiber.await(consumer)
          return error
        }).pipe(Effect.scoped, Effect.provide(RemoteChildProcessSpawner.layer(provider.provider)))
      )

      expect(error).toBeInstanceOf(PlatformError.PlatformError)
      expect(error.reason).toMatchObject({ _tag: "Unknown", module: "ChildProcess", method: "exitCode" })
    }), testBudget)

  it.effect("interrupts a scope and leaves no real OS process behind", () =>
    Effect.gen(function*() {
      const provider = makeRealProvider({ holding: "process.stdin.resume()" })

      const pid = yield* (
        Effect.gen(function*() {
          const fiber = yield* Effect.gen(function*() {
            const spawner = yield* ChildProcessSpawner
            yield* spawner.spawn(ChildProcess.make("holding"))
            return yield* Effect.never
          }).pipe(
            Effect.scoped,
            Effect.provide(RemoteChildProcessSpawner.layer(provider.provider)),
            Effect.forkChild({ startImmediately: true })
          )
          yield* Effect.promise(() => waitFor(() => provider.state.started.length === 1, "the holding child to start"))
          const record = provider.state.started[0]
          if (record === undefined) return yield* Effect.die(new Error("real provider did not record its child"))
          const pid = childPid(record.child)
          yield* Effect.promise(() => waitFor(() => processIsAlive(pid), `process ${pid} to be alive`))
          yield* Fiber.interrupt(fiber)
          return pid
        })
      )

      yield* Effect.promise(() => waitFor(() => !processIsAlive(pid), `interrupted process ${pid} to reach ESRCH`))
      expect(processIsAlive(pid)).toBe(false)
    }), testBudget)

  it.effect("bridges provider death to SandboxHealth and rejects a subsequent spawn", () =>
    Effect.gen(function*() {
      const provider = makeRealProvider({
        holding: "process.stdin.resume()",
        afterDeath: "process.stdout.write('unexpected spawn')"
      })

      const result = yield* (
        Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          yield* spawner.spawn(ChildProcess.make("holding"))
          const record = provider.state.started[0]
          if (record === undefined) return yield* Effect.die(new Error("real provider did not record its child"))
          yield* Effect.promise(() =>
            waitFor(() => processIsAlive(childPid(record.child)), "the provider child to be alive")
          )
          yield* Effect.sync(() => {
            record.child.kill("SIGKILL")
          })
          yield* Effect.promise(() => waitFor(() => provider.state.unavailable, "provider death to become observable"))
          const health = SandboxHealth.make(provider.pingProvider)
          const state = yield* health.check
          const spawnError = yield* Effect.flip(spawner.spawn(ChildProcess.make("afterDeath")))
          return { state, spawnError }
        }).pipe(Effect.scoped, Effect.provide(RemoteChildProcessSpawner.layer(provider.provider)))
      )

      expect(result.state._tag).toBe("Unhealthy")
      if (result.state._tag === "Unhealthy") {
        expect(result.state).toMatchObject({
          component: "sandbox",
          reason: "ping_failed",
          message: "real provider session is unavailable"
        })
      }
      expect(result.spawnError).toBeInstanceOf(PlatformError.PlatformError)
      expect(result.spawnError.reason).toMatchObject({ _tag: "NotFound", module: "ChildProcess", method: "spawn" })
    }), testBudget)

  /**
   * The suite plugin adapters must pass, run against the one provider this
   * repository can run for real. A suite that only ever sees the scripted
   * double would be a statement about the double.
   */
  it.live("passes the provider conformance suite against real OS processes", () =>
    Effect.gen(function*() {
      const provider = makeRealProvider({
        writes: "process.stdout.write('hello')",
        fails: "process.exit(3)",
        runs: "setInterval(() => {}, 1000)"
      })

      const violations = yield* ProviderConformance.check(provider.provider, {
        writes: "writes",
        output: "hello",
        fails: "fails",
        failureCode: 3,
        runs: "runs"
      })

      expect(ProviderConformance.format(violations)).toBe("provider conforms")
      expect(provider.state.started.map((record) => record.command)).toEqual(["writes", "fails", "runs"])
    }), testBudget)
})
