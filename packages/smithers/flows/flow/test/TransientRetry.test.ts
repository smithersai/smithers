import { describe, expect, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Action, Fault, Flow, FlowRuntime, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Clock, Context, Effect, Exit, Fiber, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { withCrypto } from "./Crypto.ts"

class Outage extends Schema.TaggedError<Outage>()("test/TransientOutage", { attempt: Schema.Number }) {}
Fault.register("test/TransientOutage", "infra")

const RetryHost = Flow.make("TransientRetry/host", { payload: {}, body: () => Node.succeed(undefined) })
const retry = <A, E, R>(operation: Effect.Effect<A, E, R>, name = "operation") =>
  Fault.retryTransient(operation, {
    name: `TransientRetry/${name}`,
    idempotencyKey: "operation",
    success: Schema.Unknown,
    error: Schema.Union([Outage, Schema.Unknown])
  })
const provideRuntime = <A, E>(
  operation: Effect.Effect<
    A,
    E,
    FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime | import("@smthrs/crypto").Crypto.Crypto
  >
) =>
  withCrypto(operation.pipe(
    Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(RetryHost, "transient")),
    Effect.provide(FlowEngine.layerMemory)
  ))

const finalError = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit)
    ? exit.cause.reasons.find((reason) => reason._tag === "Fail") :
    undefined

describe("bounded transient retries", () => {
  it("publishes the frozen two-hour exponential envelope", () => {
    expect(Object.isFrozen(RetryPolicy.transient)).toBe(true)
    expect(RetryPolicy.transient).toMatchObject({ initialMs: 5000, factor: 2, maxMs: 300000, expirationMs: 7200000 })
    for (const [attempt, delay] of [[1, 5000], [2, 10000], [3, 20000], [7, 300000], [100, 300000]]) {
      expect(RetryPolicy.nextDelay(RetryPolicy.transient, attempt!)).toEqual(Option.some(delay))
    }
  })

  it.effect("retries infrastructure failures at 5, 10 and 20 seconds before succeeding", () =>
    Effect.gen(function*() {
      const times: number[] = []
      const operation = Effect.gen(function*() {
        times.push(yield* Clock.currentTimeMillis)
        return times.length === 4 ? "recovered" : yield* Effect.fail(new Outage({ attempt: times.length }))
      })
      const fiber = yield* retry(operation).pipe(Effect.forkChild)
      yield* TestClock.adjust(34999)
      expect(times).toEqual([0, 5000, 15000])
      yield* TestClock.adjust(1)
      expect(yield* Fiber.join(fiber)).toBe("recovered")
      expect(times).toEqual([0, 5000, 15000, 35000])
    }).pipe(provideRuntime, Effect.provide(TestClock.layer())))

  it.effect("stops immediately when recovery yields a non-infrastructure failure", () =>
    Effect.gen(function*() {
      let attempts = 0
      const operation = Effect.suspend<never, string | Outage, never>(() =>
        ++attempts === 1
          ? Effect.fail(new Outage({ attempt: attempts })) :
          Effect.fail("invalid work")
      )
      const fiber = yield* retry(operation).pipe(Effect.exit, Effect.forkChild)
      yield* TestClock.adjust(5000)
      const exit = yield* Fiber.join(fiber)
      expect(attempts).toBe(2)
      expect(finalError(exit)).toEqual(expect.objectContaining({ _tag: "Fail", error: "invalid work" }))
    }).pipe(provideRuntime, Effect.provide(TestClock.layer())))

  it.effect("preserves the final infrastructure error when the two-hour budget expires", () =>
    Effect.gen(function*() {
      const times: number[] = []
      let last: Outage | undefined
      const fiber = yield* retry(Effect.gen(function*() {
        times.push(yield* Clock.currentTimeMillis)
        last = new Outage({ attempt: times.length })
        return yield* Effect.fail(last)
      })).pipe(Effect.exit, Effect.forkChild)
      yield* TestClock.adjust(7200000)
      const reason = finalError(yield* Fiber.join(fiber))
      expect(times.length).toBeGreaterThan(20)
      expect(times.every((at) => at <= 7200000)).toBe(true)
      expect(times.at(-1)).toBe(7200000)
      expect(reason?._tag === "Fail" && reason.error).toEqual(last)
      expect(Fault.of(reason?._tag === "Fail" ? reason.error : undefined).class).toBe("infra")
    }).pipe(provideRuntime, Effect.provide(TestClock.layer())))

  it.effect("never retries an initial unregistered failure or a defect", () =>
    Effect.gen(function*() {
      const failure = { _tag: "test/Unregistered", message: "invalid work" }
      let attempts = 0
      const exit = yield* retry(Effect.suspend(() => {
        attempts++
        return Effect.fail(failure)
      })).pipe(Effect.exit)
      expect(attempts).toBe(1)
      const reason = finalError(exit)
      expect(reason?._tag === "Fail" && reason.error).toBe(failure)
      const defect = new Error("broken invariant")
      const defectExit = yield* retry(
        Effect.suspend(() => {
          attempts++
          return Effect.die(defect)
        }),
        "defect"
      ).pipe(Effect.exit)
      expect(attempts).toBe(2)
      expect(Exit.isFailure(defectExit) && defectExit.cause.reasons).toContainEqual(
        expect.objectContaining({ _tag: "Die", defect })
      )
      expect(yield* Clock.currentTimeMillis).toBe(0)
    }).pipe(provideRuntime, Effect.provide(TestClock.layer())))

  it.effect("cancellation prevents every later retry", () =>
    Effect.gen(function*() {
      let attempts = 0
      const fiber = yield* retry(Effect.suspend(() => {
        attempts++
        return Effect.fail(new Outage({ attempt: attempts }))
      })).pipe(Effect.forkChild)
      yield* TestClock.adjust(4999)
      yield* Fiber.interrupt(fiber)
      yield* TestClock.adjust(7200000)
      expect(attempts).toBe(1)
    }).pipe(provideRuntime, Effect.provide(TestClock.layer())))
})

it.effect("replays recorded transient attempts without executing them again", () =>
  withCrypto(
    Effect.gen(function*() {
      const attempts: number[] = []
      const attemptNumbers: number[] = []
      const Status = Context.Service<{ readonly read: Effect.Effect<string, Outage> }>("TransientRetry/Status")
      const faultyStatus = {
        read: Effect.gen(function*() {
          attempts.push(yield* Clock.currentTimeMillis)
          const attempt = yield* Action.CurrentAttempt
          attemptNumbers.push(attempt)
          return attempts.length >= 4 ? "recovered" : yield* Effect.fail(new Outage({ attempt }))
        })
      }
      const operation = Effect.flatMap(Status, (status) => status.read).pipe(
        Effect.provideService(Status, faultyStatus)
      )
      const replay = () =>
        Fault.retryTransient(operation, {
          name: "TransientRetry/recorded",
          idempotencyKey: "status",
          success: Schema.String,
          error: Outage
        }).pipe(Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(RetryHost, "replayed")))
      const first = yield* replay().pipe(Effect.forkChild)
      yield* TestClock.adjust(35000)
      expect(yield* Fiber.join(first)).toBe("recovered")
      expect(attempts).toEqual([0, 5000, 15000, 35000])
      expect(attemptNumbers).toEqual([1, 2, 3, 4])
      const second = yield* replay().pipe(Effect.forkChild)
      yield* TestClock.adjust(35000)
      expect(yield* Fiber.join(second)).toBe("recovered")
      expect(attempts).toEqual([0, 5000, 15000, 35000])
    }).pipe(Effect.provide(FlowEngine.layerMemory), Effect.provide(TestClock.layer()))
  ))
