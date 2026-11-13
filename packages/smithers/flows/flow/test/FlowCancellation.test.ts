import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { withCrypto } from "./Crypto.ts"
import { layerMemory, makeInstance } from "./MemoryFlowRuntime.ts"

const TestFlow = Flow.make("Cancellation/test", {
  payload: {},
  body: () => Node.succeed(undefined)
})

const failure = new FlowRuntime.CancelRequestFailed({
  code: "cancel_request_failed",
  executionId: "cancellation-1",
  reason: "journal unavailable"
})

const layerFailingCancellation = Layer.effect(
  FlowRuntime.FlowRuntime,
  Effect.map(FlowRuntime.FlowRuntime, (runtime) =>
    FlowRuntime.FlowRuntime.of({
      ...runtime,
      interrupt: () => Effect.fail(failure)
    }))
).pipe(Layer.provide(layerMemory))

describe("Flow cancellation failures", () => {
  it.effect("Flow.interrupt forwards CancelRequestFailed unchanged", () =>
    Effect.gen(function*() {
      const observed = yield* withCrypto(
        Effect.flip(TestFlow.interrupt("cancellation-1")).pipe(Effect.provide(layerFailingCancellation))
      )

      expect(observed).toBe(failure)
      expect(observed).toMatchObject({
        _tag: "@smthrs/flow/CancelRequestFailed",
        code: "cancel_request_failed",
        executionId: "cancellation-1",
        reason: "journal unavailable"
      })
    }))
})

for (const kind of ["flow", "action"] as const) {
  for (const channel of ["failure", "defect"] as const) {
    it.effect(`${kind} cancellation retains a child's cleanup ${channel}`, () =>
      Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const cleanup = channel === "failure" ? Effect.fail("cleanup") : Effect.die("cleanup")
        const body = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onExit(() => cleanup)
        )
        const execution = kind === "flow" ? Flow.intoResult(body) : Action.make({
          name: "Cancellation/encoded-cleanup",
          success: Schema.Void,
          error: Schema.String,
          execute: body
        }).executeEncoded
        const fiber = yield* execution.pipe(
          Effect.provideService(FlowRuntime.FlowInstance, makeInstance(TestFlow, `cleanup-${kind}-${channel}`)),
          Effect.forkChild
        )
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(exit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect)).toContain("cleanup")
          expect(exit.cause.reasons.some(Cause.isFailReason)).toBe(false)
        }
      }).pipe(Effect.scoped, Effect.provide(layerMemory), withCrypto))
  }
}

it.effect("cancellation tolerates a child completing before the interrupt reaches it", () =>
  Effect.gen(function*() {
    const parent = yield* Deferred.make<Fiber.Fiber<unknown, unknown>>()
    const body = Effect.flatMap(Deferred.await(parent), (fiber) =>
      Effect.sync(() => {
        fiber.interruptUnsafe()
        return "finished"
      }))
    const fiber = yield* Flow.intoResult(body).pipe(
      Effect.provideService(FlowRuntime.FlowInstance, makeInstance(TestFlow, "cleanup-completed-child")),
      Effect.forkChild
    )
    yield* Deferred.succeed(parent, fiber)
    const exit = yield* Fiber.await(fiber)
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  }).pipe(Effect.scoped))

it.effect("a flow keeps typed cleanup when its body returns a mixed interruption cause", () =>
  Effect.gen(function*() {
    const exit = yield* Flow.intoResult(
      Effect.failCause(Cause.combine(Cause.interrupt(1), Cause.fail("cleanup")))
    ).pipe(
      Effect.provideService(FlowRuntime.FlowInstance, makeInstance(TestFlow, "cleanup-mixed")),
      Effect.exit
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect)).toContain("cleanup")
      expect(exit.cause.reasons.some(Cause.isFailReason)).toBe(false)
    }
  }))
