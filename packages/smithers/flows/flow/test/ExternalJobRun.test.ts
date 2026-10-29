/**
 * `ExternalJob`'s `run`, from inside a step: work that ends within the wait
 * is started, waited on and collected in the step, with no execution of the
 * job; anything else goes to the job's own execution under the same key.
 * And the job's own probe, whose read may wait until the next probe is due.
 */
import { describe, expect, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Action, ExternalJob, FlowRuntime } from "@smthrs/flow"
import { Cause, Clock, type Duration, Effect, Exit, Fiber, Layer, Metric, Schema } from "effect"
import { TestClock } from "effect/testing"
import { withCrypto } from "./Crypto.ts"

const Job = ExternalJob.make("test/run-job", {
  payload: { value: Schema.String },
  handle: Schema.String,
  success: Schema.String,
  error: Schema.String,
  probe: { every: "100 millis", max: "400 millis" },
  timeout: "10 seconds"
})

type Answer = ExternalJob.Status | "hold"

/**
 * A provider whose status reads answer `answers` in turn (`Running` once they run out), each read recorded with the
 * wait it was given. With `exitAt`, a read instead waits as long as it may for the work to exit at that time, and
 * answers what it sees then: an adapter that can wait.
 */
const provider = (options: {
  readonly answers?: Array<Answer>
  readonly exitAt?: number
  /** The longest one read waits, as a box's observe waits at most a minute. */
  readonly waitCap?: number
  readonly startFails?: number
  readonly holdStart?: boolean
  readonly abandon?: boolean
  readonly stopFails?: boolean
}) => {
  const calls: Array<string> = []
  let startFailures = options.startFails ?? 0
  const answers = [...(options.answers ?? [])]
  const operations: ExternalJob.Operations<{ readonly value: string }, string, string, string, never> = {
    start: (payload, key) =>
      Effect.suspend(() => {
        calls.push(`start ${key}`)
        if (options.holdStart === true) return Effect.never
        return startFailures-- > 0 ? Effect.fail("start refused") : Effect.succeed(`handle:${payload.value}`)
      }),
    status: (_handle, key, read) =>
      Effect.gen(function*() {
        calls.push(`status ${key} ${read?.waitMs}`)
        if (options.exitAt !== undefined) {
          const left = options.exitAt - (yield* Clock.currentTimeMillis)
          if (left > 0) yield* Effect.sleep(Math.min(left, read?.waitMs ?? 0, options.waitCap ?? Infinity))
          return (yield* Clock.currentTimeMillis) >= options.exitAt
            ? { _tag: "Exited" as const, exitCode: 0 }
            : { _tag: "Running" as const }
        }
        const answer = answers.shift() ?? { _tag: "Running" as const }
        return answer === "hold" ? yield* Effect.never : answer
      }),
    collect: (handle, key) =>
      Effect.sync(() => {
        calls.push(`collect ${key}`)
        return `collected ${handle}`
      }),
    cancel: (_handle, key) =>
      Effect.suspend(() => {
        calls.push(`cancel ${key}`)
        return options.stopFails === true ? Effect.fail("cancel refused") : Effect.void
      }),
    ...(options.abandon === true
      ? {
        abandon: (_payload: { readonly value: string }, key: string) =>
          Effect.suspend(() => {
            calls.push(`abandon ${key}`)
            return options.stopFails === true ? Effect.fail("abandon refused") : Effect.void
          })
      }
      : {})
  }
  const layer = Job.toLayer(operations).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory)
  )
  return { calls, operations, layer }
}

type Provider = ReturnType<typeof provider>

/** Runs `effect` with `p`'s job registered on the memory engine, on the test clock. */
const on = <A, E>(p: Provider, effect: Effect.Effect<A, E, FlowRuntime.FlowRuntime | import("effect/Crypto").Crypto>) =>
  withCrypto(Effect.provide(effect, p.layer))

/** Whether the job has an execution `id`. */
const made = (id: string) =>
  Effect.flatMap(FlowRuntime.FlowRuntime, (runtime) =>
    runtime.poll(Job, id).pipe(
      Effect.as(true),
      Effect.catchTag("@smthrs/flow/FlowExecutionNotFound", () => Effect.succeed(false))
    ))

/** A few scheduler turns, so forked work runs up to its next sleep. */
const turns = Effect.gen(function*() {
  for (let turn = 0; turn < 50; turn++) yield* Effect.yieldNow
})

