// Deep reviewed and polished by a human on 2026-08-10.

import { describe, expect, it } from "@effect/vitest"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Cause, Effect, Exit, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { withCrypto } from "./Crypto.ts"
import { layerWired } from "./MemoryFlowRuntime.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it.effect(name, () => withCrypto(body()))

const pollUntil = <A, E, R>(
  poll: Effect.Effect<Option.Option<Flow.Result<A, E>>, FlowRuntime.FlowExecutionNotFound, R>,
  predicate: (result: Flow.Result<A, E>) => boolean
) =>
  Effect.gen(function*() {
    let result = yield* poll
    for (let i = 0; i < 50 && (Option.isNone(result) || !predicate(result.value)); i++) {
      yield* Effect.yieldNow
      result = yield* poll
    }
    return result
  })

/**
 * A step that keeps working until something cancels it, so a case can tell a
 * cancelled step from one the fixture merely left running.
 */
const ticking = () => {
  let cancelled = 0
  let ticks = 0
  return {
    execute: Effect.forever(Effect.andThen(Effect.sync(() => void ticks++), Effect.yieldNow)).pipe(
      Effect.onInterrupt(() => Effect.sync(() => void cancelled++))
    ) as Effect.Effect<string>,
    get cancelled() {
      return cancelled
    },
    /** Ticks the step took over ten more turns of the scheduler. */
    get ticksAfter() {
      return Effect.gen(function*() {
        const before = ticks
        for (let i = 0; i < 10; i++) yield* Effect.yieldNow
        return ticks - before
      })
    }
  }
}

const isSuspended = (result: Flow.Result<any, any>) => result._tag === "Suspended"
const isComplete = (result: Flow.Result<any, any>) => result._tag === "Complete"

describe("SuspendOnFailure", () => {
  effect("a failing flow suspends instead of completing, carrying the cause as a defect", () => {
    const Step = Action.make("Suspend/on-failure/step", {
      payload: { id: Schema.String },
      success: Schema.String,
      error: Schema.String
    })
    const flow = Flow.make("Suspend/on-failure", {
      payload: { id: Schema.String },
      success: Schema.String,
      error: Schema.String,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Step.call(payload)
    }).annotate(Flow.SuspendOnFailure, true)

    let attempts = 0
    const layer = layerWired(Layer.mergeAll(
      Step.toLayer(() =>
        Effect.suspend(() => {
          attempts++
          return attempts === 1 ? Effect.fail("nope") : Effect.succeed("ok")
        })
      ),
      Interpreter.layer(flow)
    ))

    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "f" }, { discard: true })
      const suspended = yield* pollUntil(flow.poll(executionId), isSuspended)
      expect(Option.isSome(suspended) && suspended.value._tag).toBe("Suspended")
      // the failure is retained on the suspended result as a defect
      if (Option.isSome(suspended) && suspended.value._tag === "Suspended") {
        expect(suspended.value.cause).toBeDefined()
        expect(String(suspended.value.cause)).toContain("nope")
      }
      expect(attempts).toBe(1)

      // resuming re-runs the handler, which now succeeds
      yield* flow.resume(executionId)
      const done = yield* pollUntil(flow.poll(executionId), isComplete)
      expect(
        Option.isSome(done) && done.value._tag === "Complete" && Exit.isSuccess(done.value.exit) &&
          done.value.exit.value
      ).toBe("ok")
      expect(attempts).toBe(2)
    }).pipe(Effect.provide(layer))
  })

  effect("without the annotation the same failure completes as a typed failure", () => {
    const Step = Action.make("Suspend/no-annotation/step", {
      payload: { id: Schema.String },
      success: Schema.String,
      error: Schema.String
    })
    const flow = Flow.make("Suspend/no-annotation", {
      payload: { id: Schema.String },
      success: Schema.String,
      error: Schema.String,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Step.call(payload)
    })
    const layer = layerWired(
      Layer.mergeAll(Step.toLayer(() => Effect.fail("nope")), Interpreter.layer(flow))
    )
    return Effect.gen(function*() {
      const exit = yield* flow.execute({ id: "g" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
    }).pipe(Effect.provide(layer))
  })

  effect("interrupting a live flow cancels its step and settles the round as an interruption", () => {
    const step = ticking()
    const Step = Action.make("Suspend/interrupted/step", {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const flow = Flow.make("Suspend/interrupted", {
      payload: { id: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Step.call(payload)
    })
    const layer = layerWired(Layer.mergeAll(
      Step.toLayer(() => step.execute),
      Interpreter.layer(flow)
    ))
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "h" }, { discard: true })
      yield* Effect.yieldNow
      yield* flow.interrupt(executionId)
      const polled = yield* pollUntil(flow.poll(executionId), isComplete)
      // the cancellation reaches the step itself, so its finalizers run
      expect(step.cancelled).toBe(1)
      // and the round settles as a completion carrying the interruption:
      // terminal, with no suspension left for a driver to resume
      expect(Option.isSome(polled) && polled.value._tag).toBe("Complete")
      if (Option.isSome(polled) && polled.value._tag === "Complete") {
        expect(
          Exit.isFailure(polled.value.exit) && Cause.hasInterruptsOnly(polled.value.exit.cause)
        ).toBe(true)
      }
      expect(yield* step.ticksAfter).toBe(0)
    }).pipe(Effect.provide(layer))
  })

  effect("a suspend-on-failure flow cancels its step too, and reads as suspended", () => {
    const step = ticking()
    const Step = Action.make("Suspend/interrupted-annotated/step", {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const flow = Flow.make("Suspend/interrupted-annotated", {
      payload: { id: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Step.call(payload)
    }).annotate(Flow.SuspendOnFailure, true)
    const layer = layerWired(Layer.mergeAll(
      Step.toLayer(() => step.execute),
      Interpreter.layer(flow)
    ))
    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "h" }, { discard: true })
      yield* Effect.yieldNow
      yield* flow.interrupt(executionId)
      const polled = yield* pollUntil(flow.poll(executionId), isSuspended)
      expect(step.cancelled).toBe(1)
      // the annotation catches the cancellation along with every other cause,
      // so this round is classified as suspended rather than as the interrupted
      // completion above; the step stops either way
      expect(Option.isSome(polled) && polled.value._tag).toBe("Suspended")
      expect(yield* step.ticksAfter).toBe(0)
    }).pipe(Effect.provide(layer))
  })
})

