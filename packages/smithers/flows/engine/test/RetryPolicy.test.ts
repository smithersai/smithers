import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Clock, type Duration, Effect, Exit, Fiber, Layer, Option, Random, Schema } from "effect"
import type * as EffectDigest from "effect/crypto/Digest"
import type * as SecureRandom from "effect/crypto/SecureRandom"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"
import { scriptedEngine } from "./ScriptedEngine.ts"

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

describe("a failure's own Retry-After", () => {
  it.effect("the engine waits retryAfterMillis, not the policy's backoff, before the next attempt", () =>
    Effect.gen(function*() {
      // A provider error class with the field `@smthrs/model`'s `ModelError`
      // and `@smthrs/effect-code-storage`'s `CodeStorageError` carry.
      class RateLimited extends Schema.TaggedError<RateLimited>()("RetryPolicy/RateLimited", {
        retryAfterMillis: Schema.Number
      }) {}
      const startedAt: Array<number> = []
      const action = Action.make({
        name: "RetryPolicy/rate-limited",
        success: Schema.Number,
        error: RateLimited,
        retryPolicy: RetryPolicy.make({ initialMs: 10, factor: 1, maxMs: 60_000, maxAttempts: 2 }),
        execute: Effect.gen(function*() {
          startedAt.push(yield* Clock.currentTimeMillis)
          return startedAt.length === 1 ? yield* new RateLimited({ retryAfterMillis: 7_000 }) : 1
        })
      })
      const flow = Flow.make("RetryPolicy/rate-limited-flow", {
        payload: {},
        success: Schema.Number,
        body: () => Node.succeed(0)
      })
      const exit = yield* withCrypto(
        Effect.gen(function*() {
          const engine = yield* FlowRuntime.FlowRuntime
          const fiber = yield* engine.actionExecute(action, 1).pipe(Effect.forkChild)
          yield* Effect.yieldNow
          // The policy alone would retry after 10 ms.
          yield* TestClock.adjust(6_999)
          expect(startedAt).toEqual([0])
          yield* TestClock.adjust(1)
          const result = yield* Fiber.join(fiber)
          return result._tag === "Complete" ? result.exit : Exit.succeed("suspended" as never)
        }).pipe(
          Effect.provide(FlowEngine.layerMemory),
          Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(flow, "retry-after")),
          Effect.provide(TestClock.layer()),
          Effect.scoped
        )
      )
      expect(exit).toEqual(Exit.succeed(1))
      expect(startedAt).toEqual([0, 7_000])
    }))
})

describe("flow suspension policy", () => {
  // A flow whose action parks with `Flow.suspend` on its first attempt and
  // succeeds on its second, run on the memory engine under a 17ms policy.
  const suspendsOnce = (name: string, deadline?: Duration.Input) => {
    const policy = RetryPolicy.make({ initialMs: 17, factor: 1, maxMs: 17 })
    const suspendedActionDeclaration = Action.make(`${name}/action`, {
      payload: {},
      success: Schema.Void
    })
    const suspended = Flow.make(name, {
      payload: {},
      success: Schema.Void,
      suspendedRetryPolicy: policy,
      deadline,
      body: (payload) => suspendedActionDeclaration.call(payload)
    }).annotate(Flow.CaptureDefects, true)
    const counter = { attempts: 0 }
    const layer = Layer.mergeAll(
      suspendedActionDeclaration.toLayer(() =>
        Effect.gen(function*() {
          counter.attempts++
          if (counter.attempts === 1) {
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
    // The declaration's policy is what the engine schedules the resume with:
    // the suspended round is still waiting one millisecond before the 17ms
    // delay and runs its second attempt on the millisecond that reaches it.
    const run = withCrypto(
      Effect.gen(function*() {
        const fiber = yield* suspended.execute({}, { executionId: "suspended-policy" }).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* TestClock.adjust(16)
        expect(counter.attempts).toBe(1)
        yield* TestClock.adjust(1)
        for (let turn = 0; turn < 200 && fiber.pollUnsafe() === undefined; turn++) yield* Effect.yieldNow
        expect(counter.attempts).toBe(2)
        yield* Fiber.join(fiber)
      }).pipe(
        Effect.provide(layer),
        Effect.provide(TestClock.layer())
      )
    )
    return { policy, suspended, run }
  }

  it.effect("preserves the policy through annotations and forwards it to execution", () => {
    const { policy, run, suspended } = suspendsOnce("RetryPolicy/suspended")
    expect(suspended.suspendedRetryPolicy).toBe(policy)
    return run
  })

  // Issue #4677: the deadline arms a durable clock for the whole run, which
  // the run is not parked on, so the follower's poll still re-drives it.
  it.effect("re-drives a parked run on its policy when the flow declares a deadline", () =>
    suspendsOnce("RetryPolicy/suspended-with-deadline", "1 hour").run)
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
    (EffectDigest.Digest | SecureRandom.SecureRandom) | Scope.Scope | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance
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

describe("durable retry resume", () => {
  it.effect("replays the latest persisted attempt and derives policy backoff from it", () => {
    const attempts: Array<{ attempt: number; at: number }> = []
    const action = Action.make({
      name: "RetryPolicy/resume",
      success: Schema.Number,
      error: Flaky,
      retryPolicy: RetryPolicy.make({ initialMs: 100, factor: 2, maxMs: 10000 }),
      execute: Effect.die("durable fixture dispatches the action")
    })
    const engine = scriptedEngine({
      actionLatestAttempt: () => Effect.succeedSome(3),
      actionRetryOrigin: () => Effect.succeedSome(0),
      actionExecute: (input) =>
        Effect.gen(function*() {
          attempts.push({ attempt: input.attempt, at: yield* Clock.currentTimeMillis })
          return new Flow.Complete({
            exit: input.attempt === 4 ? Exit.succeed(4) : Exit.fail(new Flaky())
          })
        })
    })
    return withCrypto(
      Effect.gen(function*() {
        // The caller starts at 1; the engine must recover attempt 3 from the store.
        const fiber = yield* engine.actionExecute(action, 1).pipe(Effect.forkChild)
        yield* TestClock.adjust(399)
        expect(attempts).toEqual([{ attempt: 3, at: 0 }])
        yield* TestClock.adjust(1)
        const result = yield* Fiber.join(fiber)
        expect(result._tag === "Complete" && result.exit).toEqual(Exit.succeed(4))
        expect(attempts).toEqual([{ attempt: 3, at: 0 }, { attempt: 4, at: 400 }])
      }).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(flow, "retry-policy-resume")),
        Effect.provide(Layer.succeed(FlowRuntime.FlowRuntime)(engine)),
        Effect.provide(TestClock.layer()),
        Effect.scoped
      )
    )
  })
})
