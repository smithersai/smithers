import { expect } from "@effect/vitest"
import { DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Deferred, Effect, Exit, Option, Schema } from "effect"
import { FlowEngine } from "../src/index.ts"
import { effect, pollUntil } from "./Harness.ts"

effect("a completion that lands on a live child round re-drives the child once the round parks", () => {
  const child = Flow.make("live-child-wake/child", { payload: {}, success: Schema.Number, body: () => Node.succeed(0) })
  const parent = Flow.make("live-child-wake/parent", {
    payload: {},
    success: Schema.Number,
    body: () => Node.succeed(0)
  })
  const gate = DurableDeferred.make("live-child-wake/gate", { success: Schema.Number })
  return Effect.scoped(Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    const release = yield* Deferred.make<number>()
    let childRounds = 0
    yield* engine.register(child, () =>
      Effect.suspend(() => {
        childRounds++
        // The sibling action keeps the round live; the deferred branch waits
        // for it before it parks, without re-reading the completion.
        return Effect.all([
          Flow.wrapActionResult(Deferred.await(release), () => false),
          DurableDeferred.await(gate)
        ], { concurrency: "unbounded" }).pipe(Effect.map(([sibling, value]) => sibling + value))
      }))
    yield* engine.register(parent, () => Effect.orDie(child.execute({}, { executionId: "live-child" })))
    yield* engine.execute(parent, { executionId: "live-parent", payload: {}, discard: true })
    for (let turn = 0; turn < 50; turn++) yield* Effect.yieldNow
    expect(childRounds).toBe(1)
    yield* DurableDeferred.succeed(gate, {
      token: DurableDeferred.tokenFromExecutionId(gate, { flow: child, executionId: "live-child" }),
      value: 6
    })
    yield* Deferred.succeed(release, 1)
    const done = yield* pollUntil(parent.poll("live-parent"), (result) => result._tag === "Complete", { turns: 200 })
    expect(
      Option.isSome(done) && done.value._tag === "Complete" && Exit.isSuccess(done.value.exit) &&
        done.value.exit.value
    )
      .toBe(7)
    expect(childRounds).toBe(2)
  })).pipe(Effect.provide(FlowEngine.layerMemory))
})
