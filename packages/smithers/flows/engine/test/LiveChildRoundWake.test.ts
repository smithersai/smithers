import { expect } from "@effect/vitest"
import { DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Deferred, Effect, Exit, Option, Schema } from "effect"
import { FlowEngine } from "../src/index.ts"
import { effect, pollUntil } from "./Harness.ts"

effect("a completion that lands after a live child reads its wait re-drives the child once it parks", () => {
  const child = Flow.make("live-child-wake/child", { payload: {}, success: Schema.Number, body: () => Node.succeed(0) })
  const parent = Flow.make("live-child-wake/parent", {
    payload: {},
    success: Schema.Number,
    body: () => Node.succeed(0)
  })
  const gate = DurableDeferred.make("live-child-wake/gate", { success: Schema.Number })
  return Effect.scoped(Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    const readMissing = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    let childRounds = 0
    yield* engine.register(child, () =>
      Effect.gen(function*() {
        childRounds++
        const instance = yield* FlowRuntime.FlowInstance
        const result = yield* engine.deferredResult(gate)
        if (Option.isSome(result)) return (yield* result.value) + 1
        // Hold the real child after its missing read and before it parks.
        // Completing the deferred at this point must survive that stale read;
        // the child has no polling follower to recover a lost wake.
        yield* Deferred.succeed(readMissing, undefined)
        yield* Deferred.await(release)
        return yield* Flow.suspend(instance)
      }))
    yield* engine.register(parent, () => Effect.orDie(child.execute({}, { executionId: "live-child" })))
    yield* engine.execute(parent, { executionId: "live-parent", payload: {}, discard: true })
    yield* Deferred.await(readMissing)
    expect(childRounds).toBe(1)
    yield* DurableDeferred.succeed(gate, {
      token: DurableDeferred.tokenFromExecutionId(gate, { flow: child, executionId: "live-child" }),
      value: 6
    })
    yield* Deferred.succeed(release, undefined)
    const done = yield* pollUntil(parent.poll("live-parent"), (result) => result._tag === "Complete", { turns: 200 })
    expect(
      Option.isSome(done) && done.value._tag === "Complete" && Exit.isSuccess(done.value.exit) &&
        done.value.exit.value
    )
      .toBe(7)
    expect(childRounds).toBe(2)
  })).pipe(Effect.provide(FlowEngine.layerMemory))
})
