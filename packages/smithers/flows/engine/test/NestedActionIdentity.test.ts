import { expect } from "@effect/vitest"
import { Action, DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Exit, Option, Schema } from "effect"
import { FlowEngine } from "../src/index.ts"
import { layerDurable, makeLog } from "./DurableLogEngine.ts"
import { effect, pollUntil } from "./Harness.ts"

effect("distinct parent action invocations cannot replay each other's nested action", () => {
  const flow = Flow.make("NestedActionIdentity/flow", {
    payload: {},
    success: Schema.Array(Schema.Number),
    body: () => Node.succeed([])
  })
  let calls = 0
  const inner = Action.make({
    name: "NestedActionIdentity/inner",
    success: Schema.Number,
    execute: Effect.sync(() => ++calls)
  })
  const outer = Action.make({
    name: "NestedActionIdentity/outer",
    success: Schema.Number,
    execute: inner
  })
  return Effect.scoped(Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    yield* engine.register(flow, () =>
      Effect.gen(function*() {
        return [yield* outer, yield* outer]
      }))
    expect(yield* flow.execute({}, { executionId: "nested" })).toEqual([1, 2])
    expect(calls).toBe(2)
    expect(yield* flow.execute({}, { executionId: "nested" })).toEqual([1, 2])
    expect(calls).toBe(2)
  })).pipe(Effect.provide(FlowEngine.layerMemory))
})

effect("nested invocation keys replay consistently after a suspended engine restart", () => {
  const flow = Flow.make("NestedActionIdentity/restart", {
    payload: {},
    success: Schema.Array(Schema.Number),
    body: () => Node.succeed([])
  })
  const gate = DurableDeferred.make("NestedActionIdentity/gate")
  const log = makeLog()
  let calls = 0
  const inner = Action.make({
    name: "NestedActionIdentity/restart-inner",
    success: Schema.Number,
    execute: Effect.sync(() => ++calls)
  })
  const outer = Action.make({ name: "NestedActionIdentity/restart-outer", success: Schema.Number, execute: inner })
  const body = () =>
    Effect.gen(function*() {
      const values = [yield* outer, yield* outer]
      yield* DurableDeferred.await(gate)
      return values
    })
  return Effect.gen(function*() {
    yield* Effect.scoped(Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      yield* engine.register(flow, body)
      yield* flow.execute({}, { executionId: "restart", discard: true })
      const parked = yield* pollUntil(flow.poll("restart"), (result) => result._tag === "Suspended", { turns: 100 })
      expect(Option.isSome(parked) && parked.value._tag).toBe("Suspended")
      expect(calls).toBe(2)
    })).pipe(Effect.provide(layerDurable(log)))
    log.deferreds.set(JSON.stringify([flow._tag, "restart", gate.name]), Exit.void)
    yield* Effect.scoped(Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      yield* engine.register(flow, body)
      expect(yield* flow.execute({}, { executionId: "restart" })).toEqual([1, 2])
      expect(calls).toBe(2)
    })).pipe(Effect.provide(layerDurable(log)))
  })
})

effect("nested keyed sealed actions still share their explicitly declared cache identity", () => {
  const flow = Flow.make("NestedActionIdentity/keyed", {
    payload: {},
    success: Schema.Array(Schema.Number),
    body: () => Node.succeed([])
  })
  let calls = 0
  const inner = Action.make({
    name: "NestedActionIdentity/keyed-inner",
    success: Schema.Number,
    idempotencyKey: "shared",
    execute: Effect.sync(() => ++calls)
  })
  const outer = Action.make({ name: "NestedActionIdentity/keyed-outer", success: Schema.Number, execute: inner })
  return Effect.scoped(Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    yield* engine.register(flow, () =>
      Effect.gen(function*() {
        return [yield* outer, yield* outer]
      }))
    expect(yield* flow.execute({}, { executionId: "keyed" })).toEqual([1, 1])
    expect(calls).toBe(1)
  })).pipe(Effect.provide(FlowEngine.layerMemory))
})

effect("a child execution resumed independently keeps its original action keys", () => {
  const child = Flow.make("NestedActionIdentity/child", {
    payload: {},
    success: Schema.Number,
    body: () => Node.succeed(0)
  })
  const parent = Flow.make("NestedActionIdentity/parent", {
    payload: {},
    success: Schema.Number,
    body: () => Node.succeed(0)
  })
  const gate = DurableDeferred.make("NestedActionIdentity/child-gate")
  const log = makeLog()
  let calls = 0
  const step = Action.make({
    name: "NestedActionIdentity/child-step",
    success: Schema.Number,
    execute: Effect.sync(() => ++calls)
  })
  const invokeChild = Action.make({
    name: "NestedActionIdentity/invoke-child",
    success: Schema.Number,
    execute: child.execute({}, { executionId: "independent-child" }).pipe(Effect.orDie)
  })
  const childBody = () =>
    Effect.gen(function*() {
      const result = yield* step
      yield* DurableDeferred.await(gate)
      return result
    })
  return Effect.gen(function*() {
    yield* Effect.scoped(Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      yield* engine.register(child, childBody)
      yield* engine.register(parent, () => invokeChild)
      yield* parent.execute({}, { executionId: "parent", discard: true })
      const parked = yield* pollUntil(parent.poll("parent"), (result) => result._tag === "Suspended", { turns: 100 })
      expect(Option.isSome(parked) && parked.value._tag).toBe("Suspended")
      expect(calls).toBe(1)
    })).pipe(Effect.provide(layerDurable(log)))
    log.deferreds.set(JSON.stringify([child._tag, "independent-child", gate.name]), Exit.void)
    yield* Effect.scoped(Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      yield* engine.register(child, childBody)
      expect(yield* child.execute({}, { executionId: "independent-child" })).toBe(1)
      expect(calls).toBe(1)
    })).pipe(Effect.provide(layerDurable(log)))
  })
})
