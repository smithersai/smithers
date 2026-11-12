/**
 * Supervising the sandbox a spawner runs commands in.
 *
 * A remote session dies while commands are running in it, and nothing on this
 * side notices: the provider's streams simply stop producing and the action
 * waits forever. Supervision is the heartbeat that turns that silence into a
 * failure a retry policy can act on, and the bookkeeping that gives the retry a
 * fresh session to land on.
 */
import { describe, expect, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Logger, Option, PlatformError, Ref, Schedule, Stream } from "effect"
import { ChildProcess } from "effect/process"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { TestClock } from "effect/testing"
import { elapsed } from "../src/internal/deadline.ts"
import * as RemoteChildProcessSpawner from "../src/RemoteChildProcessSpawner/index.ts"
import { ProviderError } from "../src/RemoteChildProcessSpawner/ProviderError.ts"
import * as SandboxHealth from "../src/SandboxHealth/index.ts"
import * as SandboxSupervision from "../src/SandboxSupervision/index.ts"

const interval = "1 second"

const gone = (): ProviderError => new ProviderError({ code: "unavailable", message: "session is gone" })

const recorder = () =>
  Effect.map(Ref.make<Array<SandboxSupervision.SandboxUnhealthy>>([]), (events) => ({
    events,
    reporter: {
      unhealthy: (event: SandboxSupervision.SandboxUnhealthy) => Ref.update(events, (all) => [...all, event])
    } satisfies SandboxSupervision.Reporter
  }))

const reason = (error: unknown): string =>
  error instanceof PlatformError.PlatformError ? error.reason._tag : `not a PlatformError: ${String(error)}`

