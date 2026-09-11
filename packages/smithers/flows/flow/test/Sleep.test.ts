/**
 * The system sleep action: what it puts in a plan, how it parks, and what a
 * settled wait does on replay.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, DurableClock, DurableDeferred, Flow, FlowRuntime, Graph, Interpreter, Sleep } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Clock, Effect, Exit, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { TestClock } from "effect/testing"
import { withCrypto } from "./Crypto.ts"
import { effectOnTestClock as effect, isComplete, pollUntil } from "./Harness.ts"
import { dispatchKey, layerWired, makeInstance } from "./MemoryFlowRuntime.ts"

/** The steps around a wait, so a replay that re-ran one would be visible. */
const Mark = Action.make("sleep/mark", {
  payload: { label: Schema.String },
  success: Schema.String
})

const marks: Array<string> = []

const wired = (
  registration: Layer.Layer<never, never, FlowRuntime.FlowRuntime | Action.Implementations> = Layer.empty
): Layer.Layer<
  Action.Requirement<"sleep/mark"> | FlowRuntime.FlowRuntime | Action.Implementations,
  never,
  Crypto.Crypto
> =>
  Layer.mergeAll(
    Sleep.layer,
    Mark.toLayer(({ label }) =>
      Effect.sync(() => {
        marks.push(label)
        return label
      })
    ),
    registration
  ).pipe(layerWired)

/** A host flow for interpretations driven outside a registered execution. */
const Host = Flow.make("sleep/host", { payload: {}, body: () => Node.succeed(undefined) })

/** The clock the `ordinal`-th sleep of an execution arms, as a test names it. */
const clockOf = (executionId: string, ordinal: number) =>
  DurableClock.make({
    name: `Sleep/${dispatchKey(executionId, Sleep.action, ordinal)}`,
    duration: "10 minutes"
  })

const refusal = (node: Node.Node<unknown, unknown>) =>
  Effect.gen(function*() {
    const instance = makeInstance(Host, "sleep-refusal")
    const exit = yield* withCrypto(
      Effect.exit(Interpreter.interpret(node)).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, instance),
        Effect.provide(wired())
      )
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(instance.waiting).toBeUndefined()
    return Exit.isFailure(exit) ? exit.cause.reasons[0] : undefined
  })

describe("Sleep as a plan node", () => {
  const Timed = Flow.make("sleep/plan", {
    payload: { millis: Schema.Number },
    success: Schema.Void,
    error: Sleep.SleepRequestInvalid,
    body: ({ millis }) => Sleep.action.call({ millis })
  })

  it("is an ordinary declared action", () => {
    expect(Sleep.tag).toBe("system/sleep")
    expect(Sleep.action.name).toBe("system/sleep")
    expect(Sleep.action.tier).toBe("sealed")
  })

  it("appears in a built graph as a keyed action-call node", () => {
    const graph = Graph.build(Timed, { millis: 600_000 })
    const node = Graph.nodes(graph).find((observed) => observed.kind === "ActionCall")

    expect(graph.diagnostics).toEqual([])
    expect(node?.id).toBe("root.flow")
    expect(node?.ast).toEqual({
      _tag: "ActionCall",
      action: "system/sleep",
      payload: { millis: 600_000 }
    })
    expect(node?.payload).toEqual({ millis: 600_000 })
    // The plan the wait is compiled from names it like every other step.
    expect(Graph.drafts(graph).map((draft) => draft.id)).toContain("root.flow")
    expect(node?.draft.material.body).toMatchObject({
      _tag: "ActionCall",
      action: "system/sleep",
      tier: "sealed"
    })
  })
})

