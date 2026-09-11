import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Clock, Effect, Exit, Fiber, Layer, Option, Random, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"

const some = (value: number) => Option.some(value)
const none = Option.none()

describe("expiration (issue #36)", () => {
  it.effect("an expressible wall-clock bound stops an action retrying against a dead dependency", () =>
    Effect.gen(function*() {
      let attempts = 0
      const action = Action.make({
        name: "RetryPolicy/expires",
        success: Schema.Number,
        error: Schema.String,
        retryPolicy: RetryPolicy.make({
          initialMs: 100,
          factor: 1,
          maxMs: 100,
          expirationMs: 250
        }),
        execute: Effect.suspend(() => {
          attempts++
          return Effect.fail("dependency-down")
        })
      })
      const flowActionDeclaration = Action.make("RetryPolicy/expiring-flow/action", {
        payload: {},
        success: Schema.Number,
        error: Schema.String
      })
      const flow = Flow.make("RetryPolicy/expiring-flow", {
        payload: {},
        success: Schema.Number,
        error: Schema.String,
        body: (payload) => flowActionDeclaration.call(payload)
      })

      const exit = yield* withCrypto(
        Effect.gen(function*() {
          const engine = yield* FlowRuntime.FlowRuntime
          const fiber = yield* engine.actionExecute(action, 1).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          // Attempts at t=0, 100, 200; the delay to t=300 crosses the 250ms
          // expiration, so the sequence stops with the final typed failure.
          yield* TestClock.adjust(1_000)
          const result = yield* Fiber.join(fiber)
          return result._tag === "Complete" ? result.exit : Exit.succeed("suspended" as never)
        }).pipe(
          Effect.provide(
            Layer.mergeAll(flowActionDeclaration.toLayer(() => Effect.succeed(0)), Interpreter.layer(flow)).pipe(
              Layer.provideMerge(Action.layerImplementations)
            ).pipe(
              Layer.provideMerge(FlowEngine.layerMemory)
            )
          ),
          Effect.provideService(
            FlowRuntime.FlowInstance,
            FlowEngine.makeInstance(flow, "retry-policy-expires")
          ),
          Effect.provide(TestClock.layer()),
          Effect.scoped
        )
      )

      expect(attempts).toBe(3)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons).toContainEqual(expect.objectContaining({ _tag: "Fail", error: "dependency-down" }))
      }
    }))
})

describe("flow suspension policy", () => {
  it.effect("preserves the policy through annotations and forwards it to execution", () => {
    const policy = RetryPolicy.make({ initialMs: 17, factor: 1, maxMs: 17 })
    const suspendedActionDeclaration = Action.make("RetryPolicy/suspended/action", {
      payload: {},
      success: Schema.Void
    })
    const suspended = Flow.make("RetryPolicy/suspended", {
      payload: {},
      success: Schema.Void,
      suspendedRetryPolicy: policy,
      body: (payload) => suspendedActionDeclaration.call(payload)
    }).annotate(Flow.CaptureDefects, true)
    let attempts = 0
    const layer = Layer.mergeAll(
      suspendedActionDeclaration.toLayer(() =>
        Effect.gen(function*() {
          attempts++
          if (attempts === 1) {
            const instance = yield* FlowRuntime.FlowInstance
            return yield* Flow.suspend(instance)
          }
        })
      ),
      Interpreter.layer(suspended)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory)
    )

    expect(suspended.suspendedRetryPolicy).toBe(policy)
    // The declaration's policy is what the engine schedules the resume with:
    // the suspended round is still waiting one millisecond before the 17ms
    // delay and runs its second attempt on the millisecond that reaches it.
    return withCrypto(
      Effect.gen(function*() {
        const fiber = yield* suspended.execute({}, { executionId: "suspended-policy" }).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust(16)
        expect(attempts).toBe(1)
        yield* TestClock.adjust(1)
        yield* Fiber.join(fiber)
        expect(attempts).toBe(2)
      }).pipe(
        Effect.provide(layer),
        Effect.provide(TestClock.layer())
      )
    )
  })
})

