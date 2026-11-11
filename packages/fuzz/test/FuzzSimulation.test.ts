import { assert, describe, it } from "@effect/vitest"
import { Arbitrary, Clock, Deferred, Duration, Effect, Exit, Fiber, Ref, Schema } from "effect"
import { Fuzz } from "../src/index.ts"
import * as Format from "../src/internal/fuzz/format.ts"
import * as Simulation from "../src/internal/fuzz/simulation.ts"
import { FuzzSimulation } from "../src/index.ts"

const Amount = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))
const amounts = Arbitrary.schema(Schema.Tuple([Amount, Amount]))

// A check-then-act race: two withdrawals read the balance, check it, then write. The default scheduler runs each
// withdrawal to completion, so money is conserved; a preemption between the read and the write loses an update and
// pays out more than the account held.
const withdraw = Effect.fnUntraced(function*(
  balance: Ref.Ref<number>,
  paid: Ref.Ref<number>,
  amount: number,
  log: Array<string>,
  name: string
) {
  const current = yield* Ref.get(balance)
  log.push(`${name} reads ${current}`)
  if (current < amount) return
  yield* Ref.set(balance, current - amount)
  yield* Ref.update(paid, (total) => total + amount)
  log.push(`${name} writes ${current - amount}`)
})

const conservesMoney = (log: Array<string>) =>
  Effect.fnUntraced(function*([a, b]: readonly [number, number]) {
    log.length = 0
    const balance = yield* Ref.make(100)
    const paid = yield* Ref.make(0)
    yield* Effect.all([withdraw(balance, paid, a, log, "A"), withdraw(balance, paid, b, log, "B")], {
      concurrency: 2
    })
    return (yield* Ref.get(balance)) + (yield* Ref.get(paid)) === 100
  })