describe("concurrent action suspension", () => {
  const Gate = DurableDeferred.make("Suspend/Gate", {
    success: Schema.String,
    error: Schema.String
  })

  effect("suspension cancels concurrent siblings, which run exactly once after resumption", () => {
    let slowRuns = 0
    const slow = Action.make({
      name: "Suspend/slow",
      success: Schema.String,
      idempotencyKey: "suspend/slow",
      execute: Effect.gen(function*() {
        slowRuns++
        for (let i = 0; i < 5; i++) yield* Effect.yieldNow
        return "slow"
      })
    })

    const Step = Action.make("Suspend/concurrent/step", {
      payload: { id: Schema.String },
      success: Schema.String,
      error: Schema.String
    })
    const flow = Flow.make("Suspend/concurrent", {
      payload: { id: Schema.String },
      success: Schema.String,
      error: Schema.String,
      idempotencyKey: ({ id }) => id,
      body: (payload) => Step.call(payload)
    })

    const layer = layerWired(Layer.mergeAll(
      Step.toLayer(() =>
        Effect.map(
          Effect.all([DurableDeferred.await(Gate), slow], { concurrency: "unbounded" }),
          ([gated, slowValue]) => `${gated}+${slowValue}`
        )
      ),
      Interpreter.layer(flow)
    ))

    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "c" }, { discard: true })
      const suspended = yield* pollUntil(flow.poll(executionId), isSuspended)
      expect(Option.isSome(suspended) && suspended.value._tag).toBe("Suspended")
      // the unresolved deferred suspends the whole flow before the sibling action settles
      expect(slowRuns).toBe(0)

      const token = DurableDeferred.tokenFromExecutionId(Gate, { flow, executionId })
      yield* DurableDeferred.succeed(Gate, { token, value: "gate" })

      const done = yield* pollUntil(flow.poll(executionId), isComplete)
      expect(
        Option.isSome(done) && done.value._tag === "Complete" && Exit.isSuccess(done.value.exit) &&
          done.value.exit.value
      ).toBe("gate+slow")
      // the sibling ran on the resumed pass only — never twice
      expect(slowRuns).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  effect("keeps waiting when a sibling starts another action after the in-flight count hits zero", () => {
    // The in-flight count can briefly return to zero between two sequential
    // actions of a still-running sibling. Suspension must not be released
    // in that window: every action of the chain has to settle first.
    const ran: Array<string> = []
    const step = (name: string) =>
      Action.make({
        name,
        success: Schema.String,
        execute: Effect.gen(function*() {
          for (let i = 0; i < 2; i++) yield* Effect.yieldNow
          ran.push(name)
          return name
        })
      })
    const failing = Action.make({
      name: "Edge/chain-suspender",
      success: Schema.String,
      error: Schema.String,
      execute: Effect.gen(function*() {
        yield* Effect.yieldNow
        return yield* Effect.fail("chain-boom")
      })
    })
    const Chain = Action.make("Edge/chain/step", {
      payload: { id: Schema.String },
      success: Schema.String,
      error: Schema.String
    })
    const flow = Flow.make("Edge/chain", {
      payload: { id: Schema.String },
      success: Schema.String,
      error: Schema.String,
      body: (payload) => Chain.call(payload)
    }).annotate(Flow.SuspendOnFailure, true)
    const layer = layerWired(Layer.mergeAll(
      Chain.toLayer(() =>
        Effect.map(
          Effect.all([
            failing,
            Effect.gen(function*() {
              yield* step("Edge/chain-a")
              yield* Effect.yieldNow
              yield* step("Edge/chain-b")
              yield* Effect.yieldNow
              yield* Effect.yieldNow
              yield* step("Edge/chain-c")
              return "chain"
            })
          ], { concurrency: "unbounded" }),
          ([a, b]) => `${a}+${b}`
        )
      ),
      Interpreter.layer(flow)
    ))

    return Effect.gen(function*() {
      yield* flow.execute({ id: "x" }, { executionId: "run-chain", discard: true })
      let polled = yield* flow.poll("run-chain")
      for (let i = 0; i < 300 && (Option.isNone(polled) || polled.value._tag !== "Suspended"); i++) {
        yield* Effect.yieldNow
        polled = yield* flow.poll("run-chain")
      }
      expect(Option.isSome(polled) && polled.value._tag).toBe("Suspended")
      expect(ran).toEqual(["Edge/chain-a", "Edge/chain-b", "Edge/chain-c"])
    }).pipe(Effect.provide(layer))
  })
})
