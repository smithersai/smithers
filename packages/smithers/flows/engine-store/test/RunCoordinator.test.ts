import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Logger } from "effect"
import * as RunCoordinator from "../src/internal/RunCoordinator.vibe"

const effect = <E>(name: string, body: () => Effect.Effect<void, E>) => it.effect(name, () => body())

describe("RunCoordinator", () => {
  effect(
    "reserves idle ownership before checking readiness and skips work that already parked",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const checking = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let pending = true
        let drains = 0
        const coordinator = yield* RunCoordinator.make({
          drain: () =>
            Effect.sync(() => {
              drains++
            })
        })
        yield* coordinator.scheduleIf(
          "run",
          Deferred.succeed(checking, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.map(() => pending)
          )
        )
        yield* Deferred.await(checking)
        yield* coordinator.schedule("run")
        pending = false
        yield* Deferred.succeed(release, undefined)
        yield* coordinator.join("run")
        expect(drains).toBe(0)
        expect((yield* coordinator.active).size).toBe(0)
        yield* coordinator.scheduleIf("run", Effect.succeed(true))
        yield* coordinator.join("run")
        expect(drains).toBe(1)
      }))
  )

  effect(
    "a follower never checks stale pending state while an active child is finishing",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        const parked = yield* Deferred.make<void>()
        let drives = 0
        let reads = 0
        const coordinator = yield* RunCoordinator.make({
          drain: () =>
            Effect.sync(() => {
              drives++
            }).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(parked))
            )
        })
        yield* coordinator.schedule("child")
        yield* Deferred.await(started)
        // A read-before-schedule implementation would retain pending=true,
        // let the original drive park, then start another drain on the idle row.
        const staleRead = Effect.sync(() => {
          reads++
          return true
        }).pipe(
          Effect.tap(() => Deferred.succeed(parked, undefined)),
          Effect.tap(() => coordinator.join("child"))
        )
        yield* coordinator.scheduleIf("child", staleRead)
        yield* Deferred.succeed(parked, undefined)
        yield* coordinator.join("child")
        expect(reads).toBe(0)
        expect(drives).toBe(1)
      }))
  )

  effect("schedules idle admission without replaying an active drain", () =>
    Effect.scoped(Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      let runs = 0
      const coordinator = yield* RunCoordinator.make({
        drain: () =>
          Effect.sync(() => runs++).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Deferred.await(gate))
          )
      })
      yield* coordinator.schedule("run")
      yield* Deferred.await(started)
      yield* coordinator.schedule("run")
      yield* coordinator.schedule("run")
      expect(runs).toBe(1)
      yield* Deferred.succeed(gate, undefined)
      yield* coordinator.join("run")
      expect(runs).toBe(1)
      expect((yield* coordinator.active).size).toBe(0)
      yield* coordinator.schedule("run")
      yield* coordinator.join("run")
      expect(runs).toBe(2)
    })))

  effect(
    "an event wake still replays work after admission joins an active drain",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* RunCoordinator.make({
          drain: () =>
            Effect.sync(() => runs++).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(gate))
            )
        })
        yield* coordinator.schedule("run")
        yield* Deferred.await(started)
        yield* coordinator.wake("run")
        yield* coordinator.schedule("run")
        yield* Deferred.succeed(gate, undefined)
        yield* coordinator.join("run")
        expect(runs).toBe(2)
      }))
  )

  effect(
    "admission during interruption does not resurrect the stopping owner",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        const cleanupStarted = yield* Deferred.make<void>()
        const cleanupGate = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* RunCoordinator.make({
          drain: () =>
            Effect.sync(() => runs++).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Deferred.succeed(cleanupStarted, undefined).pipe(Effect.andThen(Deferred.await(cleanupGate)))
              )
            )
        })
        yield* coordinator.schedule("run")
        yield* Deferred.await(started)
        const stopping = yield* coordinator.interrupt("run").pipe(Effect.forkChild)
        yield* Deferred.await(cleanupStarted)
        yield* coordinator.schedule("run")
        yield* Deferred.succeed(cleanupGate, undefined)
        yield* Fiber.join(stopping)
        expect(runs).toBe(1)
        expect((yield* coordinator.active).size).toBe(0)
      }))
  )

  effect("joins a second run for the same key", () =>
    Effect.scoped(Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      let runs = 0
      const coordinator = yield* RunCoordinator.make({
        drain: () => Effect.sync(() => runs++).pipe(Effect.andThen(Deferred.await(gate)))
      })

      const first = yield* coordinator.run("run").pipe(Effect.forkChild)
      yield* Effect.yieldNow
      const second = yield* coordinator.run("run").pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(runs).toBe(1)
      yield* Deferred.succeed(gate, undefined)
      yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(runs).toBe(1)
    })))

  effect("join waits for the active drain and starts none while idle", () =>
    Effect.scoped(Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      let runs = 0
      const coordinator = yield* RunCoordinator.make({
        drain: () => Effect.sync(() => runs++).pipe(Effect.andThen(Deferred.await(gate)))
      })

      yield* coordinator.join("run")
      expect(runs).toBe(0)
      const first = yield* coordinator.run("run").pipe(Effect.forkChild)
      yield* Effect.yieldNow
      const joined = yield* coordinator.join("run").pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(joined.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(gate, undefined)
      yield* Effect.all([Fiber.join(first), Fiber.join(joined)])
      expect(runs).toBe(1)
    })))

  effect("runs different keys concurrently", () =>
    Effect.scoped(Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      const bothStarted = yield* Deferred.make<void>()
      let active = 0
      const coordinator = yield* RunCoordinator.make({
        drain: () =>
          Effect.sync(() => ++active).pipe(
            Effect.tap(() => active === 2 ? Deferred.succeed(bothStarted, undefined) : Effect.void),
            Effect.andThen(Deferred.await(gate))
          )
      })

      const first = yield* coordinator.run("first").pipe(Effect.forkChild)
      const second = yield* coordinator.run("second").pipe(Effect.forkChild)
      yield* Deferred.await(bothStarted)
      yield* Deferred.succeed(gate, undefined)
      yield* Effect.all([Fiber.join(first), Fiber.join(second)])
    })))

  effect("runs exactly one follow-up for wakes during an active drain", () =>
    Effect.scoped(Effect.gen(function*() {
      const firstStarted = yield* Deferred.make<void>()
      const firstGate = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      let runs = 0
      const coordinator = yield* RunCoordinator.make({
        drain: () =>
          Effect.sync(() => ++runs).pipe(Effect.flatMap((run) =>
            run === 1
              ? Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(firstGate)))
              : Deferred.succeed(secondStarted, undefined)
          ))
      })

      const running = yield* coordinator.run("run").pipe(Effect.forkChild)
      yield* Deferred.await(firstStarted)
      yield* Effect.all([coordinator.wake("run"), coordinator.wake("run"), coordinator.wake("run")], {
        concurrency: "unbounded"
      })
      yield* Deferred.succeed(firstGate, undefined)
      yield* Deferred.await(secondStarted)
      yield* Fiber.join(running)
      expect(runs).toBe(2)
    })))

  effect("schedules another wake received during the follow-up", () =>
    Effect.scoped(Effect.gen(function*() {
      const firstGate = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      const secondGate = yield* Deferred.make<void>()
      const thirdStarted = yield* Deferred.make<void>()
      let runs = 0
      const coordinator = yield* RunCoordinator.make({
        drain: () =>
          Effect.sync(() => ++runs).pipe(Effect.flatMap((run) =>
            run === 1 ?
              Deferred.await(firstGate)
              : run === 2 ?
              Deferred.succeed(secondStarted, undefined).pipe(Effect.andThen(Deferred.await(secondGate)))
              : Deferred.succeed(thirdStarted, undefined)
          ))
      })

      const running = yield* coordinator.run("run").pipe(Effect.forkChild)
      yield* coordinator.wake("run")
      yield* Deferred.succeed(firstGate, undefined)
      yield* Deferred.await(secondStarted)
      yield* coordinator.wake("run")
      yield* Deferred.succeed(secondGate, undefined)
      yield* Deferred.await(thirdStarted)
      yield* Fiber.join(running)
      expect(runs).toBe(3)
    })))

  effect("trampolines synchronous self-wakes", () =>
    Effect.scoped(Effect.gen(function*() {
      const completed = yield* Deferred.make<void>()
      const limit = 1_000
      let runs = 0
      let wake: (key: string) => Effect.Effect<void> = () => Effect.void
      const coordinator = yield* RunCoordinator.make<string, never, never>({
        drain: (key) =>
          Effect.sync(() => ++runs).pipe(
            Effect.tap((run) => run < limit ? wake(key) : Deferred.succeed(completed, undefined)),
            Effect.asVoid
          )
      })
      wake = coordinator.wake

      yield* coordinator.wake("run")
      yield* Deferred.await(completed)
      expect(runs).toBe(limit)
    })))

  effect("starts a drain when waking an idle key", () =>
    Effect.scoped(Effect.gen(function*() {
      const drained = yield* Deferred.make<void>()
      const coordinator = yield* RunCoordinator.make({ drain: () => Deferred.succeed(drained, undefined) })
      yield* coordinator.wake("run")
      yield* Deferred.await(drained)
    })))

  effect("logs a wake-initiated drain failure", () => {
    const logs: Array<{ readonly level: string; readonly message: unknown }> = []
    const capture = Logger.make((entry) => {
      logs.push({ level: entry.logLevel, message: entry.message })
    })
    return Effect.scoped(
      Effect.gen(function*() {
        const coordinator = yield* RunCoordinator.make<string, string, never>({
          drain: () => Effect.fail("boom")
        })
        yield* coordinator.wake("run")
        yield* Effect.yieldNow
        expect(
          logs.some((entry) =>
            entry.level === "Warn" && String(entry.message).includes("coordinated drain failed for run")
          )
        ).toBe(true)
      }).pipe(Effect.provide(Logger.layer([capture])))
    )
  })

  effect("passes only the key to direct and wake-initiated drains", () =>
    Effect.scoped(Effect.gen(function*() {
      const woke = yield* Deferred.make<void>()
      const arities: Array<number> = []
      const coordinator = yield* RunCoordinator.make<string, never, never>({
        drain: function() {
          const call = arities.length
          return Effect.sync(() => {
            arities.push(arguments.length)
          }).pipe(Effect.andThen(call === 0 ? Effect.void : Deferred.succeed(woke, undefined)))
        }
      })

      yield* coordinator.run("run")
      yield* coordinator.wake("run")
      yield* Deferred.await(woke)
      expect(arities).toEqual([1, 1])
    })))

  effect("cleans entries after a failure or defect", () =>
    Effect.scoped(Effect.gen(function*() {
      const failure = new Error("failure")
      const coordinator = yield* RunCoordinator.make<string, Error, never>({
        drain: (key) => key === "failure" ? Effect.fail(failure) : Effect.die("defect")
      })

      const failed = yield* coordinator.run("failure").pipe(Effect.exit)
      expect(Exit.isFailure(failed) && Cause.hasFails(failed.cause)).toBe(true)
      expect(Array.from(yield* coordinator.active)).toEqual([])
      const died = yield* coordinator.run("defect").pipe(Effect.exit)
      expect(Exit.isFailure(died) && Cause.hasDies(died.cause)).toBe(true)
      expect(Array.from(yield* coordinator.active)).toEqual([])
    })))

  effect("preserves a pending wake after an active drain fails", () =>
    Effect.scoped(Effect.gen(function*() {
      const firstStarted = yield* Deferred.make<void>()
      const firstGate = yield* Deferred.make<void>()
      const successorStarted = yield* Deferred.make<void>()
      const failure = new Error("failure")
      let runs = 0
      const coordinator = yield* RunCoordinator.make<string, Error, never>({
        drain: () =>
          Effect.sync(() => ++runs).pipe(
            Effect.flatMap((run) =>
              run === 1
                ? Deferred.succeed(firstStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(firstGate)),
                  Effect.andThen(Effect.fail(failure))
                )
                : Deferred.succeed(successorStarted, undefined)
            )
          )
      })

      const running = yield* coordinator.run("run").pipe(Effect.forkChild)
      yield* Deferred.await(firstStarted)
      yield* coordinator.wake("run")
      yield* Deferred.succeed(firstGate, undefined)
      yield* Deferred.await(successorStarted)
      const exit = yield* Fiber.await(running)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
      expect(runs).toBe(2)
    })))

  effect(
    "does not interrupt the owner when a joined waiter is interrupted",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* RunCoordinator.make({
          drain: () => Effect.sync(() => runs++).pipe(Effect.andThen(Deferred.await(gate)))
        })
        const owner = yield* coordinator.run("run").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        const waiter = yield* coordinator.run("run").pipe(Effect.forkChild)
        yield* Fiber.interrupt(waiter)
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(owner)
        expect(runs).toBe(1)
      }))
  )

  effect("interrupts an active drain and waits for cleanup", () =>
    Effect.scoped(Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const cleaned = yield* Deferred.make<void>()
      const coordinator = yield* RunCoordinator.make({
        drain: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(cleaned, undefined))
          )
      })
      const running = yield* coordinator.run("run").pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* coordinator.interrupt("run")
      yield* Deferred.await(cleaned)
      const exit = yield* Fiber.await(running)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(Array.from(yield* coordinator.active)).toEqual([])
    })))

  effect("waits for a stopping entry before starting a replacement", () =>
    Effect.scoped(Effect.gen(function*() {
      const firstStarted = yield* Deferred.make<void>()
      const cleanupStarted = yield* Deferred.make<void>()
      const cleanupGate = yield* Deferred.make<void>()
      const replacementStarted = yield* Deferred.make<void>()
      let runs = 0
      const coordinator = yield* RunCoordinator.make({
        drain: () =>
          Effect.sync(() => ++runs).pipe(
            Effect.flatMap((run) =>
              run === 1
                ? Deferred.succeed(firstStarted, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() =>
                    Deferred.succeed(cleanupStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(cleanupGate))
                    )
                  )
                )
                : Deferred.succeed(replacementStarted, undefined)
            )
          )
      })

      const first = yield* coordinator.run("run").pipe(Effect.forkChild)
      yield* Deferred.await(firstStarted)
      const interrupting = yield* coordinator.interrupt("run").pipe(Effect.forkChild)
      yield* Deferred.await(cleanupStarted)
      const replacement = yield* coordinator.run("run").pipe(Effect.forkChild)
      // Let the replacement join the stopping entry while cleanup is still held.
      yield* Effect.yieldNow
      expect(replacement.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(cleanupGate, undefined)
      yield* Fiber.join(interrupting)
      expect(Exit.isSuccess(yield* Fiber.await(replacement))).toBe(true)
      expect(yield* Deferred.isDone(replacementStarted)).toBe(true)
      const exit = yield* Fiber.await(first)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(runs).toBe(2)
    })))

  effect("cancelling a replacement waiter does not start another drain", () =>
    Effect.scoped(Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const cleaning = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let runs = 0
      const coordinator = yield* RunCoordinator.make({
        drain: () =>
          Effect.gen(function*() {
            runs++
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.never
          }).pipe(Effect.onInterrupt(() =>
            Deferred.succeed(cleaning, undefined).pipe(
              Effect.andThen(Deferred.await(release))
            )
          ))
      })
      yield* coordinator.schedule("run")
      yield* Deferred.await(started)
      yield* coordinator.requestInterrupt("run")
      yield* Deferred.await(cleaning)
      const replacement = yield* coordinator.run("run").pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(replacement)
      yield* Deferred.succeed(release, undefined)
      yield* coordinator.join("run").pipe(Effect.exit)
      expect(runs).toBe(1)
      expect(Array.from(yield* coordinator.active)).toEqual([])
    })))

  effect(
    "a hosted wake coalesces active work but starts neither idle nor stopping work",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const cleaning = yield* Deferred.make<void>()
        const cleaned = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* RunCoordinator.make({
          drain: () =>
            Effect.gen(function*() {
              runs++
              if (runs === 1) {
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(release)
              } else {
                yield* Deferred.succeed(secondStarted, undefined)
                return yield* Effect.never
              }
            }).pipe(Effect.onInterrupt(() =>
              Deferred.succeed(cleaning, undefined).pipe(
                Effect.andThen(Deferred.await(cleaned))
              )
            ))
        })
        yield* coordinator.wakeIfActive("run")
        expect(Array.from(yield* coordinator.active)).toEqual([])
        yield* coordinator.schedule("run")
        yield* Deferred.await(started)
        yield* coordinator.wakeIfActive("run")
        yield* Deferred.succeed(release, undefined)
        yield* Deferred.await(secondStarted)
        expect(runs).toBe(2)
        yield* coordinator.requestInterrupt("run")
        yield* Deferred.await(cleaning)
        yield* coordinator.wakeIfActive("run")
        yield* Deferred.succeed(cleaned, undefined)
        yield* coordinator.join("run").pipe(Effect.exit)
        expect(runs).toBe(2)
        expect(Array.from(yield* coordinator.active)).toEqual([])
      }))
  )

  effect("a replacement preserves a stopping owner's cleanup defect", () =>
    Effect.scoped(Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const cleaning = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let runs = 0
      const coordinator = yield* RunCoordinator.make({
        drain: () =>
          Effect.gen(function*() {
            runs++
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.never
          }).pipe(Effect.onInterrupt(() =>
            Deferred.succeed(cleaning, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.andThen(Effect.die("cleanup failed"))
            )
          ))
      })
      yield* coordinator.schedule("run")
      yield* Deferred.await(started)
      yield* coordinator.requestInterrupt("run")
      yield* Deferred.await(cleaning)
      const replacement = yield* coordinator.run("run").pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Deferred.succeed(release, undefined)
      const exit = yield* Fiber.await(replacement)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(runs).toBe(1)
    })))

  effect("ignores interruption for an idle key", () =>
    Effect.scoped(Effect.gen(function*() {
      const coordinator = yield* RunCoordinator.make({ drain: () => Effect.void })
      yield* coordinator.interrupt("missing")
      expect(Array.from(yield* coordinator.active)).toEqual([])
    })))

  effect("cleans active drains when its scope closes", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const coordinator = yield* Effect.scoped(Effect.gen(function*() {
        const coordinator = yield* RunCoordinator.make({
          drain: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
        })
        yield* coordinator.wake("run")
        yield* Deferred.await(started)
        expect(Array.from(yield* coordinator.active)).toEqual(["run"])
        return coordinator
      }))
      expect(Array.from(yield* coordinator.active)).toEqual([])
    }))

  effect("reports active keys", () =>
    Effect.scoped(Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const coordinator = yield* RunCoordinator.make({
        drain: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(gate)))
      })
      expect(Array.from(yield* coordinator.active)).toEqual([])
      const running = yield* coordinator.run("run").pipe(Effect.forkChild)
      yield* Deferred.await(started)
      expect(Array.from(yield* coordinator.active)).toEqual(["run"])
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(running)
      expect(Array.from(yield* coordinator.active)).toEqual([])
    })))
})