describe("Sleep parks", () => {
  effect("parks under the timer wake and resumes when the clock fires", () => {
    marks.length = 0
    const Timed = Flow.make("sleep/durable", {
      payload: { millis: Schema.Number },
      success: Schema.String,
      error: Sleep.SleepRequestInvalid,
      body: ({ millis }) =>
        Mark.call({ label: "before" }).pipe(
          Node.bindPlanned(() => Sleep.action.call({ millis })),
          Node.bindPlanned(() => Mark.call({ label: "after" }))
        )
    })
    const executionId = "sleep-durable"
    return Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      yield* Timed.execute({ millis: 600_000 }, { executionId, discard: true })
      yield* Effect.yieldNow
      const suspended = yield* Timed.poll(executionId)
      expect(Option.isSome(suspended) && suspended.value._tag).toBe("Suspended")
      expect(marks).toEqual(["before"])

      yield* TestClock.adjust("10 minutes")
      const result = yield* pollUntil(Timed.poll(executionId), isComplete, { turns: 20, advance: "1 milli" })
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe("after")
      }
      // The step before the wait was journaled on the first pass: the resumed
      // round replayed its recorded outcome instead of running it again.
      expect(marks).toEqual(["before", "after"])

      // The wake itself is journaled, under the clock this dispatch armed.
      const recorded = yield* engine.deferredResult(clockOf(executionId, 1).deferred).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, makeInstance(Timed, executionId))
      )
      expect(Option.isSome(recorded)).toBe(true)
    }).pipe(Effect.provide(wired(Interpreter.layer(Timed))))
  })

  effect("waits twice for two identical sequential sleeps, with no payload discriminator", () => {
    marks.length = 0
    const Twice = Flow.make("sleep/twice", {
      payload: {},
      success: Schema.String,
      error: Sleep.SleepRequestInvalid,
      body: () =>
        Sleep.action.call({ millis: 600_000 }).pipe(
          Node.bindPlanned(() => Sleep.action.call({ millis: 600_000 })),
          Node.bindPlanned(() => Mark.call({ label: "done" }))
        )
    })
    const executionId = "sleep-twice"
    return Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      yield* Twice.execute({}, { executionId, discard: true })
      yield* Effect.yieldNow

      // The first wait fires. A clock addressed by the payload would have
      // recorded the *second* wait's result along with it, and the run would
      // settle here having slept once for twenty declared minutes.
      yield* TestClock.adjust("10 minutes")
      for (let i = 0; i < 5; i++) yield* Effect.yieldNow
      const midway = yield* Twice.poll(executionId)
      expect(Option.isSome(midway) && midway.value._tag).toBe("Suspended")
      expect(marks).toEqual([])

      yield* TestClock.adjust("10 minutes")
      const result = yield* pollUntil(Twice.poll(executionId), isComplete, { turns: 20, advance: "1 milli" })
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      expect(marks).toEqual(["done"])

      // Two clocks, one per dispatch, both settled.
      const instance = makeInstance(Twice, executionId)
      for (const ordinal of [1, 2]) {
        const recorded = yield* engine.deferredResult(clockOf(executionId, ordinal).deferred).pipe(
          Effect.provideService(FlowRuntime.FlowInstance, instance)
        )
        expect(Option.isSome(recorded)).toBe(true)
      }
    }).pipe(Effect.provide(wired(Interpreter.layer(Twice))))
  })

  effect("rejoins the timer it already armed when the round is re-driven", () => {
    marks.length = 0
    const Rearmed = Flow.make("sleep/rearm", {
      payload: {},
      success: Schema.String,
      error: Sleep.SleepRequestInvalid,
      body: () =>
        Mark.call({ label: "before" }).pipe(
          Node.bindPlanned(() => Sleep.action.call({ millis: 600_000 })),
          Node.bindPlanned(() => Mark.call({ label: "after" }))
        )
    })
    const executionId = "sleep-rearm"
    return Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      yield* Rearmed.execute({}, { executionId, discard: true })
      yield* Effect.yieldNow

      // Half way through the wait, re-drive the round the way a restart or a
      // spurious wake would. The sleep runs again — nothing settled it — and
      // re-derives its clock from the same dispatch.
      yield* TestClock.adjust("5 minutes")
      for (let i = 0; i < 3; i++) {
        yield* engine.resume(Rearmed, executionId)
        yield* Effect.yieldNow
      }
      const midway = yield* Rearmed.poll(executionId)
      expect(Option.isSome(midway) && midway.value._tag).toBe("Suspended")

      // A name that drifted per drive would have armed a second ten-minute
      // timer here, and the run would still be parked five minutes from now.
      yield* TestClock.adjust("5 minutes")
      const result = yield* pollUntil(Rearmed.poll(executionId), isComplete, { turns: 20, advance: "1 milli" })
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      // Three re-drives, and every step around the wait still ran once.
      expect(marks).toEqual(["before", "after"])

      // One clock for the one dispatch, and no second one beside it.
      const instance = makeInstance(Rearmed, executionId)
      const armed = yield* engine.deferredResult(clockOf(executionId, 1).deferred).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, instance)
      )
      const second = yield* engine.deferredResult(clockOf(executionId, 2).deferred).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, instance)
      )
      expect(Option.isSome(armed)).toBe(true)
      expect(Option.isNone(second)).toBe(true)
    }).pipe(Effect.provide(wired(Interpreter.layer(Rearmed))))
  })

  effect("declares the timer waiting vocabulary with the deadline as wakeAt", () => {
    const instance = makeInstance(Host, "sleep-annotation")
    return Effect.gen(function*() {
      // The test clock starts at 0, so an absolute `until` is still ahead.
      // `intoResult` is what turns the suspension interrupt into a settlement
      // rather than interrupting this fiber with it.
      const result = yield* Flow.intoResult(Interpreter.interpret(Sleep.action.call({ until: 5_000 })))
      expect(result._tag).toBe("Suspended")
      expect(instance.suspended).toBe(true)
      expect(instance.waiting).toEqual({ reason: "timer", wakeAt: 5_000 })
    }).pipe(
      Effect.provideService(FlowRuntime.FlowInstance, instance),
      Effect.provide(wired())
    )
  })
})

