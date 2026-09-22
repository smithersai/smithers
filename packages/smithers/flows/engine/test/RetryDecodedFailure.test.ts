import { expect } from "@effect/vitest"
import { Action, Flow, FlowRuntime, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Exit, Schema, SchemaGetter } from "effect"
import { FlowEngine } from "../src/index.ts"
import { liveEffect } from "./Harness.ts"
import { scriptedEngine } from "./ScriptedEngine.ts"

const flow = Flow.make("RetryDecodedFailure/flow", {
  payload: {},
  success: Schema.Void,
  body: () => Node.succeed(undefined)
})
const policy = RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 2, nonRetryable: ["Denied"] })
const errorSchema = Schema.Struct({ wire: Schema.Literal("denied") }).pipe(Schema.decodeTo(
  Schema.Struct({ _tag: Schema.Literal("Denied") }),
  {
    decode: SchemaGetter.transform(() => ({ _tag: "Denied" as const })),
    encode: SchemaGetter.transform(() => ({ wire: "denied" as const }))
  }
))

liveEffect("classifies non-retryable errors using their decoded declaration", () => {
  const action = Action.make({
    name: "RetryDecodedFailure/transformed",
    error: errorSchema,
    retryPolicy: policy,
    execute: Effect.fail({ _tag: "Denied" as const })
  })
  let attempts = 0
  const engine = scriptedEngine({
    actionExecute: () =>
      Effect.sync(() => {
        attempts++
        return new Flow.Complete({ exit: Exit.fail({ wire: "denied" }) })
      })
  })
  return Effect.gen(function*() {
    const result = yield* engine.actionExecute(action, 1)
    expect(result._tag).toBe("Complete")
    expect(result._tag === "Complete" && Exit.isFailure(result.exit) && Cause.squash(result.exit.cause))
      .toEqual({ _tag: "Denied" })
    expect(attempts).toBe(1)
  }).pipe(Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(flow, "decoded")))
})

liveEffect("refuses a corrupt recorded failure before dispatching another attempt", () => {
  const action = Action.make({
    name: "RetryDecodedFailure/corrupt",
    error: Schema.String,
    retryPolicy: policy,
    execute: Effect.fail("declared")
  })
  let attempts = 0
  const engine = scriptedEngine({
    actionExecute: () =>
      Effect.sync(() => {
        attempts++
        return new Flow.Complete({ exit: Exit.fail(123) })
      })
  })
  return Effect.gen(function*() {
    const exit = yield* Effect.exit(engine.actionExecute(action, 1))
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    expect(attempts).toBe(1)
  }).pipe(Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(flow, "corrupt")))
})

for (const extra of [Cause.die("broken"), Cause.interrupt(123)]) {
  liveEffect(`does not retry a declared failure combined with ${extra.reasons[0]!._tag}`, () => {
    const action = Action.make({
      name: "RetryDecodedFailure/mixed",
      error: Schema.String,
      retryPolicy: policy,
      execute: Effect.fail("declared")
    })
    let attempts = 0
    const engine = scriptedEngine({
      actionExecute: () =>
        Effect.sync(() => {
          attempts++
          return new Flow.Complete({ exit: Exit.failCause(Cause.combine(Cause.fail("declared"), extra)) })
        })
    })
    return Effect.gen(function*() {
      const result = yield* engine.actionExecute(action, 1)
      expect(result._tag === "Complete" && Exit.isFailure(result.exit) && result.exit.cause.reasons).toHaveLength(2)
      expect(attempts).toBe(1)
    }).pipe(Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(flow, "mixed")))
  })
}

liveEffect("does not invent a retryable error for a recorded empty cause", () => {
  const action = Action.make({
    name: "RetryDecodedFailure/empty",
    error: Schema.String,
    retryPolicy: policy,
    execute: Effect.fail("declared")
  })
  let attempts = 0
  const engine = scriptedEngine({
    actionExecute: () =>
      Effect.sync(() => {
        attempts++
        return new Flow.Complete({ exit: Exit.failCause(Cause.empty) })
      })
  })
  return Effect.gen(function*() {
    const result = yield* engine.actionExecute(action, 1)
    expect(result._tag === "Complete" && Exit.isFailure(result.exit) && result.exit.cause.reasons).toHaveLength(0)
    expect(attempts).toBe(1)
  }).pipe(Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(flow, "empty")))
})