describe("ExternalJob run", () => {
  it.effect("collects work that ends within the wait in the step, and makes no execution of the job", () => {
    const p = provider({ answers: [{ _tag: "Exited", exitCode: 0 }] })
    return on(
      p,
      Effect.gen(function*() {
        const result = yield* Job.run({ value: "a" }, { executionId: "a", operations: p.operations })
        expect(result).toBe("collected handle:a")
        // The read may wait up to the whole wait, `probe.max` unless set.
        expect(p.calls).toEqual(["start a#g1", "status a#g1 400", "collect a#g1"])
        expect(yield* made("a")).toBe(false)
      })
    )
  })

  it.effect("answers an exit when it happens, through a read that waits for it", () => {
    const p = provider({ exitAt: 250 })
    return on(
      p,
      Effect.gen(function*() {
        const running = yield* Effect.forkChild(Job.run({ value: "b" }, { executionId: "b", operations: p.operations }))
        yield* turns
        yield* TestClock.adjust(249)
        yield* turns
        expect(running.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust(1)
        expect(yield* Fiber.join(running)).toBe("collected handle:b")
        expect(p.calls).toEqual(["start b#g1", "status b#g1 400", "collect b#g1"])
        expect(yield* Clock.currentTimeMillis).toBe(250)
      })
    )
  })

  it.effect("asks a read that waited as long as it could again at once", () => {
    // Each read waits at most `probe.max`, as a box's observe waits at most a minute.
    const p = provider({ exitAt: 900, waitCap: 400 })
    return on(
      p,
      Effect.gen(function*() {
        const running = yield* Effect.forkChild(
          Job.run({ value: "w" }, { executionId: "w", operations: p.operations, wait: "1 second" })
        )
        for (const ms of [400, 400, 100]) {
          yield* turns
          yield* TestClock.adjust(ms)
        }
        expect(yield* Fiber.join(running)).toBe("collected handle:w")
        // Reads at 0, 400 and 800, each the moment the one before it ended: no schedule's sleep between them.
        expect(p.calls).toEqual([
          "start w#g1",
          "status w#g1 1000",
          "status w#g1 600",
          "status w#g1 200",
          "collect w#g1"
        ])
        expect(yield* Clock.currentTimeMillis).toBe(900)
      })
    )
  })

  it.effect("waits no later than its drive's deadline, and hands work still running then to the job", () => {
    const p = provider({
      answers: [{ _tag: "Running" }, { _tag: "Running" }, { _tag: "Running" }, { _tag: "Exited", exitCode: 0 }]
    })
    return on(
      p,
      Effect.gen(function*() {
        const running = yield* Effect.forkChild(
          Job.run({ value: "y" }, { executionId: "y", operations: p.operations }).pipe(
            Effect.provideService(FlowRuntime.DriveDeadline, 150)
          )
        )
        for (let step = 0; step < 8; step++) {
          yield* turns
          yield* TestClock.adjust(100)
        }
        expect(yield* Fiber.join(running)).toBe("collected handle:y")
        // The step's reads end with a last look at the deadline, 150 ms in; then the job starts the same key and reads on.
        expect(p.calls.slice(0, 5)).toEqual([
          "start y#g1",
          "status y#g1 150",
          "status y#g1 50",
          "status y#g1 0",
          "start y#g1"
        ])
        expect(yield* made("y")).toBe(true)
      })
    )
  })

  it.effect("leaves work to the job at once when its drive's deadline has passed", () => {
    const p = provider({ answers: [{ _tag: "Exited", exitCode: 0 }] })
    return on(
      p,
      Effect.gen(function*() {
        const result = yield* Job.run({ value: "z" }, { executionId: "z", operations: p.operations }).pipe(
          Effect.provideService(FlowRuntime.DriveDeadline, 0)
        )
        expect(result).toBe("collected handle:z")
        // The job's own start and probe: the step made no read of its own.
        expect(p.calls).toEqual(["start z#g1", "status z#g1 100", "collect z#g1"])
      })
    )
  })

  it.effect("asks a read that can't wait again on the job's schedule until the wait is over", () => {
    const p = provider({ answers: [{ _tag: "Running" }, { _tag: "Running" }, { _tag: "Exited", exitCode: 0 }] })
    return on(
      p,
      Effect.gen(function*() {
        const running = yield* Effect.forkChild(Job.run({ value: "c" }, { executionId: "c", operations: p.operations }))
        yield* turns
        yield* TestClock.adjust(100)
        yield* turns
        yield* TestClock.adjust(200)
        expect(yield* Fiber.join(running)).toBe("collected handle:c")
        // Asked at 0, 100 and 300: each read may wait out what is left of the 400 ms.
        expect(p.calls).toEqual(["start c#g1", "status c#g1 400", "status c#g1 300", "status c#g1 100", "collect c#g1"])
        expect(yield* made("c")).toBe(false)
      })
    )
  })

  it.effect("hands work still running when the wait is over to the job, under the same key", () => {
    // Running through the step's 200 ms and the job's first probe, then exited.
    const p = provider({
      answers: [{ _tag: "Running" }, { _tag: "Running" }, { _tag: "Running" }, { _tag: "Running" }, {
        _tag: "Exited",
        exitCode: 0
      }]
    })
    return on(
      p,
      Effect.gen(function*() {
        const running = yield* Effect.forkChild(
          Job.run({ value: "d" }, { executionId: "d", operations: p.operations, wait: "200 millis" })
        )
        for (let step = 0; step < 12; step++) {
          yield* turns
          yield* TestClock.adjust(100)
        }
        expect(yield* Fiber.join(running)).toBe("collected handle:d")
        // The step's reads at 0, 100 and 200 ms; then the job starts the same key (the provider answers its handle and
        // starts nothing), and its probes wait until each next one is due: 100 ms, then 200.
        expect(p.calls).toEqual([
          "start d#g1",
          "status d#g1 200",
          "status d#g1 100",
          "status d#g1 0",
          "start d#g1",
          "status d#g1 100",
          "status d#g1 200",
          "collect d#g1"
        ])
        expect(yield* made("d")).toBe(true)
      })
    )
  })

  it.effect("joins the job an earlier attempt of the step handed its work to", () => {
    const p = provider({ answers: [{ _tag: "Exited", exitCode: 0 }] })
    return on(
      p,
      Effect.gen(function*() {
        const runtime = yield* FlowRuntime.FlowRuntime
        yield* runtime.execute(Job, { executionId: "e", payload: { value: "e" }, discard: true })
        yield* turns
        const result = yield* Job.run({ value: "e" }, { executionId: "e", operations: p.operations })
        expect(result).toBe("collected handle:e")
        // One start: the job's. The step never ran it again.
        expect(p.calls.filter((call) => call.startsWith("start"))).toEqual(["start e#g1"])
      })
    )
  })

  it.effect("leaves a refused start and a lost generation to the job, which decides them", () => {
    const refused = provider({ startFails: 1, answers: [{ _tag: "Exited", exitCode: 0 }] })
    const lost = provider({ answers: [{ _tag: "Lost" }, { _tag: "Lost" }] })
    return Effect.gen(function*() {
      const answered = yield* on(refused, Job.run({ value: "f" }, { executionId: "f", operations: refused.operations }))
      expect(answered).toBe("collected handle:f")
      expect(refused.calls.slice(0, 2)).toEqual(["start f#g1", "start f#g1"])
      const exit = yield* on(
        lost,
        Effect.exit(Job.run({ value: "g" }, { executionId: "g", operations: lost.operations }))
      )
      expect(Exit.isFailure(exit) && Cause.squash(exit.cause)).toBeInstanceOf(ExternalJob.ExternalJobLost)
      expect(lost.calls).toEqual(["start g#g1", "status g#g1 400", "start g#g1", "status g#g1 100", "cancel g#g1"])
    })
  })

  describe("interrupted", () => {
    /** Interrupts `p`'s run once it is held, in a run whose instance `interrupted` says whether it was cancelled. */
    const interrupt = (p: Provider, id: string, cancelled: boolean) =>
      on(
        p,
        Effect.gen(function*() {
          const instance = FlowEngine.makeInstance(Job, `caller-${id}`)
          instance.interrupted = cancelled
          const running = yield* Effect.forkChild(
            Job.run({ value: id }, { executionId: id, operations: p.operations }).pipe(
              Effect.provideService(FlowRuntime.FlowInstance, instance)
            )
          )
          yield* turns
          yield* Fiber.interrupt(running)
        })
      )

    it.effect("stops the work when its run was cancelled", () => {
      const p = provider({ answers: ["hold"] })
      return Effect.gen(function*() {
        yield* interrupt(p, "h", true)
        expect(p.calls).toEqual(["start h#g1", "status h#g1 400", "cancel h#g1"])
      })
    })

    it.effect("abandons a start that never answered, where the adapter can", () => {
      const p = provider({ holdStart: true, abandon: true })
      const without = provider({ holdStart: true })
      return Effect.gen(function*() {
        yield* interrupt(p, "i", true)
        expect(p.calls).toEqual(["start i#g1", "abandon i#g1"])
        yield* interrupt(without, "j", true)
        expect(without.calls).toEqual(["start j#g1"])
      })
    })

    it.effect("logs a stop the provider refused, and fails nothing", () => {
      const held = provider({ answers: ["hold"], stopFails: true })
      const starting = provider({ holdStart: true, abandon: true, stopFails: true })
      return Effect.gen(function*() {
        yield* interrupt(held, "k", true)
        yield* interrupt(starting, "l", true)
        expect(held.calls.at(-1)).toBe("cancel k#g1")
        expect(starting.calls.at(-1)).toBe("abandon l#g1")
      })
    })

    it.effect("leaves the work to the step's next attempt when its host stops", () => {
      const p = provider({ answers: ["hold"] })
      const bare = provider({ answers: ["hold"] })
      return Effect.gen(function*() {
        yield* interrupt(p, "m", false)
        expect(p.calls).toEqual(["start m#g1", "status m#g1 400"])
        // Outside any run at all.
        yield* on(
          bare,
          Effect.gen(function*() {
            const running = yield* Effect.forkChild(
              Job.run({ value: "n" }, { executionId: "n", operations: bare.operations })
            )
            yield* turns
            yield* Fiber.interrupt(running)
          })
        )
        expect(bare.calls).toEqual(["start n#g1", "status n#g1 400"])
      })
    })
  })

  it("refuses a wait that is negative or not finite", () => {
    const p = provider({})
    for (const wait of [-1, Infinity, "soon" as Duration.Input] as const) {
      expect(() => Job.run({ value: "x" }, { executionId: "x", operations: p.operations, wait })).toThrow(
        new RangeError("ExternalJob.run: wait must be a finite duration, 0 or more")
      )
    }
  })

  it.effect("hands work to the job at once when the wait is 0", () => {
    const p = provider({ answers: [{ _tag: "Exited", exitCode: 0 }] })
    return on(
      p,
      Effect.gen(function*() {
        expect(yield* Job.run({ value: "v" }, { executionId: "v", operations: p.operations, wait: 0 })).toBe(
          "collected handle:v"
        )
        expect(p.calls).toEqual(["start v#g1", "status v#g1 100", "collect v#g1"])
      })
    )
  })

  it.effect("records each wait in the step by how it ended, for the time its drive was held", () => {
    const count = (outcome: string) =>
      Effect.map(
        Metric.value(Metric.withAttributes(ExternalJob.stepWaits, { job: Job._tag, outcome })),
        (state) => state.count
      )
    const collected = provider({ exitAt: 250 })
    const handed = provider({ answers: [{ _tag: "Lost" }, { _tag: "Exited", exitCode: 0 }] })
    const held = provider({ answers: ["hold"] })
    return Effect.gen(function*() {
      const before = { collected: yield* count("collected"), handed: yield* count("handed_off") }
      const interruptedBefore = yield* count("interrupted")
      yield* on(
        collected,
        Effect.gen(function*() {
          const running = yield* Effect.forkChild(
            Job.run({ value: "m1" }, { executionId: "m1", operations: collected.operations })
          )
          yield* turns
          yield* TestClock.adjust(250)
          yield* Fiber.join(running)
        })
      )
      yield* on(handed, Job.run({ value: "m2" }, { executionId: "m2", operations: handed.operations }))
      yield* on(
        held,
        Effect.gen(function*() {
          const running = yield* Effect.forkChild(
            Job.run({ value: "m3" }, { executionId: "m3", operations: held.operations })
          )
          yield* turns
          yield* Fiber.interrupt(running)
        })
      )
      expect(yield* count("collected")).toBe(before.collected + 1)
      expect(yield* count("handed_off")).toBe(before.handed + 1)
      expect(yield* count("interrupted")).toBe(interruptedBefore + 1)
    })
  })
})