// -----------------------------------------------------------------------------
// Engine integration
// -----------------------------------------------------------------------------

const flow = Flow.make("RetryPolicy/test", {
  payload: {},
  success: Schema.Void,
  body: () => Node.succeed(undefined)
})

const effect = (
  name: string,
  body: () => Effect.Effect<
    void,
    unknown,
    Crypto.Crypto | Scope.Scope | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance
  >,
  executionId = "retry-policy"
) =>
  it.effect(name, () =>
    withCrypto(
      body().pipe(
        Effect.provide(FlowEngine.layerMemory),
        Effect.provideService(
          FlowRuntime.FlowInstance,
          FlowEngine.makeInstance(flow, executionId)
        ),
        Effect.provide(TestClock.layer()),
        Effect.scoped
      )
    ))

class Flaky extends Schema.TaggedError<Flaky>()("RetryPolicy/Flaky", {}) {}
class Fatal extends Schema.TaggedError<Fatal>()("RetryPolicy/Fatal", {}) {}

describe("engine retry decision point", () => {
  effect("retries a failing action with policy-derived backoff", () =>
    Effect.gen(function*() {
      const timestamps: Array<number> = []
      const action = Action.make({
        name: "RetryPolicy/backoff",
        success: Schema.Number,
        error: Flaky,
        retryPolicy: RetryPolicy.make({ initialMs: 100, factor: 2, maxMs: 1000 }),
        execute: Effect.gen(function*() {
          timestamps.push(yield* Clock.currentTimeMillis)
          return timestamps.length >= 4
            ? timestamps.length
            : yield* Effect.fail(new Flaky())
        })
      })
      const fiber = yield* action.pipe(Effect.forkChild)
      yield* Effect.yieldNow
      // attempts at t=0, 100, 300 (=100+200), 700 (=300+400)
      yield* TestClock.adjust(700)
      const result = yield* Fiber.join(fiber)
      expect(result).toBe(4)
      expect(timestamps).toEqual([0, 100, 300, 700])
    }))

  effect("maxAttempts exhaustion preserves the declared typed failure", () =>
    Effect.gen(function*() {
      let attempts = 0
      const action = Action.make({
        name: "RetryPolicy/exhausted",
        success: Schema.Void,
        error: Flaky,
        retryPolicy: RetryPolicy.make({
          initialMs: 100,
          factor: 2,
          maxMs: 1000,
          maxAttempts: 3
        }),
        execute: Effect.suspend(() => {
          attempts++
          return Effect.fail(new Flaky())
        })
      })
      const fiber = yield* action.pipe(Effect.exit, Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust(300)
      const exit = yield* Fiber.join(fiber)
      expect(attempts).toBe(3)
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")
        expect(failure).toBeDefined()
        expect(failure?._tag === "Fail" && failure.error).toBeInstanceOf(Flaky)
        expect(exit.cause.reasons.some((reason) => reason._tag === "Die")).toBe(false)
      }
    }))

  effect("exhaustion preserves the final typed failure, not the first one", () =>
    Effect.gen(function*() {
      let attempts = 0
      const action = Action.make({
        name: "RetryPolicy/exhausted-last-error",
        success: Schema.Void,
        error: Schema.String,
        retryPolicy: RetryPolicy.make({
          initialMs: 100,
          factor: 1,
          maxMs: 100,
          maxAttempts: 3
        }),
        execute: Effect.suspend(() => Effect.fail(`failure-${++attempts}`))
      })
      const fiber = yield* action.pipe(Effect.exit, Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust(300)
      const exit = yield* Fiber.join(fiber)
      expect(attempts).toBe(3)
      expect(Exit.isFailure(exit) && exit.cause.reasons).toContainEqual(
        expect.objectContaining({ _tag: "Fail", error: "failure-3" })
      )
    }))

  effect(
    "a nonRetryable-tagged error short-circuits to the original failure on attempt 1",
    () =>
      Effect.gen(function*() {
        let attempts = 0
        const before = yield* Clock.currentTimeMillis
        const action = Action.make({
          name: "RetryPolicy/nonRetryable",
          success: Schema.Void,
          error: Fatal,
          retryPolicy: RetryPolicy.make({
            initialMs: 100,
            factor: 2,
            maxMs: 1000,
            nonRetryable: ["RetryPolicy/Fatal"]
          }),
          execute: Effect.suspend(() => {
            attempts++
            return Effect.fail(new Fatal())
          })
        })
        const exit = yield* action.pipe(Effect.exit)
        expect(attempts).toBe(1)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* Clock.currentTimeMillis).toBe(before)
      })
  )

  effect("without a retryPolicy a failing action is not retried", () =>
    Effect.gen(function*() {
      let attempts = 0
      const action = Action.make({
        name: "RetryPolicy/none",
        success: Schema.Void,
        error: Flaky,
        execute: Effect.suspend(() => {
          attempts++
          return Effect.fail(new Flaky())
        })
      })
      const exit = yield* action.pipe(Effect.exit)
      expect(attempts).toBe(1)
      expect(Exit.isFailure(exit)).toBe(true)
    }))
})