describe("Sleep replays", () => {
  it.effect("does not park again once its wake is recorded", () =>
    Effect.gen(function*() {
      const instance = makeInstance(Host, "sleep-replay")
      yield* withCrypto(
        Effect.gen(function*() {
          // Exactly the state a fired timer leaves behind before the round is
          // re-driven: the wake recorded under this dispatch's own clock.
          const clock = clockOf("sleep-replay", 1)
          const token = DurableDeferred.tokenFromExecutionId(clock.deferred, {
            flow: Host,
            executionId: "sleep-replay"
          })
          yield* DurableDeferred.succeed(clock.deferred, { token, value: undefined })

          const interpretation = yield* Interpreter.interpret(Sleep.action.call({ millis: 600_000 }))
          expect(interpretation.value).toBeUndefined()
        }).pipe(
          Effect.provideService(FlowRuntime.FlowInstance, instance),
          Effect.provide(wired())
        )
      )
      expect(instance.suspended).toBe(false)
      // The persisted result consumes the declared classification, so a later
      // suspension parks under its own reason.
      expect(instance.waiting).toBeUndefined()
    }))

  it.effect("settles a zero duration without parking", () =>
    Effect.gen(function*() {
      const instance = makeInstance(Host, "sleep-zero")
      yield* withCrypto(
        Effect.gen(function*() {
          const interpretation = yield* Interpreter.interpret(Sleep.action.call({ millis: 0 }))
          expect(interpretation.value).toBeUndefined()
        }).pipe(
          Effect.provideService(FlowRuntime.FlowInstance, instance),
          Effect.provide(wired())
        )
      )
      expect(instance.suspended).toBe(false)
      expect(instance.waiting).toBeUndefined()
    }))

  it.effect("settles a deadline that has already passed instead of parking", () =>
    Effect.gen(function*() {
      const instance = makeInstance(Host, "sleep-past")
      yield* TestClock.setTime(1)
      yield* withCrypto(
        Effect.gen(function*() {
          const interpretation = yield* Interpreter.interpret(Sleep.action.call({ until: 0 }))
          expect(interpretation.value).toBeUndefined()
        }).pipe(
          Effect.provideService(FlowRuntime.FlowInstance, instance),
          Effect.provide(wired())
        )
      )
      expect(instance.suspended).toBe(false)
      expect(instance.waiting).toBeUndefined()
    }))
})

