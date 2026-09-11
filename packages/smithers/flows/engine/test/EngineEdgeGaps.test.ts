import { describe, expect, it } from "@effect/vitest"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter, RetryPolicy, StepIdentity } from "@smthrs/flow"
import { Cause, Effect, Exit, Layer, Option, Result, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { FlowEngine } from "../src/index.ts"
import { runSync, withCrypto } from "./Crypto.ts"
import { effect, liveEffect } from "./Harness.ts"

/**
 * The same wiring on the live clock, for cases that wait on the real elapsed
 * time a retry or resume policy schedules rather than driving `TestClock`.
 */
describe("Action.retry outside a flow", () => {
  effect("still advances CurrentAttempt when no engine dispatch fills the ordinal slot", () => {
    // Outside a flow no engine dispatch ever fills the slot (allocation is
    // name-scoped and happens at dispatch, issue #73); the retry wrapper must
    // still work and report attempts.
    const attempts: Array<number> = []
    const body = Effect.gen(function*() {
      const attempt = yield* Action.CurrentAttempt
      const slot = yield* Action.CurrentOrdinal
      attempts.push(attempt)
      expect(slot?.values.size).toBe(0)
      return attempt < 3 ? yield* Effect.fail("again") : attempt
    })

    return Effect.gen(function*() {
      expect(yield* Action.retry(body, { times: 5 })).toBe(3)
      expect(attempts).toEqual([1, 2, 3])
    })
  })

  effect("allocates a single stable ordinal for all attempts inside a flow", () => {
    // The engine fills the retry sequence's slot on the first dispatch and
    // every later attempt reuses it under the enclosing interpreter action's
    // structural site, so the action keeps one identity across the whole
    // sequence (issue #73).
    const ordinals: Array<number | undefined> = []
    let attempts = 0
    const action = Action.make({
      name: "Edge/retry-ordinal-action",
      success: Schema.Number,
      error: Schema.String,
      execute: Effect.gen(function*() {
        attempts++
        return attempts < 3 ? yield* Effect.fail("again") : attempts
      })
    })
    const scope = runSync(
      StepIdentity.allocationScope({
        kind: "action",
        name: "Edge/retry-ordinal-action",
        site: "root.flow"
      }).pipe(Effect.orDie)
    )
    const body = Effect.gen(function*() {
      const result = yield* action
      ordinals.push(...(yield* Action.CurrentOrdinal)?.values.get(scope) ?? [undefined])
      return result
    }).pipe(
      Effect.tapError(() =>
        Effect.gen(function*() {
          ordinals.push(...(yield* Action.CurrentOrdinal)?.values.get(scope) ?? [undefined])
        })
      )
    )
    const flowActionDeclaration = Action.make("Edge/retry-ordinal/action", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    const flow = Flow.make("Edge/retry-ordinal", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() => Action.retry(body, { times: 5 })),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "x" }, { executionId: "run" })).toBe(3)
      // one ordinal, reused across every attempt
      expect(ordinals).toEqual([1, 1, 1])
    }).pipe(Effect.provide(layer))
  })
})

describe("DurableDeferred.into", () => {
  effect("records an ordinary failure verbatim rather than treating it as suspension", () => {
    const Result_ = DurableDeferred.make("Edge/into-failure", {
      success: Schema.Number,
      error: Schema.String
    })
    const flowActionDeclaration = Action.make("Edge/into-failure/action", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    const flow = Flow.make("Edge/into-failure", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    let bodyRuns = 0
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() =>
        Effect.gen(function*() {
          bodyRuns++
          // the second pass observes the persisted failure without re-running
          return yield* DurableDeferred.into(
            Effect.suspend(() => bodyRuns === 1 ? Effect.fail("into-boom") : Effect.succeed(99)),
            Result_
          )
        })
      ),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      const first = yield* flow.execute({ id: "x" }, { executionId: "run-into" }).pipe(Effect.exit)
      expect(Exit.isFailure(first) && Cause.squash(first.cause)).toBe("into-boom")
      const replayed = yield* DurableDeferred.await(Result_).pipe(
        Effect.exit,
        Effect.provideService(
          FlowRuntime.FlowInstance,
          FlowEngine.makeInstance(flow, "run-into")
        )
      )
      expect(Exit.isFailure(replayed) && Cause.squash(replayed.cause)).toBe("into-boom")
    }).pipe(Effect.provide(layer))
  })

  effect("records a success so a later await replays it", () => {
    const Result_ = DurableDeferred.make("Edge/into-success", {
      success: Schema.Number,
      error: Schema.String
    })
    const flowActionDeclaration = Action.make("Edge/into-success/action", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    const flow = Flow.make("Edge/into-success", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() => DurableDeferred.into(Effect.succeed(7), Result_)),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "x" }, { executionId: "run-into-ok" })).toBe(7)
      expect(
        yield* DurableDeferred.await(Result_).pipe(
          Effect.provideService(
            FlowRuntime.FlowInstance,
            FlowEngine.makeInstance(flow, "run-into-ok")
          )
        )
      ).toBe(7)
    }).pipe(Effect.provide(layer))
  })
})

