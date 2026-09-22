import { expect } from "@effect/vitest"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Exit, Fiber, Scheduler, Schema } from "effect"
import { FlowEngine } from "../src/index.ts"
import { effect } from "./Harness.ts"

effect("same-key action admission remains single-flight across scheduler yields", () =>
  Effect.gen(function*() {
    for (let budget = 3; budget <= 12; budget++) {
      let calls = 0
      const action = Action.make({
        name: "ActionAdmissionConcurrency/inner",
        success: Schema.Number,
        idempotencyKey: "shared",
        execute: Effect.yieldNow.pipe(Effect.andThen(Effect.sync(() => ++calls)))
      })
      const flow = Flow.make("ActionAdmissionConcurrency/flow", {
        payload: {},
        success: Schema.Array(Schema.Number),
        body: () => Node.succeed([])
      })
      const values = yield* Effect.scoped(Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        yield* engine.register(flow, () => Effect.all([action, action, action], { concurrency: "unbounded" }))
        return yield* flow.execute({}, { executionId: `budget-${budget}` })
      })).pipe(Effect.provide(FlowEngine.layerMemory), Effect.provideService(Scheduler.MaxOpsBeforeYield, budget))
      expect({ budget, values, calls }).toEqual({ budget, values: [1, 1, 1], calls: 1 })
    }
  }))

effect("interruption during same-key admission never leaves an unresolved owner", () =>
  Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    const flow = Flow.make("ActionAdmissionConcurrency/interrupted", {
      payload: {},
      success: Schema.Number,
      body: () => Node.succeed(0)
    })
    for (let budget = 3; budget <= 6; budget++) {
      for (let steps = 0; steps <= 10; steps++) {
        let released = false
        const action = Action.make({
          name: "ActionAdmissionConcurrency/interrupted-action",
          success: Schema.Number,
          idempotencyKey: "shared",
          execute: Effect.suspend(() => released ? Effect.succeed(42) : Effect.never)
        })
        yield* Effect.gen(function*() {
          const owner = yield* engine.actionExecute(action, 1).pipe(Effect.forkChild)
          for (let step = 0; step < steps; step++) yield* Effect.yieldNow
          yield* Fiber.interrupt(owner)
          released = true
          const result = yield* engine.actionExecute(action, 1)
          expect(result._tag === "Complete" && Exit.isSuccess(result.exit) && result.exit.value).toBe(42)
        }).pipe(
          Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(flow, `cancel-${budget}-${steps}`)),
          Effect.provideService(Scheduler.MaxOpsBeforeYield, budget)
        )
      }
    }
  }).pipe(Effect.provide(FlowEngine.layerMemory)))
