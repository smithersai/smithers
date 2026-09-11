import { describe, expect, it } from "@effect/vitest"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter, RetryPolicy } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"
import { effect, liveEffect, pollUntil } from "./Harness.ts"
import { scriptedEngine } from "./ScriptedEngine.ts"

/**
 * The same wiring on the live clock, for cases that wait on the real elapsed
 * time a retry or resume policy schedules rather than driving `TestClock`.
 */
const isSuspended = (result: Flow.Result<any, any>) => result._tag === "Suspended"
const isComplete = (result: Flow.Result<any, any>) => result._tag === "Complete"

describe("action suspension", () => {
  effect("an action that waits on an unresolved deferred suspends the flow and replays once resolved", () => {
    const Gate = DurableDeferred.make("Child/action-gate", {
      success: Schema.String
    })
    let bodyRuns = 0
    const gated = Action.make({
      name: "Child/gated-action",
      success: Schema.String,
      execute: Effect.gen(function*() {
        bodyRuns++
        return yield* DurableDeferred.await(Gate)
      })
    })
    const flowActionDeclaration = Action.make("Child/action-suspends/action", {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const flow = Flow.make("Child/action-suspends", {
      payload: { id: Schema.String },
      success: Schema.String,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() => Effect.map(gated, (value) => `got:${value}`)),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(
      Layer.provideMerge(FlowEngine.layerMemory)
    )

    return Effect.gen(function*() {
      yield* flow.execute({ id: "x" }, { executionId: "run-action-gate", discard: true })
      const suspended = yield* pollUntil(flow.poll("run-action-gate"), isSuspended, { turns: 200 })
      expect(Option.isSome(suspended)).toBe(true)
      expect(bodyRuns).toBe(1)

      const token = DurableDeferred.tokenFromExecutionId(Gate, {
        flow,
        executionId: "run-action-gate"
      })
      yield* DurableDeferred.succeed(Gate, { token, value: "open" })

      const done = yield* pollUntil(flow.poll("run-action-gate"), isComplete, { turns: 200 })
      expect(
        Option.isSome(done) && done.value._tag === "Complete" && Exit.isSuccess(done.value.exit) &&
          done.value.exit.value
      ).toBe("got:open")
      // the suspended attempt is not cached as a result: the body re-runs and
      // completes on the resumed pass
      expect(bodyRuns).toBe(2)
    }).pipe(Effect.provide(layer))
  })
})

describe("child flow suspension and interruption", () => {
  effect("a suspended child suspends its parent until the child's gate opens", () => {
    const Gate = DurableDeferred.make("Child/child-gate", { success: Schema.Number })
    const childActionDeclaration = Action.make("Child/gated-child/action", {
      payload: { n: Schema.Number },
      success: Schema.Number
    })
    const child = Flow.make("Child/gated-child", {
      payload: { n: Schema.Number },
      success: Schema.Number,
      body: (payload) => childActionDeclaration.call(payload)
    })
    const parentActionDeclaration = Action.make("Child/waiting-parent/action", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const parent = Flow.make("Child/waiting-parent", {
      payload: { id: Schema.String },
      success: Schema.Number,
      body: (payload) => parentActionDeclaration.call(payload)
    })
    // The parent's implementation executes the child, so the child's wiring goes
    // UNDER the parent's rather than beside it: that is what answers the child
    // flow's requirement where the parent's implementation asks for it.
    const layer = Layer.mergeAll(
      // The literal child payload always satisfies its schema, so the typed
      // SchemaError on execute cannot occur and is disposed of as a defect.
      parentActionDeclaration.toLayer(() =>
        Effect.map(Effect.orDie(child.execute({ n: 1 }, { executionId: "child-gated" })), (n) => n + 1)
      ),
      Interpreter.layer(parent)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(
        Layer.mergeAll(childActionDeclaration.toLayer(() => DurableDeferred.await(Gate)), Interpreter.layer(child))
          .pipe(
            Layer.provideMerge(Action.layerImplementations)
          )
      ),
      Layer.provideMerge(FlowEngine.layerMemory)
    )

    return Effect.gen(function*() {
      yield* parent.execute({ id: "x" }, { executionId: "parent-gated", discard: true })
      const suspended = yield* pollUntil(parent.poll("parent-gated"), isSuspended, { turns: 200 })
      expect(Option.isSome(suspended)).toBe(true)
      // the child's suspension propagated: the parent is parked, not failed
      expect(Option.isSome(yield* pollUntil(child.poll("child-gated"), isSuspended, { turns: 200 }))).toBe(true)

      const token = DurableDeferred.tokenFromExecutionId(Gate, {
        flow: child,
        executionId: "child-gated"
      })
      yield* DurableDeferred.succeed(Gate, { token, value: 41 })

      const done = yield* pollUntil(parent.poll("parent-gated"), isComplete, { turns: 200 })
      expect(
        Option.isSome(done) && done.value._tag === "Complete" && Exit.isSuccess(done.value.exit) &&
          done.value.exit.value
      ).toBe(42)
    }).pipe(Effect.provide(layer))
  })

  // An interrupted parent must not leave a live child behind. The engine
  // registers a finalizer on every child execution: when the parent's scope
  // closes while the parent is interrupted and the child has not completed,
  // the child is interrupted; otherwise it is left alone.
  const childInterruptionMatrix: ReadonlyArray<
    readonly [string, boolean, "Suspended" | "Complete", ReadonlyArray<string>]
  > = [
    ["interrupted parent, suspended child", true, "Suspended", ["child-exec"]],
    ["interrupted parent, completed child", true, "Complete", []],
    ["live parent, suspended child", false, "Suspended", []],
    ["live parent, completed child", false, "Complete", []]
  ]

  for (const [label, parentInterrupted, childOutcome, expected] of childInterruptionMatrix) {
    effect(`${label} → interrupts ${expected.length === 0 ? "nothing" : "the child"}`, () => {
      const interruptCalls: Array<string> = []
      const child = Flow.make("Child/matrix-child", {
        payload: { n: Schema.Number },
        success: Schema.Number,
        body: () => Node.succeed(0)
      })
      const parentFlow = Flow.make("Child/matrix-parent", {
        payload: { id: Schema.String },
        success: Schema.Number,
        body: () => Node.succeed(0)
      })
      const scripted = scriptedEngine({
        execute: (() =>
          Effect.succeed(
            childOutcome === "Complete"
              ? new Flow.Complete({ exit: Exit.succeed(1) })
              : new Flow.Suspended({})
          )) as any,
        interrupt: (_flow, executionId) => Effect.sync(() => void interruptCalls.push(executionId)),
        actionExecute: () => Effect.succeed(new Flow.Complete({ exit: Exit.void }))
      })
      const parentInstance = FlowEngine.makeInstance(parentFlow, "parent-exec")
      parentInstance.interrupted = parentInterrupted

      return Effect.gen(function*() {
        // suspension interrupts the running fiber, so observe it from outside
        const fiber = yield* Effect.forkChild(
          scripted.execute(child, {
            executionId: "child-exec",
            payload: { n: 1 }
          }).pipe(Effect.scoped)
        )
        const exit = yield* Fiber.await(fiber)
        // a completed child yields its value; a suspended one suspends the parent
        expect(Exit.isSuccess(exit)).toBe(childOutcome === "Complete")
        expect(interruptCalls).toEqual(expected)
      }).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, parentInstance),
        Effect.provideService(FlowRuntime.FlowRuntime, scripted)
      )
    })
  }

  effect("a completed child is not interrupted when the parent is torn down", () => {
    const interrupted: Array<string> = []
    const childActionDeclaration = Action.make("Child/quick-child/action", {
      payload: { n: Schema.Number },
      success: Schema.Number
    })
    const child = Flow.make("Child/quick-child", {
      payload: { n: Schema.Number },
      success: Schema.Number,
      body: (payload) => childActionDeclaration.call(payload)
    })
    const parentActionDeclaration = Action.make("Child/quick-parent/action", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const parent = Flow.make("Child/quick-parent", {
      payload: { id: Schema.String },
      success: Schema.Number,
      body: (payload) => parentActionDeclaration.call(payload)
    })
    // The parent's implementation executes the child, so the child's wiring goes
    // UNDER the parent's rather than beside it: that is what answers the child
    // flow's requirement where the parent's implementation asks for it.
    const layer = Layer.mergeAll(
      parentActionDeclaration.toLayer(() => Effect.orDie(child.execute({ n: 5 }, { executionId: "child-quick" }))),
      Interpreter.layer(parent)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(
        Layer.mergeAll(
          childActionDeclaration.toLayer((payload) =>
            Effect.succeed(payload.n).pipe(
              Effect.onInterrupt(() => Effect.sync(() => void interrupted.push("child")))
            )
          ),
          Interpreter.layer(child)
        ).pipe(
          Layer.provideMerge(Action.layerImplementations)
        )
      ),
      Layer.provideMerge(FlowEngine.layerMemory)
    )

    return Effect.gen(function*() {
      expect(yield* parent.execute({ id: "x" }, { executionId: "parent-quick" })).toBe(5)
      expect(interrupted).toEqual([])
    }).pipe(Effect.provide(layer))
  })
})

describe("resumeSignal", () => {
  effect("a wake signal races the suspended backoff sleep instead of waiting it out", () => {
    // A durable driver supplies `resumeSignal` so a wake (approval granted,
    // event delivered) resumes immediately rather than after the policy delay.
    // The delay here is an hour: only the signal can finish this test.
    const flow = Flow.make("Signal/waker", {
      payload: { id: Schema.String },
      success: Schema.String,
      suspendedRetryPolicy: RetryPolicy.make({
        initialMs: 3_600_000,
        factor: 1,
        maxMs: 3_600_000
      }),
      body: () => Node.succeed("ready")
    })
    let executions = 0
    let signals = 0
    const scripted = scriptedEngine({
      execute: (() =>
        Effect.sync(() => {
          executions++
          return executions === 1
            ? new Flow.Suspended({})
            : new Flow.Complete({ exit: Exit.succeed("woken") })
        })) as any,
      resumeSignal: () => Effect.sync(() => void signals++),
      actionExecute: () => Effect.succeed(new Flow.Complete({ exit: Exit.void }))
    })

    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "x" }, { executionId: "run-signal" })).toBe("woken")
      expect(executions).toBe(2)
      expect(signals).toBe(1)
    }).pipe(Effect.provide(Layer.succeed(FlowRuntime.FlowRuntime)(scripted)))
  })

  liveEffect("without a resumeSignal the engine falls back to the policy delay", () => {
    const flow = Flow.make("Signal/no-waker", {
      payload: { id: Schema.String },
      success: Schema.String,
      suspendedRetryPolicy: RetryPolicy.make({ initialMs: 1, factor: 1, maxMs: 1 }),
      body: () => Node.succeed("ready")
    })
    let executions = 0
    const scripted = scriptedEngine({
      execute: (() =>
        Effect.sync(() => {
          executions++
          return executions === 1
            ? new Flow.Suspended({})
            : new Flow.Complete({ exit: Exit.succeed("slept") })
        })) as any,
      actionExecute: () => Effect.succeed(new Flow.Complete({ exit: Exit.void }))
    })

    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "x" }, { executionId: "run-nosignal" })).toBe("slept")
      expect(executions).toBe(2)
    }).pipe(Effect.provide(Layer.succeed(FlowRuntime.FlowRuntime)(scripted)))
  })
})
