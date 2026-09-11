// Deep reviewed and polished by a human on 2026-08-10.

import { describe, expect, it } from "@effect/vitest"
import { Action, DurableClock, DurableDeferred, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Duration, Effect, Exit, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { TestClock } from "effect/testing"
import { effectOnTestClock as effect, isComplete, pollUntil } from "./Harness.ts"
import { layerMemory, layerWired, makeInstance } from "./MemoryFlowRuntime.ts"

describe("DurableClock", () => {
  effect("make derives a deferred named after the clock", () =>
    Effect.sync(() => {
      const clock = DurableClock.make({ name: "make/one", duration: "5 seconds" })
      expect(clock.name).toBe("make/one")
      expect(clock.deferred.name).toBe("DurableClock/make/one")
      expect(clock.duration).toEqual(Duration.seconds(5))
    }))

  it("rejects malformed, infinite, and negative durations before building an effect", () => {
    const invalid = ["not a duration", "Infinity", Number.POSITIVE_INFINITY, -1] as const
    for (const duration of invalid) {
      expect(() => DurableClock.make({ name: "invalid", duration: duration as Duration.Input })).toThrow(/duration/)
      expect(() => DurableClock.sleep({ name: "invalid", duration: duration as Duration.Input })).toThrow(/duration/)
    }
    expect(() =>
      DurableClock.sleep({
        name: "invalid-threshold",
        duration: "1 second",
        inMemoryThreshold: -1
      })
    ).toThrow(/inMemoryThreshold/)
  })

  effect("a zero duration sleep returns without waiting on the clock", () => {
    const Step = Action.make("DurableClock/zero/step", {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const flow = Flow.make("DurableClock/zero", {
      payload: { id: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Step.call(payload)
    })
    const layer = layerWired(Layer.mergeAll(
      Step.toLayer(() =>
        Effect.gen(function*() {
          yield* DurableClock.sleep({ name: "zero", duration: 0 })
          return "immediate"
        })
      ),
      Interpreter.layer(flow)
    ))
    return Effect.gen(function*() {
      // no TestClock.adjust: a zero sleep must not wait for time to pass
      expect(yield* flow.execute({ id: "z" }, { executionId: "zero" })).toBe("immediate")
    }).pipe(Effect.provide(layer))
  })

  effect("sleeps at or below the in-memory threshold never suspend the flow", () => {
    const Step = Action.make("DurableClock/in-memory/step", {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const flow = Flow.make("DurableClock/in-memory", {
      payload: { id: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Step.call(payload)
    })
    const layer = layerWired(Layer.mergeAll(
      Step.toLayer(() =>
        Effect.as(
          DurableClock.sleep({ name: "short", duration: "1 second" }),
          "slept"
        )
      ),
      Interpreter.layer(flow)
    ))
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "s" }, { discard: true })
      const pending = yield* flow.poll(executionId)
      // an in-memory sleep keeps running in the fiber instead of suspending
      expect(Option.isNone(pending)).toBe(true)

      yield* TestClock.adjust("1 second")
      const result = yield* pollUntil(flow.poll(executionId), isComplete, { turns: 10, advance: "1 milli" })
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe("slept")
      }
    }).pipe(Effect.provide(layer))
  })

  effect("a zero threshold is durable while an omitted threshold uses the default", () => {
    const Step = Action.make("DurableClock/zero-threshold/step", {
      payload: { id: Schema.String, useZeroThreshold: Schema.Boolean },
      success: Schema.String
    })
    const flow = Flow.make("DurableClock/zero-threshold", {
      payload: { id: Schema.String, useZeroThreshold: Schema.Boolean },
      success: Schema.String,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Step.call(payload)
    })
    const layer = layerWired(Layer.mergeAll(
      Step.toLayer(({ useZeroThreshold }) =>
        useZeroThreshold
          ? Effect.as(
            DurableClock.sleep({
              name: "zero-threshold",
              duration: "5 millis",
              inMemoryThreshold: 0
            }),
            "slept"
          )
          : Effect.as(
            DurableClock.sleep({
              name: "default-threshold",
              duration: "5 millis"
            }),
            "slept"
          )
      ),
      Interpreter.layer(flow)
    ))
    return Effect.gen(function*() {
      const zeroExecutionId = yield* flow.execute(
        { id: "zero", useZeroThreshold: true },
        { discard: true }
      )
      yield* Effect.yieldNow
      const zeroPending = yield* flow.poll(zeroExecutionId)
      expect(Option.isSome(zeroPending) && zeroPending.value._tag).toBe("Suspended")

      const defaultExecutionId = yield* flow.execute(
        { id: "default", useZeroThreshold: false },
        { discard: true }
      )
      expect(Option.isNone(yield* flow.poll(defaultExecutionId))).toBe(true)

      yield* TestClock.adjust("5 millis")
      const zeroResult = yield* pollUntil(flow.poll(zeroExecutionId), isComplete, { turns: 10, advance: "1 milli" })
      const defaultResult = yield* pollUntil(flow.poll(defaultExecutionId), isComplete, {
        turns: 10,
        advance: "1 milli"
      })
      expect(Option.isSome(zeroResult) && zeroResult.value._tag === "Complete").toBe(true)
      expect(Option.isSome(defaultResult) && defaultResult.value._tag === "Complete").toBe(true)
    }).pipe(Effect.provide(layer))
  })

  effect("the in-memory threshold boundary is inclusive and configurable", () => {
    const Step = Action.make("DurableClock/threshold/step", {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const flow = Flow.make("DurableClock/threshold", {
      payload: { id: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Step.call(payload)
    })
    const layer = layerWired(Layer.mergeAll(
      Step.toLayer(() =>
        Effect.as(
          DurableClock.sleep({
            name: "boundary",
            duration: "2 minutes",
            inMemoryThreshold: "2 minutes"
          }),
          "slept"
        )
      ),
      Interpreter.layer(flow)
    ))
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "b" }, { discard: true })
      // a duration equal to the configured threshold stays in memory (default
      // threshold is 60 seconds, so this would otherwise be durable)
      expect(Option.isNone(yield* flow.poll(executionId))).toBe(true)

      yield* TestClock.adjust("2 minutes")
      const result = yield* pollUntil(flow.poll(executionId), isComplete, { turns: 10, advance: "1 milli" })
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
    }).pipe(Effect.provide(layer))
  })

  effect("sleeps above the threshold suspend the flow until the durable clock fires", () => {
    const Step = Action.make("DurableClock/durable/step", {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const flow = Flow.make("DurableClock/durable", {
      payload: { id: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Step.call(payload)
    })
    const layer = layerWired(Layer.mergeAll(
      Step.toLayer(() =>
        Effect.gen(function*() {
          yield* DurableClock.sleep({
            name: "long",
            duration: "10 minutes",
            inMemoryThreshold: "1 second"
          })
          return "woke"
        })
      ),
      Interpreter.layer(flow)
    ))
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "d" }, { discard: true })
      yield* TestClock.adjust("9 minutes")
      const pending = yield* flow.poll(executionId)
      expect(Option.isSome(pending) && pending.value._tag).toBe("Suspended")

      yield* TestClock.adjust("1 minute")
      const result = yield* pollUntil(flow.poll(executionId), isComplete, { turns: 10, advance: "1 milli" })
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe("woke")
      }
    }).pipe(Effect.provide(layer))
  })

  effect("sequential durable sleeps each wake at their own deadline", () => {
    const Step = Action.make("DurableClock/sequential/step", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const flow = Flow.make("DurableClock/sequential", {
      payload: { id: Schema.String },
      success: Schema.Number,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Step.call(payload)
    })
    const marks: Array<string> = []
    const layer = layerWired(Layer.mergeAll(
      Step.toLayer(() =>
        Effect.gen(function*() {
          yield* DurableClock.sleep({
            name: "first",
            duration: "5 minutes",
            inMemoryThreshold: "1 second"
          })
          yield* Action.make({
            name: "sequential/mark-first",
            tier: "sealed",
            idempotencyKey: "sequential/mark-first",
            success: Schema.Void,
            execute: Effect.sync(() => {
              marks.push("first")
            })
          })
          yield* DurableClock.sleep({
            name: "second",
            duration: "5 minutes",
            inMemoryThreshold: "1 second"
          })
          return marks.length
        })
      ),
      Interpreter.layer(flow)
    ))
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "q" }, { discard: true })
      yield* TestClock.adjust("5 minutes")
      yield* Effect.yieldNow
      const midway = yield* flow.poll(executionId)
      expect(marks).toEqual(["first"])
      expect(Option.isSome(midway) && midway.value._tag).toBe("Suspended")

      yield* TestClock.adjust("5 minutes")
      const result = yield* pollUntil(flow.poll(executionId), isComplete, { turns: 10, advance: "1 milli" })
      expect(Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)).toBe(true)
      if (Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)) {
        expect(result.value.exit.value).toBe(1)
      }
    }).pipe(Effect.provide(layer))
  })

  effect("an early wake wins the race against the armed timer, which then fires into a no-op", () => {
    const Step = Action.make("DurableClock/early-wake/step", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const flow = Flow.make("DurableClock/early-wake", {
      payload: { id: Schema.String },
      success: Schema.Number,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Step.call(payload)
    })
    let bodiesPastSleep = 0
    const layer = layerWired(Layer.mergeAll(
      Step.toLayer(() =>
        Effect.gen(function*() {
          yield* DurableClock.sleep({
            name: "wakeable",
            duration: "10 minutes",
            inMemoryThreshold: "1 second"
          })
          return ++bodiesPastSleep
        })
      ),
      Interpreter.layer(flow)
    ))
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "e" }, { discard: true })
      yield* TestClock.adjust("1 minute")
      expect(Option.isSome(yield* flow.poll(executionId))).toBe(true)

      const clock = DurableClock.make({ name: "wakeable", duration: "10 minutes" })
      const token = DurableDeferred.tokenFromExecutionId(clock.deferred, { flow, executionId })
      yield* DurableDeferred.succeed(clock.deferred, { token, value: undefined })

      const woken = yield* pollUntil(flow.poll(executionId), isComplete, { turns: 10, advance: "1 milli" })
      expect(Option.isSome(woken) && woken.value._tag).toBe("Complete")
      expect(bodiesPastSleep).toBe(1)

      // the timer still fires at its original deadline; it must not resume the
      // already-completed flow or overwrite the recorded wake
      yield* TestClock.adjust("10 minutes")
      yield* Effect.yieldNow
      const settled = yield* flow.poll(executionId)
      expect(Option.isSome(settled) && settled.value._tag).toBe("Complete")
      expect(bodiesPastSleep).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  effect("re-scheduling an armed clock keeps the original deadline", () =>
    Effect.gen(function*() {
      const flow = Flow.make("DurableClock/duplicate", {
        payload: { id: Schema.String },
        success: Schema.Void,
        idempotencyKey: ({ id }) => id,
        body: () => Node.succeed(undefined)
      })
      const engine = yield* FlowRuntime.FlowRuntime
      const first = DurableClock.make({ name: "dup", duration: "10 minutes" })
      const second = DurableClock.make({ name: "dup", duration: "1 minute" })
      yield* engine.scheduleClock(flow, { executionId: "dup", clock: first })
      yield* engine.scheduleClock(flow, { executionId: "dup", clock: second })

      const instance = makeInstance(flow, "dup")
      const read = engine.deferredResult(first.deferred).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, instance)
      )
      expect(Option.isNone(yield* read)).toBe(true)
      yield* TestClock.adjust("1 minute")
      // the shorter duplicate must not shorten the already-armed deadline
      expect(Option.isNone(yield* read)).toBe(true)
      yield* TestClock.adjust("9 minutes")
      expect(Option.isSome(yield* read)).toBe(true)
    }).pipe(Effect.provide(layerMemory)))
})