describe("FuzzSimulation", () => {
  it.effect(
    "finds a race that checkEffect misses in 10,000 runs, and replays it deterministically",
    () =>
      Effect.gen(function*() {
        const log: Array<string> = []
        const checked = yield* Arbitrary.checkEffect(amounts, conservesMoney(log), { runs: 10_000, seed: 1 })
        assert.strictEqual(checked._tag, "Passed")

        const execution = FuzzSimulation.execution()
        const report = yield* Fuzz.run(amounts, conservesMoney(log), { execution, seed: 1, executions: 10_000 })
        assert.strictEqual(report._tag, "Falsified")
        if (report._tag !== "Falsified") return
        const finding = report.findings[0]
        assert.strictEqual(finding.signature, "ReturnedFalse")
        // Once both withdrawals read 100, any amounts break conservation, so shrinking reaches the smallest pair.
        assert.deepStrictEqual(finding.input, [1, 1])

        // The same token gives the same interleaving every time.
        const interleavings = new Set<string>()
        for (let index = 0; index < 1_000; index++) {
          const replayed = yield* Fuzz.run(amounts, conservesMoney(log), { execution, replay: finding.replay })
          assert.strictEqual(replayed._tag, "Falsified")
          interleavings.add(log.join(", "))
        }
        assert.strictEqual(interleavings.size, 1)
        assert.deepStrictEqual([...interleavings][0].split(", ").slice(0, 2), ["A reads 100", "B reads 100"])

        // The schedule shrinks toward cooperative scheduling: most words are zero.
        const schedule = Format.decodeReplay(finding.replay!).input.schedule
        assert.isTrue(schedule.filter((word) => word !== 0).length <= 2)

        // Making the read and the write one atomic step fixes it.
        const atomic = Effect.fnUntraced(function*([x, y]: readonly [number, number]) {
          const balance = yield* Ref.make(100)
          const paid = yield* Ref.make(0)
          const take = (amount: number) =>
            Effect.flatMap(
              Ref.modify(balance, (current) => current >= amount ? [amount, current - amount] : [0, current]),
              (taken) => Ref.update(paid, (total) => total + taken)
            )
          yield* Effect.all([take(x), take(y)], { concurrency: 2 })
          return (yield* Ref.get(balance)) + (yield* Ref.get(paid)) === 100
        })
        const fixed = yield* Fuzz.run(amounts, atomic, { execution, seed: 1, executions: 3_000 })
        assert.strictEqual(fixed._tag, "Passed")
      }),
    120_000
  )

  it.effect("a program waiting forever is a deadlock", () =>
    Effect.gen(function*() {
      const execution = FuzzSimulation.execution()
      const crossed = yield* Fuzz.run(Arbitrary.Constant(0), () =>
        Effect.gen(function*() {
          const left = yield* Deferred.make<void>()
          const right = yield* Deferred.make<void>()
          const a = yield* Effect.forkChild(Effect.andThen(Deferred.await(right), Deferred.succeed(left, undefined)))
          yield* Deferred.await(left)
          yield* Fiber.join(a)
          return true
        }), { execution, seed: 1, executions: 10 })
      assert.strictEqual(crossed._tag === "Falsified" && crossed.findings[0].signature, "Deadlock")
      const forever = yield* Fuzz.run(Arbitrary.Constant(0), () => Effect.as(Effect.sleep(Duration.infinity), true), {
        execution,
        seed: 1,
        executions: 10
      })
      assert.strictEqual(forever._tag === "Falsified" && forever.findings[0].signature, "Deadlock")
    }))

  it.effect("replaying a token that reaches the step limit is an Execution error", () =>
    Effect.gen(function*() {
      const arbitrary = Arbitrary.Constant(0)
      const execution = FuzzSimulation.execution({ maxSteps: 100 })
      const found = yield* Fuzz.run(arbitrary, () => false, { seed: 1, executions: 1, execution })
      assert.strictEqual(found._tag, "Falsified")
      if (found._tag !== "Falsified") return
      let released = 0
      const error = yield* Effect.flip(Fuzz.run(arbitrary, () =>
        Effect.as(Effect.ensuring(
          Effect.forever(Effect.sleep("1 millis")),
          Effect.sync(() => released++)
        ), true), { replay: found.findings[0].replay, execution }))
      assert.deepStrictEqual([error._tag, error.reason, released], ["FuzzError", "Execution", 1])
      assert.include(error.message, "simulation")
      assert.include(error.message, "step limit")
      assert.include(error.message, "replay")
    }))

  it.effect("a saved fixture that reaches the step limit is an Execution error and is retained", () =>
    Effect.gen(function*() {
      const arbitrary = Arbitrary.Constant(0)
      const execution = FuzzSimulation.execution({ maxSteps: 100 })
      for (const codec of [undefined, { id: "number", encode: String, decode: Number }]) {
        const store = Fuzz.memoryCorpus()
        const options = { id: "limited-regression", revision: "1", codec }
        const found = yield* Fuzz.runTarget(Fuzz.target(arbitrary, () => false, options), {
          seed: 1, executions: 1, execution
        }).pipe(Effect.provideService(Fuzz.Corpus, store))
        assert.strictEqual(found._tag, "Falsified")
        if (found._tag !== "Falsified") return
        assert.strictEqual(found.findings[0].saved, codec === undefined ? "Tape" : "Value")
        const saved = yield* store.load(options.id)
        let released = 0
        const limited = Fuzz.target(arbitrary, () =>
          Effect.as(Effect.ensuring(
            Effect.forever(Effect.sleep("1 millis")),
            Effect.sync(() => released++)
          ), true), options)
        const error = yield* Effect.flip(Fuzz.runTarget(limited, { executions: 0, execution }).pipe(
          Effect.provideService(Fuzz.Corpus, store)
        ))
        assert.deepStrictEqual([error._tag, error.reason, released], ["FuzzError", "Execution", 1])
        assert.include(error.message, "simulation")
        assert.include(error.message, "step limit")
        assert.include(error.message, "saved failure")
        assert.deepStrictEqual(yield* store.load(options.id), saved)
        const fixed = yield* Fuzz.runTarget(Fuzz.target(arbitrary, () => true, options), {
          executions: 0, execution
        }).pipe(Effect.provideService(Fuzz.Corpus, store))
        assert.deepStrictEqual([fixed._tag, fixed.stats.regressions], ["Passed", 1])
      }
    }))

  it.effect("replaying a token reports a new deadlock instead of passing", () =>
    Effect.gen(function*() {
      const arbitrary = Arbitrary.Constant(0)
      const execution = FuzzSimulation.execution()
      const original = yield* Fuzz.run(arbitrary, () => false, { seed: 1, executions: 1, execution })
      assert.strictEqual(original._tag, "Falsified")
      if (original._tag !== "Falsified") return
      const replayed = yield* Fuzz.run(arbitrary, () => Effect.as(Effect.never, true), {
        replay: original.findings[0].replay, execution
      })
      assert.strictEqual(replayed._tag, "Falsified")
      if (replayed._tag !== "Falsified") return
      assert.deepStrictEqual([replayed.findings[0].signature, replayed.findings[0].failure, replayed.flaky], [
        "Deadlock", { _tag: "Deadlock" }, []
      ])
      assert.include(Fuzz.formatReport(replayed)!, "deadlock")
    }))

  it.effect("time is virtual: sleeps finish at once, in deadline then registration order", () =>
    Effect.gen(function*() {
      const execution = FuzzSimulation.execution()
      const program = Effect.gen(function*() {
        const order: Array<string> = []
        const start = yield* Clock.currentTimeMillis
        const sleeper = (name: string, duration: Duration.Input) =>
          Effect.andThen(Effect.sleep(duration), Effect.sync(() => order.push(name)))
        yield* Effect.all([sleeper("b", "2 hours"), sleeper("a", "1 hour"), sleeper("c", "2 hours")], {
          concurrency: "unbounded"
        })
        const end = yield* Clock.currentTimeMillis
        const clock = yield* Clock.Clock
        return [
          start,
          end,
          order.join(""),
          yield* Clock.currentTimeNanos,
          yield* Clock.monotonicTimeNanos,
          clock.currentTimeMillisUnsafe(),
          clock.currentTimeNanosUnsafe(),
          clock.monotonicTimeNanosUnsafe()
        ]
      })
      // Schedule word 0 everywhere is ordinary cooperative scheduling.
      const result = yield* execution.run(Effect.exit(program), { next: () => 0 })
      const nanos = BigInt(7_200_000) * BigInt(1_000_000)
      assert.deepStrictEqual(result, {
        _tag: "Completed",
        exit: Exit.succeed([0, 7_200_000, "abc", nanos, nanos, 7_200_000, nanos, nanos])
      })

      // A timeout interrupts the sleep it races, which withdraws that sleep's timer.
      const raced = yield* Fuzz.run(Arbitrary.Constant(0), () =>
        Effect.gen(function*() {
          const exit = yield* Effect.exit(Effect.timeout(Effect.sleep("1 minute"), "1 second"))
          return exit._tag === "Failure" && (yield* Clock.currentTimeMillis) === 1_000
        }), { execution, seed: 1, executions: 50 })
      assert.strictEqual(raced._tag, "Passed")
    }))

  it.effect("an evaluation that exceeds maxSteps is a discard, and its fibers are released", () =>
    Effect.gen(function*() {
      let released = 0
      const execution = FuzzSimulation.execution({ maxSteps: 50, maxOpsBeforeYield: 64 })
      const report = yield* Fuzz.run(Arbitrary.Constant(0), () =>
        Effect.forever(Effect.yieldNow).pipe(
          Effect.ensuring(Effect.sync(() => released++)),
          Effect.as(true)
        ), { execution, seed: 1, executions: 20 })
      assert.deepStrictEqual([report._tag, report.stats.discards, released], ["Exhausted", 20, 20])
    }))

  it("dispatchers run tasks by priority, then FIFO, and flush drains the queue", () => {
    const world = new Simulation.World({ next: () => 0 }, 100, 2048)
    const dispatcher = world.scheduler.makeDispatcher()
    const order: Array<string> = []
    dispatcher.scheduleTask(() => order.push("late 1"), 1)
    dispatcher.scheduleTask(() => order.push("early 1"), 0)
    dispatcher.scheduleTask(() => order.push("late 2"), 1)
    dispatcher.scheduleTask(() => order.push("early 2"), 0)
    dispatcher.scheduleTask(() => order.push("last"), 2)
    dispatcher.flush()
    assert.deepStrictEqual(order, ["early 1", "early 2", "late 1", "late 2", "last"])
    assert.isUndefined(world.dequeue())
  })

  it.effect("finalizers that take many steps run to completion after a deadlock or a step limit", () =>
    Effect.gen(function*() {
      let released = 0
      const slowRelease = Effect.andThen(
        Effect.repeat(Effect.yieldNow, { times: 99 }),
        Effect.sync(() => released++)
      )
      const zero: Fuzz.ScheduleTape = { next: () => 0 }
      const stuck = Effect.exit(Effect.ensuring(Effect.never, slowRelease))
      const deadlock = yield* FuzzSimulation.execution({ maxSteps: 500 }).run(stuck, zero)
      assert.deepStrictEqual([deadlock._tag, released], ["Deadlock", 1])
      const spinning = Effect.exit(Effect.ensuring(Effect.forever(Effect.yieldNow), slowRelease))
      const limited = yield* FuzzSimulation.execution({ maxSteps: 500, maxOpsBeforeYield: 64 }).run(spinning, zero)
      assert.deepStrictEqual([limited._tag, released], ["Limited", 2])
    }))

  it.effect("finalizers that cannot finish within the cleanup budget are an Execution error, not a finding", () =>
    Effect.gen(function*() {
      let released = 0
      const slowRelease = Effect.andThen(
        Effect.repeat(Effect.yieldNow, { times: 99 }),
        Effect.sync(() => released++)
      )
      const execution = FuzzSimulation.execution({ maxSteps: 5 })
      const error = yield* Effect.flip(
        Fuzz.run(Arbitrary.Constant(0), () => Effect.as(Effect.ensuring(Effect.never, slowRelease), true), {
          execution,
          seed: 1,
          executions: 1
        })
      )
      assert.deepStrictEqual([error.reason, error.message.includes("deadlocked"), released], ["Execution", true, 0])
      const spinning = yield* Effect.flip(
        Fuzz.run(
          Arbitrary.Constant(0),
          () => Effect.as(Effect.ensuring(Effect.forever(Effect.yieldNow), slowRelease), true),
          { execution, seed: 1, executions: 1 }
        )
      )
      assert.include(spinning.message, "step-limited evaluation, but its finalizers did not finish within 5 more steps")
    }))

  it.effect("F6: deadlocked finalizers and uninterruptible roots are Execution errors", () =>
    Effect.gen(function*() {
      for (const stuck of [Effect.ensuring(Effect.never, Effect.never), Effect.uninterruptible(Effect.never)]) {
        const error = yield* Effect.flip(Fuzz.run(Arbitrary.Constant(0), () => Effect.as(stuck, true), {
          seed: 1,
          executions: 1,
          execution: FuzzSimulation.execution()
        }))
        assert.strictEqual(error.reason, "Execution")
        assert.include(error.message, "cleanup deadlocked")
      }
    }))

  it.effect("F5: fibers that outlive a completed property are interrupted and their finalizers run", () =>
    Effect.gen(function*() {
      let started = 0
      let released = 0
      const background = Effect.ensuring(
        Effect.andThen(Effect.sync(() => started++), Effect.sleep("1 second")),
        Effect.andThen(Effect.repeat(Effect.yieldNow, { times: 9 }), Effect.sync(() => released++))
      )
      const report = yield* Fuzz.run(Arbitrary.Constant(0), () =>
        Effect.gen(function*() {
          yield* Effect.forkDetach(background)
          yield* Effect.yieldNow
          return true
        }), { execution: FuzzSimulation.execution(), seed: 1, executions: 20 })
      // A fork the root outlives before its first step is interrupted before it starts; its finalizer still runs.
      assert.deepStrictEqual([report._tag, released], ["Passed", 20])
      assert.isAbove(started, 0)
      // A detached fork that has not started yet is still queued when the root exits; it is released too.
      const unstarted = yield* FuzzSimulation.execution().run(
        Effect.exit(Effect.as(Effect.forkDetach(background), "done")),
        { next: () => 0 }
      )
      assert.deepStrictEqual([unstarted, released], [{ _tag: "Completed", exit: Exit.succeed("done") }, 21])
    }))

  it.effect("F5: leftover fibers that cannot finish are an Execution error", () =>
    Effect.gen(function*() {
      for (
        const [leftover, message] of [
          [Effect.uninterruptible(Effect.never), "cleanup deadlocked"],
          [Effect.uninterruptible(Effect.forever(Effect.yieldNow)), "its finalizers did not finish within 50 more steps"]
        ] as const
      ) {
        const error = yield* Effect.flip(Fuzz.run(Arbitrary.Constant(0), () =>
          Effect.gen(function*() {
            yield* Effect.forkDetach(leftover)
            yield* Effect.yieldNow
            return true
          }), { seed: 1, executions: 1, execution: FuzzSimulation.execution({ maxSteps: 50 }) }))
        assert.strictEqual(error.reason, "Execution")
        assert.include(error.message, `the simulation completed an evaluation, but ${message}`)
      }
    }))

  it.effect("virtual time keeps sub-millisecond precision", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        yield* Effect.sleep("500 micros")
        const clock = yield* Clock.Clock
        const half = [yield* Clock.currentTimeNanos, yield* Clock.monotonicTimeNanos, yield* Clock.currentTimeMillis]
        yield* Effect.sleep(Duration.nanos(BigInt(1_500_001)))
        return [
          ...half,
          clock.currentTimeNanosUnsafe(),
          clock.monotonicTimeNanosUnsafe(),
          clock.currentTimeMillisUnsafe()
        ]
      })
      const result = yield* FuzzSimulation.execution().run(Effect.exit(program), { next: () => 0 })
      assert.deepStrictEqual(result, {
        _tag: "Completed",
        exit: Exit.succeed([BigInt(500_000), BigInt(500_000), 0, BigInt(2_000_001), BigInt(2_000_001), 2])
      })
      const sleepsAndReads = yield* Fuzz.run(Arbitrary.Constant(0), () =>
        Effect.gen(function*() {
          yield* Effect.sleep("500 micros")
          return (yield* Clock.currentTimeNanos) === BigInt(500_000)
        }), { execution: FuzzSimulation.execution(), seed: 1, executions: 20 })
      assert.strictEqual(sleepsAndReads._tag, "Passed")
    }))

  it("the step limit applies between timers due at the same time", () => {
    const world = new Simulation.World({ next: () => 0 }, 1, 2048)
    const woken: Array<number> = []
    for (const sequence of [0, 1]) {
      world.timers.push({ deadline: BigInt(1), sequence, wake: () => woken.push(sequence) })
    }
    assert.deepStrictEqual([world.run(() => false, Infinity), woken], ["Limited", [0]])
  })

  it.effect("timer wakes count toward maxSteps, so a sleep loop is limited", () =>
    Effect.gen(function*() {
      let wakes = 0
      const loop = Effect.gen(function*() {
        while (true) {
          // A guard so the old, unbounded pump ends; the limit must stop the loop long before it.
          if (++wakes > 100_000) return yield* Effect.die("unbounded sleep loop")
          yield* Effect.sleep("1 millis")
        }
      })
      const result = yield* FuzzSimulation.execution({ maxSteps: 5 }).run(Effect.exit(loop), { next: () => 0 })
      assert.strictEqual(result._tag, "Limited")
      assert.isTrue(wakes <= 6, `${wakes} wakes`)
    }))

  it.live("a long simulation can be interrupted", () =>
    Effect.gen(function*() {
      const execution = FuzzSimulation.execution({ maxSteps: 20_000_000 })
      const started = Date.now()
      const fiber = yield* Effect.forkChild(
        execution.run(Effect.exit(Effect.forever(Effect.yieldNow)), { next: () => 0 })
      )
      yield* Effect.sleep("50 millis")
      yield* Fiber.interrupt(fiber)
      assert.isTrue(Date.now() - started < 2_000, `${Date.now() - started} ms`)
    }), 120_000)
})
