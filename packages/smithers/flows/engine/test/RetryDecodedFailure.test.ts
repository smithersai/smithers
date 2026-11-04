import { expect } from "@effect/vitest"
import { Action, Flow, FlowRuntime, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Context, Effect, Exit, Option, Schema, SchemaGetter } from "effect"
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

const storeFailure = { _tag: "StoreUnavailable", code: "store_unavailable" }
for (const originalDefect of [false, true]) {
  liveEffect(`engine failures preserve retry eligibility from their original channel: defect=${originalDefect}`, () => {
    const action = Action.make({
      name: "RetryDecodedFailure/engine-error",
      success: Schema.String,
      retryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1, maxAttempts: 2 }),
      execute: Effect.succeed("unused")
    })
    let attempts = 0
    const engine = scriptedEngine({
      encodeEngineError: (error) => error === storeFailure ? Option.some(storeFailure) : Option.none(),
      actionExecute: () =>
        Effect.sync(() => {
          attempts++
          return new Flow.Complete({ exit: originalDefect ? Exit.die(storeFailure) : Exit.fail(storeFailure) })
        })
    })
    return Effect.gen(function*() {
      const result = yield* engine.actionExecute(action, 1)
      expect(attempts).toBe(originalDefect ? 1 : 2)
      expect(result._tag === "Complete" && Exit.isFailure(result.exit) && result.exit.cause.reasons)
        .toEqual([expect.objectContaining({ _tag: "Die", defect: storeFailure })])
    }).pipe(Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(flow, "engine-failure")))
  })
}

liveEffect("an engine-error recognizer leaves an unrecognized business error in its declared channel", () => {
  const action = Action.make({
    name: "RetryDecodedFailure/unrecognized",
    error: Schema.String,
    execute: Effect.fail("declared")
  })
  const recognized: unknown[] = []
  const engine = scriptedEngine({
    encodeEngineError: (error) => {
      recognized.push(error)
      return Option.none()
    },
    actionExecute: () => Effect.succeed(new Flow.Complete({ exit: Exit.fail("declared") }))
  })
  return Effect.gen(function*() {
    const result = yield* engine.actionExecute(action, 1)
    expect(result._tag).toBe("Complete")
    expect(result._tag === "Complete" && Exit.isFailure(result.exit) && result.exit.cause.reasons)
      .toEqual([expect.objectContaining({ _tag: "Fail", error: "declared" })])
    if (result._tag === "Complete" && Exit.isFailure(result.exit)) {
      expect(Context.getOrUndefined(Cause.reasonAnnotations(result.exit.cause.reasons[0]!), FlowEngine.FailureSite))
        .toEqual({ executionId: "unrecognized", action: action.name, attempts: 1 })
    }
    expect(recognized).toEqual(["declared"])
  }).pipe(Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(flow, "unrecognized")))
})