describe("Sleep refusals", () => {
  it.effect("refuses to arm a timer under a runtime that supplies no dispatch identity", () =>
    Effect.gen(function*() {
      const instance = makeInstance(Host, "sleep-unidentified")
      const exit = yield* withCrypto(
        Effect.gen(function*() {
          const engine = yield* FlowRuntime.FlowRuntime
          // A runtime that runs an implementation without saying which dispatch
          // it is. The ordinary path provides `CurrentInvocationKey` here, and a
          // timer named without it would collapse onto every other sleep.
          const unidentified = FlowRuntime.FlowRuntime.of({
            ...engine,
            actionExecute: ((action: Action.Any) =>
              Effect.map(
                Effect.exit(action.executeEncoded),
                (settled) => new Flow.Complete({ exit: settled })
              )) as FlowRuntime.FlowRuntime["Service"]["actionExecute"]
          })
          return yield* Effect.exit(Interpreter.interpret(Sleep.action.call({ millis: 600_000 }))).pipe(
            Effect.provideService(FlowRuntime.FlowRuntime, unidentified)
          )
        }).pipe(
          Effect.provideService(FlowRuntime.FlowInstance, instance),
          Effect.provide(wired())
        )
      )

      expect(Exit.isFailure(exit) && exit.cause.reasons[0]).toMatchObject({
        _tag: "Die",
        defect: expect.stringContaining("CurrentInvocationKey")
      })
      expect(instance.suspended).toBe(false)
    }))

  effect("refuses relative values that are not lengths of time", () =>
    Effect.gen(function*() {
      for (const millis of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN, -1]) {
        expect(yield* refusal(Sleep.action.call({ millis }))).toMatchObject({
          error: {
            _tag: "@smthrs/flow/SleepRequestInvalid",
            code: "invalid_deadline",
            message: expect.stringContaining(`millis ${millis}`)
          }
        })
      }
    }))

  effect("refuses absolute values that are not epoch times", () =>
    Effect.gen(function*() {
      for (const until of [Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(yield* refusal(Sleep.action.call({ until }))).toMatchObject({
          error: {
            _tag: "@smthrs/flow/SleepRequestInvalid",
            code: "invalid_deadline",
            message: expect.stringContaining(`until ${until}`)
          }
        })
      }
    }))

  effect("refuses a relative deadline whose addition overflows", () =>
    Effect.gen(function*() {
      const clock = yield* Clock.Clock
      const overflowClock: Clock.Clock = {
        ...clock,
        currentTimeMillisUnsafe: () => Number.MAX_VALUE,
        currentTimeMillis: Effect.succeed(Number.MAX_VALUE)
      }
      const reason = yield* refusal(Sleep.action.call({ millis: Number.MAX_VALUE })).pipe(
        Effect.provideService(Clock.Clock, overflowClock)
      )
      expect(reason).toMatchObject({
        error: {
          _tag: "@smthrs/flow/SleepRequestInvalid",
          code: "invalid_deadline",
          message: expect.stringContaining(`millis ${Number.MAX_VALUE}`)
        }
      })
    }))

  it.effect("refuses a payload that names no deadline", () =>
    Effect.gen(function*() {
      expect(yield* refusal(Sleep.action.call({}))).toMatchObject({
        error: {
          _tag: "@smthrs/flow/SleepRequestInvalid",
          code: "missing_deadline",
          message: expect.stringContaining("neither")
        }
      })
    }))

  it.effect("refuses a payload that names both a duration and a deadline", () =>
    Effect.gen(function*() {
      expect(yield* refusal(Sleep.action.call({ millis: 1_000, until: 5_000 }))).toMatchObject({
        error: {
          _tag: "@smthrs/flow/SleepRequestInvalid",
          code: "ambiguous_deadline",
          message: expect.stringContaining("one deadline")
        }
      })
    }))
})