describe("restart resume", () => {
  // Simulates the durable resume path: attempts 1..2 run and fail under one
  // engine, the process "dies", and a FRESH engine (fresh fiber-local state
  // over the shared attempt log) resumes at the persisted attempt count + 1.
  // The backoff before the next attempt must be derived from that persisted
  // count, not reset to initialMs.
  it.effect("resumes at attempt N+1 with policy backoff derived from the persisted attempt count", () =>
    Effect.gen(function*() {
      // Shared "durable store": the attempt numbers each engine executed.
      const attemptLog: Array<{ attempt: number; at: number }> = []
      const policy = RetryPolicy.make({ initialMs: 100, factor: 2, maxMs: 10000 })
      const action = Action.make({
        name: "RetryPolicy/restart",
        success: Schema.Number,
        error: Flaky,
        retryPolicy: policy,
        execute: Effect.gen(function*() {
          const attempt = yield* Action.CurrentAttempt
          const at = yield* Clock.currentTimeMillis
          attemptLog.push({ attempt, at })
          return attemptLog.length >= 4 ? attempt : yield* Effect.fail(new Flaky())
        })
      })

      const runIn = <A, E>(
        body: Effect.Effect<
          A,
          E,
          Scope.Scope | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance | Crypto.Crypto
        >
      ) =>
        withCrypto(
          body.pipe(
            Effect.provide(FlowEngine.layerMemory),
            Effect.provideService(
              FlowRuntime.FlowInstance,
              FlowEngine.makeInstance(flow, "retry-policy-restart")
            ),
            Effect.provide(TestClock.layer()),
            Effect.scoped
          )
        )

      // Engine A: attempts 1 and 2 fail, then the process dies mid-backoff.
      yield* runIn(Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        const fiber = yield* engine.actionExecute(action, 1).pipe(
          Effect.forkChild
        )
        yield* Effect.yieldNow
        yield* TestClock.adjust(100)
        yield* Fiber.interrupt(fiber)
      }))
      expect(attemptLog.map(({ attempt }) => attempt)).toEqual([1, 2])

      // Engine B: a fresh engine resumes from the persisted attempt count.
      const persisted = attemptLog[attemptLog.length - 1]!.attempt
      yield* runIn(Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        const fiber = yield* engine
          .actionExecute(action, persisted + 1)
          .pipe(Effect.forkChild)
        yield* Effect.yieldNow
        // Attempt 3 runs immediately and fails; the delay before attempt 4
        // must be nextDelay(policy, 3) = 400ms — not reset to initialMs.
        yield* TestClock.adjust(399)
        expect(attemptLog.length).toBe(3)
        yield* TestClock.adjust(1)
        const result = yield* Fiber.join(fiber)
        expect(result._tag).toBe("Complete")
      }))
      expect(attemptLog.map(({ attempt }) => attempt)).toEqual([1, 2, 3, 4])
      // Engine B's clock: attempt 3 at t=0, attempt 4 exactly 400ms later.
      expect(attemptLog[3]!.at - attemptLog[2]!.at).toBe(400)
    }))
})