describe("SandboxSupervision", () => {
  it.effect("runs a command through the session it opened", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        ping: Effect.void,
        scripts: { greet: { stdout: "hello" } }
      })

      const output = yield* Effect.flatMap(
        ChildProcessSpawner,
        (spawner) => spawner.string(ChildProcess.make("greet"))
      ).pipe(
        Effect.provide(SandboxSupervision.layer(provider, { interval }))
      )

      expect(output).toBe("hello")
      expect(provider.state.openedSessions).toEqual(["test-session"])
    }))

  it.effect("retires the session and reports it when the probe turns unhealthy", () =>
    Effect.gen(function*() {
      const record = yield* recorder()
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        ping: Effect.fail(gone()),
        scripts: { greet: { stdout: "hello" } }
      })

      yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        yield* spawner.string(ChildProcess.make("greet"))
        yield* TestClock.adjust(interval)
      }).pipe(
        Effect.provide(SandboxSupervision.layer(provider, { interval, reporter: record.reporter }))
      )

      const events = yield* Ref.get(record.events)
      expect(events.map((event) => event.reason)).toEqual(["ping_failed"])
      expect(events[0]?.session).toBe("test-session")
      expect(provider.state.cancellations).toBe(1)
    }))

  it.effect("fails an in-flight command when its session is retired", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        ping: Effect.fail(gone()),
        scripts: { serve: { pending: true } }
      })

      const error = yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const running = yield* Effect.forkChild(spawner.exitCode(ChildProcess.make("serve")), {
          startImmediately: true
        })
        yield* TestClock.adjust(interval)
        return yield* Effect.flip(Fiber.join(running))
      }).pipe(Effect.provide(SandboxSupervision.layer(provider, { interval })))

      expect(reason(error)).toBe("NotFound")
      expect(error.message).toContain("test-session")
    }))

  it.effect("fails a spawn that is still starting when its session is retired", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const provider = RemoteChildProcessSpawner.Provider.of({
        session: "blocked-spawn-session",
        open: () => Effect.acquireRelease(Effect.void, () => Effect.void),
        spawn: () => Effect.andThen(Deferred.succeed(entered, undefined), Effect.never),
        ping: Effect.fail(gone())
      })

      const bounded = yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const running = yield* Effect.forkChild(
          Effect.flip(spawner.exitCode(ChildProcess.make("still-starting"))).pipe(
            Effect.timeoutOption("2 seconds")
          ),
          { startImmediately: true }
        )
        yield* Deferred.await(entered)
        yield* TestClock.adjust("3 seconds")
        return yield* Fiber.join(running)
      }).pipe(Effect.provide(SandboxSupervision.layer(provider, { interval })))

      expect(Option.isSome(bounded)).toBe(true)
      if (Option.isNone(bounded)) return
      expect(reason(bounded.value)).toBe("NotFound")
      expect(bounded.value.message).toContain("blocked-spawn-session")
    }))

  it.effect("opens a fresh session for the command that follows a retirement", () =>
    Effect.gen(function*() {
      const healthy = yield* Ref.make(false)
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        ping: Effect.flatMap(Ref.get(healthy), (ok) => ok ? Effect.void : Effect.fail(gone())),
        scripts: { greet: { stdout: "hello" } }
      })

      const output = yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        yield* spawner.string(ChildProcess.make("greet"))
        yield* TestClock.adjust(interval)
        // The retirement closed the first session before anything reopened one.
        expect(provider.state.cancellations).toBe(1)
        yield* Ref.set(healthy, true)
        return yield* spawner.string(ChildProcess.make("greet"))
      }).pipe(Effect.provide(SandboxSupervision.layer(provider, { interval })))

      expect(output).toBe("hello")
      expect(provider.state.openedSessions).toEqual(["test-session", "test-session"])
      // Two sessions were opened and both were closed: the retired one when it
      // was retired, the live one when supervision itself went away.
      expect(provider.state.cancellations).toBe(2)
    }))

  it.effect("lets a retry policy land the failed action on a fresh session", () =>
    Effect.gen(function*() {
      const failures = yield* Ref.make(0)
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        // Two consecutive failed pings retire the session; the third answers.
        ping: Effect.flatMap(
          Ref.getAndUpdate(failures, (n) => n + 1),
          (seen) => seen < 2 ? Effect.fail(gone()) : Effect.void
        ),
        scripts: { serve: { pending: true }, greet: { stdout: "hello" } }
      })

      const output = yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const attempts = yield* Ref.make(0)
        const action = Effect.gen(function*() {
          const attempt = yield* Ref.getAndUpdate(attempts, (n) => n + 1)
          return attempt === 0
            ? yield* spawner.string(ChildProcess.make("serve"))
            : yield* spawner.string(ChildProcess.make("greet"))
        })
        const running = yield* Effect.forkChild(Effect.retry(action, Schedule.recurs(1)), { startImmediately: true })
        yield* TestClock.adjust("2 seconds")
        return yield* Fiber.join(running)
      }).pipe(
        Effect.provide(SandboxSupervision.layer(provider, { interval, tolerance: 2 }))
      )

      expect(output).toBe("hello")
      expect(provider.state.openedSessions.length).toBe(2)
    }))

  it.effect("keeps a session that recovers before the tolerance is spent", () =>
    Effect.gen(function*() {
      const probes = yield* Ref.make(0)
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        ping: Effect.flatMap(
          Ref.getAndUpdate(probes, (n) => n + 1),
          (seen) => seen === 0 ? Effect.fail(gone()) : Effect.void
        ),
        scripts: { greet: { stdout: "hello" } }
      })

      const record = yield* recorder()

      yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        yield* spawner.string(ChildProcess.make("greet"))
        yield* TestClock.adjust("3 seconds")
        yield* spawner.string(ChildProcess.make("greet"))
      }).pipe(
        Effect.provide(SandboxSupervision.layer(provider, { interval, tolerance: 2, reporter: record.reporter }))
      )

      expect(provider.state.openedSessions).toEqual(["test-session"])
      expect(yield* Ref.get(record.events)).toEqual([])
    }))

  it.effect("holds a failing session that never spends its tolerance before the layer goes away", () =>
    Effect.gen(function*() {
      // Every probe says unhealthy, but the layer's scope closes long before
      // the tolerance is spent. Retirement is a verdict about a run of probes,
      // not about any one, so nothing is retired and nothing is reported; the
      // session ends because the layer did.
      const probes = yield* Ref.make(0)
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        ping: Effect.andThen(Ref.update(probes, (n) => n + 1), Effect.fail(gone())),
        scripts: { greet: { stdout: "hello" } }
      })
      const record = yield* recorder()

      const probed = yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        yield* spawner.string(ChildProcess.make("greet"))
        yield* TestClock.adjust("3 seconds")
        // Still the first session: no retirement happened under it.
        expect(provider.state.cancellations).toBe(0)
        yield* spawner.string(ChildProcess.make("greet"))
        return yield* Ref.get(probes)
      }).pipe(
        Effect.provide(SandboxSupervision.layer(provider, { interval, tolerance: 20, reporter: record.reporter }))
      )

      // Every probe failed, and every one of them was under the tolerance.
      expect(probed).toBeGreaterThan(0)
      expect(probed).toBeLessThan(20)
      expect(provider.state.openedSessions).toEqual(["test-session"])
      expect(provider.state.commands).toEqual(["greet", "greet"])
      expect(yield* Ref.get(record.events)).toEqual([])
      // The layer's own teardown closed it, exactly once.
      expect(provider.state.cancellations).toBe(1)
    }))

  it.effect("retires a session whose ping outlives the probe deadline", () =>
    Effect.gen(function*() {
      const record = yield* recorder()
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        ping: Effect.never,
        scripts: { greet: { stdout: "hello" } }
      })

      yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        yield* spawner.string(ChildProcess.make("greet"))
        yield* TestClock.adjust("4 seconds")
      }).pipe(
        Effect.provide(
          SandboxSupervision.layer(provider, { interval, deadline: "2 seconds", reporter: record.reporter })
        )
      )

      const events = yield* Ref.get(record.events)
      expect(events.map((event) => event.reason)).toEqual(["unresponsive"])
      expect(events[0]?.message).toContain("deadline")
    }))

  it.effect("reports a verdict that carries no message", () =>
    Effect.gen(function*() {
      const record = yield* recorder()
      const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts: { greet: { stdout: "hello" } } })

      yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        yield* spawner.string(ChildProcess.make("greet"))
        yield* TestClock.adjust(interval)
      }).pipe(
        Effect.provide(
          SandboxSupervision.layer(provider, {
            interval,
            reporter: record.reporter,
            probe: Effect.succeed(new SandboxHealth.Unhealthy({ component: "sandbox", reason: "unresponsive" }))
          })
        )
      )

      const events = yield* Ref.get(record.events)
      expect(events.map((event) => event.reason)).toEqual(["unresponsive"])
      expect(events[0]?.message).toBeUndefined()
    }))

  it.effect("never probes a provider that cannot be pinged", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({ scripts: { greet: { stdout: "hello" } } })
      const record = yield* recorder()

      yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        yield* spawner.string(ChildProcess.make("greet"))
        yield* TestClock.adjust("10 seconds")
      }).pipe(Effect.provide(SandboxSupervision.layer(provider, { interval, reporter: record.reporter })))

      expect(provider.state.openedSessions).toEqual(["test-session"])
      expect(yield* Ref.get(record.events)).toEqual([])
    }))

  it.effect.each([
    { named: "without a ping", ping: undefined },
    { named: "with a ping", ping: Effect.void }
  ])("opens a fresh session for the command after an open that failed, $named", ({ ping }) =>
    Effect.gen(function*() {
      // `RemoteChildProcessSpawner.make` answers a failed open with a spawner
      // whose every command fails, which is right for a caller holding one
      // session and wrong for a supervisor: cached as a generation it replayed
      // the one open failure for the life of the layer, and a provider with no
      // `ping` had nothing that could ever clear it.
      const base = RemoteChildProcessSpawner.TestRemote.make({
        ...ping === undefined ? {} : { ping },
        scripts: { greet: { stdout: "hello" } }
      })
      let opens = 0
      const provider: RemoteChildProcessSpawner.Provider = {
        ...base,
        open: (session) =>
          Effect.suspend(() => {
            opens += 1
            return opens === 1 ? Effect.fail(gone()) : base.open(session)
          })
      }

      const outcome = yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const refused = yield* Effect.flip(spawner.string(ChildProcess.make("greet")))
        const served = yield* spawner.string(ChildProcess.make("greet"))
        return { refused, served }
      }).pipe(Effect.provide(SandboxSupervision.layer(provider, { interval })))

      expect(reason(outcome.refused)).toBe("NotFound")
      expect(outcome.refused.message).toContain("session is gone")
      expect(outcome.served).toBe("hello")
      // The second command opened a second time rather than replaying the
      // first failure, and the failed attempt left nothing behind.
      expect(opens).toBe(2)
      expect(base.state.openedSessions).toEqual(["test-session"])
      expect(base.state.commands).toEqual(["greet"])
    }))

  it.effect("retires the session even when the reporter defects", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        ping: Effect.fail(gone()),
        scripts: { serve: { pending: true }, greet: { stdout: "hello" } }
      })
      // Reporting is observational and caller-supplied. Sequencing it ahead of
      // the two operations that are not put every waiter and the remote
      // machine behind a stranger's HTTP call.
      const reporter: SandboxSupervision.Reporter = {
        unhealthy: () => Effect.die(new Error("the reporter exploded"))
      }

      const outcome = yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const running = yield* Effect.forkChild(spawner.exitCode(ChildProcess.make("serve")), {
          startImmediately: true
        })
        yield* TestClock.adjust(interval)
        const failed = yield* Effect.flip(Fiber.join(running))
        // The retired session's scope was closed, and the next command opens a
        // fresh one instead of waiting on a permit the reporter never gave up.
        expect(provider.state.cancellations).toBe(1)
        return { failed, served: yield* spawner.string(ChildProcess.make("greet")) }
      }).pipe(Effect.provide(SandboxSupervision.layer(provider, { interval, reporter })))

      expect(reason(outcome.failed)).toBe("NotFound")
      expect(outcome.served).toBe("hello")
      expect(provider.state.openedSessions).toEqual(["test-session", "test-session"])
    }))

  it.effect("fails the commands a retirement covers before the reporter has answered", () =>
    Effect.gen(function*() {
      const reporting = yield* Deferred.make<void>()
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        ping: Effect.fail(gone()),
        scripts: { serve: { pending: true } }
      })
      // A reporter that never returns. Everything the retirement MUST do is
      // sequenced ahead of it, so this asserts the ordering rather than a
      // timeout: the waiter fails and the machine is released while the
      // reporter is still hanging.
      const reporter: SandboxSupervision.Reporter = {
        unhealthy: () => Effect.andThen(Deferred.succeed(reporting, undefined), Effect.never)
      }

      const failed = yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const running = yield* Effect.forkChild(spawner.exitCode(ChildProcess.make("serve")), {
          startImmediately: true
        })
        yield* TestClock.adjust(interval)
        yield* Deferred.await(reporting)
        return yield* Effect.flip(Fiber.join(running))
      }).pipe(Effect.provide(SandboxSupervision.layer(provider, { interval, reporter })))

      expect(reason(failed)).toBe("NotFound")
      expect(provider.state.cancellations).toBe(1)
    }))

  it.effect("opens and probes a fresh session while the previous reporter never returns", () =>
    Effect.gen(function*() {
      const reporting = yield* Deferred.make<void>()
      const probes = yield* Ref.make(0)
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        ping: Effect.andThen(Ref.update(probes, (n) => n + 1), Effect.fail(gone())),
        scripts: { greet: { stdout: "hello" } }
      })
      yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        yield* spawner.string(ChildProcess.make("greet"))
        yield* TestClock.adjust(interval)
        yield* Deferred.await(reporting)
        const output = yield* Effect.raceFirst(
          spawner.string(ChildProcess.make("greet")),
          Effect.as(elapsed("1 second"), "blocked")
        )
        expect(output).toBe("hello")
        expect(provider.state.openedSessions).toHaveLength(2)
        yield* TestClock.adjust(interval)
        expect(yield* Ref.get(probes)).toBe(2)
        expect(provider.state.cancellations).toBe(2)
      }).pipe(Effect.provide(SandboxSupervision.layer(provider, {
        interval,
        reporter: { unhealthy: () => Effect.andThen(Deferred.succeed(reporting, undefined), Effect.never) }
      })))
    }))

  it.effect.each(["string", "stdout", "stderr", "all"] as const)(
    "retires pending %s after the process exit has completed",
    (output) =>
      Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const base = RemoteChildProcessSpawner.TestRemote.make({ ping: Effect.fail(gone()) })
        const pending = Stream.fromEffect(Effect.andThen(Deferred.succeed(entered, undefined), Effect.never))
        const provider: RemoteChildProcessSpawner.Provider = {
          ...base,
          spawn: () => Effect.succeed({ stdout: pending, stderr: pending, exitCode: Effect.succeed(0) })
        }
        yield* Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const command = ChildProcess.make("exited-with-open-pipes")
          const consume = Effect.gen(function*() {
            if (output === "string") return yield* spawner.string(command)
            const handle = yield* spawner.spawn(command)
            expect(yield* handle.exitCode).toBe(0)
            expect(yield* handle.isRunning).toBe(false)
            return yield* Stream.runCollect(Stream.onStart(handle[output], Deferred.succeed(entered, undefined)))
          })
          const running = yield* Effect.forkChild(Effect.result(consume), { startImmediately: true })
          yield* Deferred.await(entered)
          yield* TestClock.adjust(interval)
          const result = yield* Effect.raceFirst(Fiber.join(running), Effect.as(elapsed("1 second"), undefined))
          expect(base.state.cancellations).toBe(1)
          expect(result?._tag).toBe("Failure")
          if (result?._tag === "Failure") expect(reason(result.failure)).toBe("NotFound")
        }).pipe(Effect.provide(SandboxSupervision.layer(provider, { interval })))
      })
  )

  it.effect("leaves completed output alone while retiring another consumer of the same handle", () =>
    Effect.gen(function*() {
      const base = RemoteChildProcessSpawner.TestRemote.make({ ping: Effect.fail(gone()) })
      const provider: RemoteChildProcessSpawner.Provider = {
        ...base,
        spawn: () =>
          Effect.succeed({
            stdout: Stream.make(new TextEncoder().encode("done")),
            stderr: Stream.never,
            exitCode: Effect.never
          })
      }
      yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const handle = yield* spawner.spawn(ChildProcess.make("partial-output"))
        expect(yield* Stream.mkString(Stream.decodeText(handle.stdout))).toBe("done")
        const waiting = yield* Effect.forkChild(Effect.flip(Stream.runDrain(handle.stderr)), {
          startImmediately: true
        })
        yield* TestClock.adjust(interval)
        expect(reason(yield* Fiber.join(waiting))).toBe("NotFound")
      }).pipe(Effect.provide(SandboxSupervision.layer(provider, { interval })))
    }))

  it.effect("reports release defects and keeps probing later sessions", () =>
    Effect.gen(function*() {
      const record = yield* recorder()
      const probes = yield* Ref.make(0)
      const base = RemoteChildProcessSpawner.TestRemote.make({
        ping: Effect.andThen(Ref.update(probes, (n) => n + 1), Effect.fail(gone())),
        scripts: { greet: { stdout: "hello" } }
      })
      const provider: RemoteChildProcessSpawner.Provider = {
        ...base,
        open: (session) =>
          Effect.andThen(
            base.open(session),
            Effect.addFinalizer(() => Effect.die("release exploded"))
          )
      }
      const logs: Array<{ level: string; message: unknown; cause: unknown }> = []
      const logger = Logger.make((entry) => {
        logs.push({ level: entry.logLevel, message: entry.message, cause: entry.cause })
      })
      yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        yield* spawner.string(ChildProcess.make("greet"))
        yield* TestClock.adjust(interval)
        expect(yield* Ref.get(record.events)).toHaveLength(1)
        yield* spawner.string(ChildProcess.make("greet"))
        yield* TestClock.adjust(interval)
        expect(yield* Ref.get(probes)).toBe(2)
        expect(yield* Ref.get(record.events)).toHaveLength(2)
        expect(base.state.cancellations).toBe(2)
        expect(logs.filter((entry) => entry.level === "Warn")).toHaveLength(2)
        expect(JSON.stringify(logs)).toContain("test-session")
        expect(JSON.stringify(logs)).toContain("release exploded")
      }).pipe(
        Effect.provide(SandboxSupervision.layer(provider, { interval, reporter: record.reporter })),
        Effect.provide(Logger.layer([logger]))
      )
    }))

  it.effect("interrupts a hung reporter at reportWithin while supervision remains open", () =>
    Effect.gen(function*() {
      const reporting = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        ping: Effect.fail(gone()),
        scripts: { greet: { stdout: "hello" } }
      })
      yield* Effect.scoped(Effect.gen(function*() {
        const spawner = yield* SandboxSupervision.make(provider, {
          interval,
          reporter: {
            unhealthy: () =>
              Effect.andThen(Deferred.succeed(reporting, undefined), Effect.never).pipe(
                Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))
              )
          }
        }, "20 millis")
        yield* spawner.string(ChildProcess.make("greet"))
        yield* TestClock.adjust(interval)
        yield* Deferred.await(reporting)
        const bounded = yield* Effect.raceFirst(
          Effect.as(Deferred.await(interrupted), true),
          Effect.as(elapsed("1 second"), false)
        )
        expect(bounded).toBe(true)
        expect(yield* spawner.string(ChildProcess.make("greet"))).toBe("hello")
        expect(provider.state.openedSessions).toHaveLength(2)
      }))
    }))

  it.effect("reports through the logger when no reporter is injected", () =>
    Effect.gen(function*() {
      const provider = RemoteChildProcessSpawner.TestRemote.make({
        ping: Effect.fail(gone()),
        scripts: { greet: { stdout: "hello" } }
      })

      const logs: Array<{ level: string; message: unknown }> = []
      const logger = Logger.make((entry) => {
        logs.push({ level: entry.logLevel, message: entry.message })
      })
      yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        yield* spawner.string(ChildProcess.make("greet"))
        yield* TestClock.adjust(interval)
      }).pipe(
        Effect.provide(SandboxSupervision.layer(provider, { interval })),
        Effect.provide(Logger.layer([logger]))
      )

      expect(logs).toEqual([{
        level: "Warn",
        message: [
          "sandbox-unhealthy",
          expect.objectContaining({
            session: "test-session",
            reason: "ping_failed"
          })
        ]
      }])
      expect(provider.state.cancellations).toBe(1)
    }))
})
