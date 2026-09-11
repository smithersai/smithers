import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { TestClock } from "effect/testing"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"
import { effect } from "./Harness.ts"

describe("action durability tiers", () => {
  effect("sealed actions replay from the memory memo", () => {
    let calls = 0
    const step = Action.make({
      name: "Tiers/sealed",
      success: Schema.Number,
      tier: "sealed",
      idempotencyKey: "sealed/replay",
      execute: Effect.sync(() => ++calls)
    })
    const flowActionDeclaration = Action.make("Tiers/sealed/action", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const flow = Flow.make("Tiers/sealed", {
      payload: { id: Schema.String },
      success: Schema.Number,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() => Effect.andThen(step, step)),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "one" }, { executionId: "run" })).toBe(1)
      expect(calls).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  effect("rejects irreversible retries without an idempotency key", () => {
    let attempts = 0
    const step = Action.make({
      name: "Tiers/irreversible-no-key",
      tier: "irreversible",
      success: Schema.Void,
      error: Schema.String,
      retryPolicy: RetryPolicy.make({ initialMs: 60_000, factor: 1, maxMs: 60_000 }),
      execute: Effect.sync(() => attempts++).pipe(Effect.andThen(Effect.fail("retry")))
    })
    const flowActionDeclaration = Action.make("Tiers/irreversible-no-key/action", {
      payload: { id: Schema.String },
      success: Schema.Void,
      error: Schema.String
    })
    const flow = Flow.make("Tiers/irreversible-no-key", {
      payload: { id: Schema.String },
      success: Schema.Void,
      error: Schema.String,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() => step),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      const fiber = yield* flow.execute({ id: "one" }, { executionId: "run" }).pipe(
        Effect.forkChild({ startImmediately: true })
      )
      for (let index = 0; index < 20 && fiber.pollUnsafe() === undefined; index++) {
        yield* Effect.yieldNow
      }
      // No TestClock adjustment: configuration refusal must happen before
      // the backoff sleep that would otherwise park this fiber.
      const exit = fiber.pollUnsafe()
      expect(exit).toBeDefined()
      expect(exit !== undefined && Exit.isFailure(exit)).toBe(true)
      const defect = exit !== undefined && Exit.isFailure(exit)
        ? exit.cause.reasons.find(Cause.isDieReason)?.defect
        : undefined
      expect(defect).toBeInstanceOf(Action.IrreversibleRetryRequiresIdempotencyKey)
      expect(defect).toMatchObject({ attempt: 2 })
      expect(attempts).toBe(1)
    }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer()))
  })

  effect("allows irreversible retries when an idempotency key is supplied", () => {
    let attempts = 0
    const step = Action.make({
      name: "Tiers/irreversible-keyed",
      tier: "irreversible",
      idempotencyKey: "payment/one",
      success: Schema.Number,
      error: Schema.String,
      execute: Effect.suspend(() => ++attempts === 1 ? Effect.fail("retry") : Effect.succeed(2))
    })
    const flowActionDeclaration = Action.make("Tiers/irreversible-keyed/action", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String
    })
    const flow = Flow.make("Tiers/irreversible-keyed", {
      payload: { id: Schema.String },
      success: Schema.Number,
      error: Schema.String,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() => Action.retry(step, { times: 1 })),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )
    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "one" }, { executionId: "run" })).toBe(2)
      expect(attempts).toBe(2)
    }).pipe(Effect.provide(layer))
  })
})