describe("retry decisions on defects", () => {
  effect("a defect is not a retryable failure and propagates immediately", () => {
    // The retry decision point only classifies typed failures. A defect has no
    // Fail reason, so the policy must not consume attempts on it.
    let attempts = 0
    const action = Action.make({
      name: "Edge/dying-action",
      success: Schema.Number,
      error: Schema.String,
      retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 5 }),
      execute: Effect.suspend(() => {
        attempts++
        return Effect.die("kaboom")
      })
    })
    const flowActionDeclaration = Action.make("Edge/dying/action", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    const flow = Flow.make("Edge/dying", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(flowActionDeclaration.toLayer(() => action), Interpreter.layer(flow)).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      const exit = yield* flow.execute({ id: "x" }, { executionId: "run-die" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && String(exit.cause)).toContain("kaboom")
      expect(attempts).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  liveEffect("a typed failure under the same policy is retried to the declared bound", () => {
    let attempts = 0
    const action = Action.make({
      name: "Edge/failing-action",
      success: Schema.Number,
      error: Schema.String,
      retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 3 }),
      execute: Effect.suspend(() => {
        attempts++
        return Effect.fail("again")
      })
    })
    const flowActionDeclaration = Action.make("Edge/failing/action", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    const flow = Flow.make("Edge/failing", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(flowActionDeclaration.toLayer(() => action), Interpreter.layer(flow)).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      const exit = yield* flow.execute({ id: "x" }, { executionId: "run-retry" }).pipe(Effect.exit)
      const defect = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      expect(defect).toBe("again")
      expect(attempts).toBe(3)
    }).pipe(Effect.provide(layer))
  })
})

describe("in-flight action identity", () => {
  effect("joins one in-flight keyed action and replays its first settlement", () => {
    let executions = 0
    const keyed = Action.make({
      name: "Edge/concurrent-keyed",
      success: Schema.Number,
      idempotencyKey: "edge/concurrent",
      execute: Effect.gen(function*() {
        executions++
        for (let i = 0; i < 5; i++) yield* Effect.yieldNow
        return executions
      })
    })
    const flowActionDeclaration = Action.make("Edge/concurrent-keyed/action", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const flow = Flow.make("Edge/concurrent-keyed", {
      payload: { id: Schema.String },
      success: Schema.Number,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() =>
        Effect.gen(function*() {
          yield* Effect.all([keyed, keyed], { concurrency: "unbounded" })
          const inFlight = executions
          expect(inFlight).toBe(1)
          return yield* keyed
        })
      ),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      const replayed = yield* flow.execute({ id: "x" }, { executionId: "run-concurrent" })
      // the third call replayed a settled result instead of running again
      expect(executions).toBe(1)
      expect(replayed).toBe(1)
    }).pipe(Effect.provide(layer))
  })
})

describe("waitForZero", () => {
  effect("holds suspension open across several scheduler turns until the last sibling settles", () => {
    const events: Array<string> = []
    const failing = Action.make({
      name: "Edge/suspending",
      success: Schema.String,
      error: Schema.String,
      execute: Effect.gen(function*() {
        yield* Effect.yieldNow
        return yield* Effect.fail("suspend-now")
      })
    })
    const verySlow = Action.make({
      name: "Edge/very-slow",
      success: Schema.String,
      execute: Effect.gen(function*() {
        events.push("slow:start")
        for (let i = 0; i < 50; i++) yield* Effect.yieldNow
        events.push("slow:end")
        return "slow"
      })
    })
    const flowActionDeclaration = Action.make("Edge/wait-for-zero/action", {
      payload: { id: Schema.String },
      success: Schema.String,
      error: Schema.String
    })
    const flow = Flow.make("Edge/wait-for-zero", {
      payload: { id: Schema.String },
      success: Schema.String,
      error: Schema.String,
      body: (payload) => flowActionDeclaration.call(payload)
    }).annotate(Flow.SuspendOnFailure, true)
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() =>
        Effect.map(
          Effect.all([failing, verySlow], { concurrency: "unbounded" }),
          ([a, b]) => `${a}+${b}`
        )
      ),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      yield* flow.execute({ id: "x" }, { executionId: "run-wait-zero", discard: true })
      let polled = yield* flow.poll("run-wait-zero")
      for (let i = 0; i < 300 && (Option.isNone(polled) || polled.value._tag !== "Suspended"); i++) {
        yield* Effect.yieldNow
        polled = yield* flow.poll("run-wait-zero")
      }
      expect(Option.isSome(polled) && polled.value._tag).toBe("Suspended")
      // suspension waited for the long-running sibling to finish first
      expect(events).toEqual(["slow:start", "slow:end"])
    }).pipe(Effect.provide(layer))
  })
})