describe("RunCoordinator resume lane", () => {
  /** A coordinator whose drains wait on their own gate, recording which started. */
  const gated = (resumeConcurrency?: number) =>
    Effect.gen(function*() {
      const gates = new Map<string, Deferred.Deferred<void>>()
      const gate = (key: string) => {
        let found = gates.get(key)
        if (found === undefined) {
          found = Deferred.makeUnsafe<void>()
          gates.set(key, found)
        }
        return found
      }
      const started: Array<string> = []
      const coordinator = yield* RunCoordinator.make({
        drain: (key: string) => Effect.sync(() => started.push(key)).pipe(Effect.andThen(Deferred.await(gate(key)))),
        ...(resumeConcurrency === undefined ? {} : { resumeConcurrency })
      })
      const open = (key: string) => Deferred.succeed(gate(key), undefined)
      return { coordinator, started, open }
    })

  effect(
    "drains at most resumeConcurrency resumed runs at once, in the order they asked",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const { coordinator, open, started } = yield* gated(2)
        yield* coordinator.schedule("a", { resumed: true })
        yield* coordinator.wake("b", { resumed: true })
        yield* coordinator.schedule("c", { resumed: true })
        const d = yield* coordinator.run("d", { resumed: true }).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        expect(started).toEqual(["a", "b"])
        // Queued runs are active: a second ask joins them rather than adding another drain.
        expect([...(yield* coordinator.active)].sort()).toEqual(["a", "b", "c", "d"])
        yield* open("a")
        yield* coordinator.join("a")
        yield* Effect.yieldNow
        expect(started).toEqual(["a", "b", "c"])
        yield* open("b")
        yield* open("c")
        yield* open("d")
        yield* Fiber.join(d)
        expect(started).toEqual(["a", "b", "c", "d"])
        expect((yield* coordinator.active).size).toBe(0)
      }))
  )

  effect(
    "drives a queued run at once when anything but a resumption asks for it",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const { coordinator, open, started } = yield* gated(1)
        for (const key of ["held", "run", "schedule", "scheduleIf", "wake", "queued"]) {
          yield* coordinator.schedule(key, { resumed: true })
        }
        yield* Effect.yieldNow
        expect(started).toEqual(["held"])
        // A resumption that asks again leaves its run queued.
        yield* coordinator.schedule("queued", { resumed: true })
        const joined = yield* coordinator.run("queued", { resumed: true }).pipe(Effect.forkChild)
        const run = yield* coordinator.run("run").pipe(Effect.forkChild)
        yield* coordinator.schedule("schedule")
        yield* coordinator.scheduleIf("scheduleIf", Effect.succeed(false))
        yield* coordinator.wake("wake")
        yield* Effect.yieldNow
        expect([...started].sort()).toEqual(["held", "run", "schedule", "scheduleIf", "wake"])
        for (const key of ["run", "schedule", "scheduleIf"]) yield* open(key)
        yield* Fiber.join(run)
        yield* coordinator.join("schedule")
        yield* coordinator.join("scheduleIf")
        // A promoted run holds no slot: the queued one still waits for the held one.
        expect(started).not.toContain("queued")
        yield* open("held")
        yield* coordinator.join("held")
        yield* Effect.yieldNow
        expect(started).toContain("queued")
        yield* open("queued")
        yield* Fiber.join(joined)
        // The wake asked for one more drain after the one it promoted.
        yield* open("wake")
        while ((yield* coordinator.active).has("wake")) yield* Effect.yieldNow
        expect(started.filter((key) => key === "wake")).toHaveLength(2)
      }))
  )

  effect(
    "frees a slot however a resumed drain ends, and hands it to the next",
    () =>
      Effect.scoped(
        Effect.gen(function*() {
          const coordinator = yield* RunCoordinator.make({
            drain: (key: string) => key === "fails" ? Effect.die("drain died") : Effect.void,
            resumeConcurrency: 1
          })
          yield* coordinator.schedule("fails", { resumed: true })
          yield* coordinator.schedule("next", { resumed: true })
          yield* coordinator.join("next")
          yield* coordinator.join("fails")
          expect((yield* coordinator.active).size).toBe(0)
        }).pipe(Effect.provide(Logger.layer([])))
      )
  )

  effect(
    "a resumption of a run already draining follows it, as a wake does",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const { coordinator, open, started } = yield* gated(1)
        yield* coordinator.schedule("run")
        yield* Effect.yieldNow
        yield* coordinator.wake("run", { resumed: true })
        yield* open("run")
        while ((yield* coordinator.active).has("run")) yield* Effect.yieldNow
        expect(started).toEqual(["run", "run"])
      }))
  )

  effect("without resumeConcurrency, resumptions drain at once", () =>
    Effect.scoped(Effect.gen(function*() {
      const { coordinator, started } = yield* gated()
      for (const key of ["a", "b", "c"]) yield* coordinator.schedule(key, { resumed: true })
      yield* Effect.yieldNow
      expect(started).toEqual(["a", "b", "c"])
    })))

  effect(
    "an interrupt of a queued run starts its drive at once, so the drive can deliver the cancellation",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const { coordinator, open, started } = yield* gated(1)
        for (const key of ["held", "interrupted", "requested"]) yield* coordinator.schedule(key, { resumed: true })
        yield* coordinator.interrupt("interrupted")
        yield* coordinator.requestInterrupt("requested")
        yield* Effect.yieldNow
        expect([...started].sort()).toEqual(["held", "interrupted", "requested"])
        // Their drives run to their end: the interrupt had no drive to stop when it came.
        yield* open("interrupted")
        yield* open("requested")
        yield* coordinator.join("interrupted")
        yield* coordinator.join("requested")
        expect([...(yield* coordinator.active)]).toEqual(["held"])
      }))
  )

  effect("closing the coordinator ends every run still waiting its turn", () =>
    Effect.gen(function*() {
      const outcome = yield* Effect.scoped(Effect.gen(function*() {
        const { coordinator, started } = yield* gated(1)
        yield* coordinator.schedule("held", { resumed: true })
        const waiter = yield* coordinator.run("queued", { resumed: true }).pipe(Effect.forkDetach)
        yield* Effect.yieldNow
        expect(started).toEqual(["held"])
        return { coordinator, waiter }
      }))
      expect((yield* outcome.coordinator.active).size).toBe(0)
      const exit = yield* Fiber.await(outcome.waiter)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    }))

  effect("a resumed drain's follow-up keeps its turn when the drain fails", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        const started: Array<string> = []
        let failures = 1
        const coordinator = yield* RunCoordinator.make({
          drain: (key: string) =>
            Effect.sync(() => started.push(key)).pipe(
              Effect.andThen(key === "a" && failures-- > 0 ? Effect.die("drain died") : Deferred.await(gate))
            ),
          resumeConcurrency: 1
        })
        yield* coordinator.schedule("a", { resumed: true })
        yield* coordinator.wake("a", { resumed: true })
        yield* coordinator.schedule("b", { resumed: true })
        while (started.length < 2) yield* Effect.yieldNow
        yield* Effect.yieldNow
        // The failed drain's follow-up runs in its slot; the next run still waits.
        expect(started).toEqual(["a", "a"])
        yield* Deferred.succeed(gate, undefined)
        yield* coordinator.join("b")
        expect(started).toEqual(["a", "a", "b"])
      }).pipe(Effect.provide(Logger.layer([])))
    ))

  it("refuses a resumeConcurrency that is not a positive integer", () => {
    for (const resumeConcurrency of [0, -1, 1.5, Number.NaN]) {
      expect(() => Effect.runSync(Effect.scoped(RunCoordinator.make({ drain: () => Effect.void, resumeConcurrency }))))
        .toThrow(/resumeConcurrency/)
    }
  })
})
