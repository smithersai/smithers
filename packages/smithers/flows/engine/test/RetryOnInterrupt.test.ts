import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Clock, Effect, Exit, Fiber, Schedule, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"

const flow = Flow.make("RetryOnInterrupt/test", {
  payload: {},
  success: Schema.Void,
  body: () => Node.succeed(undefined)
})
const instance = FlowEngine.makeInstance(flow, "retry-on-interrupt")

const effect = (
  name: string,
  body: () => Effect.Effect<
    void,
    unknown,
    Crypto.Crypto | Scope.Scope | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance
  >
) =>
  it.effect(name, () =>
    withCrypto(
      body().pipe(
        Effect.provide(FlowEngine.layerMemory),
        Effect.provideService(FlowRuntime.FlowInstance, instance),
        Effect.provide(TestClock.layer()),
        Effect.scoped
      )
    ))

describe("Action interrupt retry", () => {
  effect("does not retry ordinary interruption by default", () =>
    Effect.gen(function*() {
      let attempts = 0
      const before = yield* Clock.currentTimeMillis
      const action = Action.make({
        name: "RetryOnInterrupt/default",
        success: Schema.Void,
        error: Schema.Unknown,
        execute: Effect.sync(() => {
          attempts++
        }).pipe(Effect.andThen(Effect.interrupt))
      })
      const exit = yield* action.execute.pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(attempts).toBe(1)
      expect(yield* Clock.currentTimeMillis).toBe(before)
    }))

  effect("retries only an engine InfraInterrupt according to the supplied schedule", () =>
    Effect.gen(function*() {
      let attempts = 0
      const action = Action.make({
        name: "RetryOnInterrupt/infra",
        success: Schema.Number,
        error: Schema.Unknown,
        interruptRetryPolicy: Schedule.spaced("1 second"),
        execute: Effect.suspend(() => {
          attempts++
          return attempts === 3
            ? Effect.succeed(attempts)
            : Effect.fail(new Action.InfraInterrupt({}))
        })
      })
      const fiber = yield* action.execute.pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust("2 seconds")
      const result = yield* Fiber.join(fiber)
      expect(result).toBe(3)
      expect(attempts).toBe(3)
    }))

  effect("turns exhausted InfraInterrupt retries into a defect", () =>
    Effect.gen(function*() {
      const action = Action.make({
        name: "RetryOnInterrupt/exhausted",
        success: Schema.Void,
        error: Schema.Unknown,
        interruptRetryPolicy: Schedule.recurs(0),
        execute: Effect.fail(new Action.InfraInterrupt({}))
      })
      const exit = yield* action.execute.pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && exit.cause.reasons.some((reason) => reason._tag === "Die")).toBe(true)
    }))

  effect("returns immediately when a user cancels an action", () =>
    Effect.gen(function*() {
      let finalized = false
      const action = Action.make({
        name: "RetryOnInterrupt/cancel",
        execute: Effect.never.pipe(Effect.ensuring(Effect.sync(() => {
          finalized = true
        })))
      })
      const fiber = yield* action.execute.pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Fiber.interrupt(fiber)
      expect(finalized).toBe(true)
    }))
})
