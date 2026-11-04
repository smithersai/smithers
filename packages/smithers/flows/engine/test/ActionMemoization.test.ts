/**
 * The memory engine's sealed-key memoization across every terminal outcome:
 * a typed failure, a defect, and a suspension. A settled outcome — success,
 * failure, or defect alike — replays exactly once per key and attempt; only a
 * recorded suspension is cleared, and it is cleared exactly once, so the
 * re-driven dispatch runs again while every later same-key dispatch replays
 * the settled result.
 */
import { describe, expect, it } from "@effect/vitest"
import type { Crypto } from "@smthrs/crypto"
import { Action, DurableDeferred, Flow, FlowRuntime, HumanTask, Interpreter, Sleep, WaitFor } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import { Effect, Exit, Layer, Option, Result, Schema } from "effect"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"
import { effect, pollUntil } from "./Harness.ts"

describe("sealed-key memoization of terminal outcomes", () => {
  effect("replays a typed failure exactly once for the same key and attempt", () => {
    // The first dispatch fails and records its exit; the second dispatch of
    // the same sealed key must replay that recorded failure without running
    // the implementation again.
    let executions = 0
    const flaky = Action.make({
      name: "Memoization/typed-failure",
      success: Schema.Number,
      error: Schema.String,
      idempotencyKey: "memoization/typed-failure",
      execute: Effect.suspend(() => {
        executions++
        return Effect.fail("nope")
      })
    })
    const flowActionDeclaration = Action.make("Memoization/typed-failure/action", {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const flow = Flow.make("Memoization/typed-failure", {
      payload: { id: Schema.String },
      success: Schema.String,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() =>
        Effect.gen(function*() {
          const first = yield* Effect.result(flaky)
          const second = yield* Effect.result(flaky)
          const firstError = Result.isFailure(first) ? first.failure : "missing"
          const secondError = Result.isFailure(second) ? second.failure : "missing"
          return `${firstError}:${secondError}`
        })
      ),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      // Both dispatches observe the SAME typed failure, from one execution.
      expect(yield* flow.execute({ id: "x" }, { executionId: "memo-typed-failure" })).toBe("nope:nope")
      expect(executions).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  effect("replays a defect exactly once for the same key and attempt", () => {
    let executions = 0
    const dying = Action.make({
      name: "Memoization/defect",
      success: Schema.Number,
      idempotencyKey: "memoization/defect",
      execute: Effect.suspend(() => {
        executions++
        return Effect.die("memo-kaboom")
      })
    })
    const flowActionDeclaration = Action.make("Memoization/defect/action", {
      payload: { id: Schema.String },
      success: Schema.Number
    })
    const flow = Flow.make("Memoization/defect", {
      payload: { id: Schema.String },
      success: Schema.Number,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const exits: Array<Exit.Exit<number>> = []
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() =>
        Effect.gen(function*() {
          exits.push(yield* Effect.exit(dying))
          exits.push(yield* Effect.exit(dying))
          return executions
        })
      ),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      expect(yield* flow.execute({ id: "x" }, { executionId: "memo-defect" })).toBe(1)
      // One execution; the second dispatch replayed the recorded defect.
      expect(executions).toBe(1)
      expect(exits).toHaveLength(2)
      for (const exit of exits) {
        expect(Exit.isFailure(exit)).toBe(true)
        expect(Exit.isFailure(exit) && String(exit.cause)).toContain("memo-kaboom")
      }
    }).pipe(Effect.provide(layer))
  })

  effect("clears a recorded suspension exactly once: the re-drive re-executes, later dispatches replay", () => {
    // Dispatch 1 suspends and records `Suspended`; the resume clears that
    // entry ONCE, so the re-driven dispatch runs the implementation again
    // and records the completion. Dispatch 2 — same key, same attempt —
    // replays the settled value without a third execution.
    const gate = DurableDeferred.make("Memoization/gate", { success: Schema.Number })
    let executions = 0
    const gated = Action.make({
      name: "Memoization/gated",
      success: Schema.Number,
      idempotencyKey: "memoization/gated",
      execute: Effect.suspend(() => {
        executions++
        return DurableDeferred.await(gate)
      })
    })
    const flowActionDeclaration = Action.make("Memoization/gated/action", {
      payload: { id: Schema.String },
      success: Schema.String
    })
    const flow = Flow.make("Memoization/gated", {
      payload: { id: Schema.String },
      success: Schema.String,
      idempotencyKey: ({ id }) => id,
      body: (payload) => flowActionDeclaration.call(payload)
    })
    const layer = Layer.mergeAll(
      flowActionDeclaration.toLayer(() =>
        Effect.gen(function*() {
          const first = yield* gated
          const second = yield* gated
          return `${first}:${second}`
        })
      ),
      Interpreter.layer(flow)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations)
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))

    return Effect.gen(function*() {
      const executionId = yield* flow.execute({ id: "memo-gated" }, { discard: true })
      const parked = yield* pollUntil(flow.poll(executionId), (result) => result._tag === "Suspended", { turns: 50 })
      expect(Option.isSome(parked) && parked.value._tag).toBe("Suspended")
      expect(executions).toBe(1)

      const token = DurableDeferred.tokenFromExecutionId(gate, { flow, executionId })
      yield* DurableDeferred.succeed(gate, { token, value: 9 })
      const woken = yield* pollUntil(flow.poll(executionId), (result) => result._tag === "Complete", { turns: 50 })
      expect(
        Option.isSome(woken) && woken.value._tag === "Complete" &&
          Exit.isSuccess(woken.value.exit) && woken.value.exit.value
      ).toBe("9:9")
      // Two executions in total: the first park and the one re-drive. The
      // second dispatch replayed the settled completion.
      expect(executions).toBe(2)
    }).pipe(Effect.provide(layer))
  })
})

describe("engine-owned system actions", () => {
  effect("registers Sleep and WaitFor for independent canonical flows", () => {
    const sleeper = Flow.make("SystemActions/sleep", {
      payload: {},
      error: Sleep.SleepRequestInvalid,
      body: Node.capture({ sleep: Sleep.tag, version: 1 }, () => Sleep.action.call({ millis: 0 }))
    })
    const waiter = Flow.make("SystemActions/wait", {
      payload: {},
      success: Schema.Json,
      error: WaitFor.WaitForRequestInvalid,
      body: Node.capture({ waitFor: WaitFor.tag, version: 1 }, () => WaitFor.action.call({ name: "signal" }))
    })
    const registered = Layer.mergeAll(
      Interpreter.layerWithImplementations(sleeper, Sleep.layer),
      Interpreter.layerWithImplementations(waiter, Layer.empty)
    ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
    return Effect.gen(function*() {
      expect(yield* sleeper.execute({})).toBeUndefined()
      yield* waiter.execute({}, { executionId: "system-wait", discard: true })
      const parked = yield* pollUntil(waiter.poll("system-wait"), (result) => result._tag === "Suspended", {
        turns: 200
      })
      expect(Option.isSome(parked) && parked.value._tag).toBe("Suspended")
      const deferred = WaitFor.deferred("signal")
      yield* DurableDeferred.succeed(deferred, {
        token: DurableDeferred.tokenFromExecutionId(deferred, { flow: waiter, executionId: "system-wait" }),
        value: "received"
      })
      expect(yield* waiter.execute({}, { executionId: "system-wait" })).toBe("received")
    }).pipe(Effect.provide(registered))
  })

  it.effect("asks and answers without an author-supplied HumanTask layer", () => {
    const question = Flow.make("SystemActions/question", {
      payload: {},
      success: Schema.Json,
      error: HumanTask.HumanTaskFailed,
      body: Node.capture(
        { humanTask: HumanTask.tag, version: 1 },
        () => HumanTask.action.call({ name: "approval", kind: "ask", prompt: "Why?" })
      )
    })
    const program = Effect.gen(function*() {
      yield* question.execute({}, { executionId: "system-question", discard: true })
      const parked = yield* pollUntil(question.poll("system-question"), (result) => result._tag === "Suspended", {
        turns: 200
      })
      expect(Option.isSome(parked) && parked.value._tag).toBe("Suspended")
      yield* HumanTask.answer({
        token: DurableDeferred.tokenFromExecutionId(HumanTask.deferred("approval", 1), {
          flow: question,
          executionId: "system-question"
        }),
        value: "because"
      })
      const settled = yield* question.execute({}, { executionId: "system-question" })
      expect(settled).toBe("because")
    })
    return Effect.gen(function*() {
      const registered = yield* Layer.build(
        Interpreter.layerWithImplementations(question, Layer.empty).pipe(Layer.provideMerge(FlowEngine.layerMemory))
      )
      return yield* withCrypto(program.pipe(Effect.provide(registered)))
    })
  })
})
