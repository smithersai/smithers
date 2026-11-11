/**
 * Issue #4628: an execution rechecks the registration of every callee it
 * reaches. That recheck must not grow the host registration scope: a
 * long-lived host drives the same flow without bound.
 */
import { expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema, Scope } from "effect"
import { withCrypto } from "./Crypto.ts"
import { layerWired } from "./MemoryFlowRuntime.ts"

const Bump = Action.make("registration-scope/bump", {
  payload: { value: Schema.Number },
  success: Schema.Number
})

const Child = Flow.make("registration-scope/child", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: ({ value }) => Bump.call({ value })
})

const Parent = Flow.make("registration-scope/parent", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: ({ value }) => Child.child({ value })
})

/** The finalizers a scope holds while it is open. */
const finalizerCount = (scope: Scope.Scope): number =>
  scope.state._tag !== "Open" ? 0 : scope.state.finalizers?.size ?? (scope.state.finalizer === undefined ? 0 : 1)

it.effect("keeps the host registration scope constant across repeated drives of a .child() caller", () =>
  Effect.gen(function*() {
    let host: Scope.Scope | undefined
    // Capture the scope the host registration runs in: reachable callees
    // register into this same scope.
    const observed = Layer.effect(FlowRuntime.FlowRuntime)(Effect.gen(function*() {
      const runtime = yield* FlowRuntime.FlowRuntime
      return {
        ...runtime,
        register: (flow, execute, options) =>
          Effect.gen(function*() {
            if (flow._tag === Parent._tag) host = yield* Effect.scope
            yield* runtime.register(flow, execute, options)
          })
      } satisfies typeof runtime
    }))
    const registration = Interpreter.layer(Parent).pipe(Layer.provide(observed))
    const layer = layerWired(Layer.merge(Bump.toLayer(({ value }) => Effect.succeed(value + 1)), registration))

    const counts = yield* withCrypto(
      Effect.gen(function*() {
        const drive = (index: number) =>
          Parent.execute({ value: index }, { executionId: `registration-scope-${index}` })
        expect(yield* drive(0)).toBe(1)
        const afterFirst = finalizerCount(host!)
        for (let index = 1; index <= 1_000; index++) yield* drive(index)
        return { afterFirst, afterMany: finalizerCount(host!) }
      }).pipe(Effect.provide(layer))
    )

    expect(counts.afterMany).toBe(counts.afterFirst)
  }))
