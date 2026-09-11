/**
 * A `.child()` boundary driven by the real engine: the child is its own
 * execution, opened with the parent instance in hand — which is what
 * `RunDriver` turns into a `flows_run_parents` edge — and the nesting the edge
 * stands for is genuine, so the parent's interruption and the child's
 * suspension travel between them.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Deferred, Effect, Exit, Fiber, Layer, Logger, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"
import { scriptedEngine } from "./ScriptedEngine.ts"

const Bump = Action.make("boundary/bump", {
  payload: { value: Schema.Number },
  success: Schema.Number
})

const Child = Flow.make("boundary/child", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: ({ value }) => Bump.call({ value })
})

const Parent = Flow.make("boundary/parent", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: ({ value }) => Child.child({ value }).pipe(Node.map((settled) => settled * 10))
})

/** The node id the boundary in `Parent`'s body is recorded under. */
const boundaryNode = "root.flow.map"

/**
 * An engine over a scripted low-level implementation, recording what every
 * execution request carried. `options.parent` is the whole point: a durable
 * driver records exactly that pair as the run-parent edge before it creates the
 * child's run row.
 */
const scripted = (
  result: Flow.Result<unknown, unknown>,
  interruptFailure?: FlowRuntime.CancelRequestFailed,
  interruptDelivery: Effect.Effect<void> = Effect.void
) => {
  const requests: Array<{ readonly executionId: string; readonly parent: string | undefined }> = []
  const interrupts: Array<string> = []
  const engine = scriptedEngine({
    execute: ((_flow: Flow.Any, options: {
      readonly executionId: string
      readonly parent?: FlowRuntime.FlowInstance["Service"] | undefined
    }) =>
      Effect.sync(() => {
        requests.push({ executionId: options.executionId, parent: options.parent?.executionId })
        return result
      })) as never,
    interrupt: (_flow, executionId) =>
      Effect.sync(() => void interrupts.push(executionId)).pipe(
        Effect.andThen(
          interruptFailure === undefined ? interruptDelivery : Effect.fail(interruptFailure)
        )
      ),
    actionExecute: () => Effect.succeed(new Flow.Complete({ exit: Exit.void }))
  })
  return { engine, interrupts, requests }
}

/**
 * Drives one body against a scripted engine, as a handler under `parent` would.
 * A suspension interrupts the running fiber rather than answering, so the exit
 * is observed from outside it.
 */
const drive = (
  engine: FlowRuntime.FlowRuntime["Service"],
  instance: FlowRuntime.FlowInstance["Service"]
) =>
  withCrypto(
    Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(
        Interpreter.interpret(Parent, { value: 4 }).pipe(
          Effect.scoped,
          Effect.provideService(FlowRuntime.FlowInstance, instance),
          Effect.provideService(FlowRuntime.FlowRuntime, engine),
          Effect.provide(Action.layerImplementations)
        )
      )
      return yield* Fiber.await(fiber)
    })
  )

/**
 * The real in-memory engine, with the callee registered as its own flow and the
 * action it calls recording every dispatch.
 */
const live = () => {
  const calls: Array<string> = []
  const layer = Layer.mergeAll(
    Bump.toLayer(({ value }) =>
      Effect.sync(() => {
        calls.push(`bump:${value}`)
        return value + 1
      })
    ),
    Interpreter.layer(Child),
    Interpreter.layer(Parent)
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory)
  )
  return { calls, layer }
}

describe("a child boundary on the real engine", () => {
  it.effect("opens the child with the parent instance, under an id derived from parent and node", () =>
    Effect.gen(function*() {
      const { engine, requests } = scripted(new Flow.Complete({ exit: Exit.succeed(5) }))
      const instance = FlowEngine.makeInstance(Parent, "boundary-parent")

      const exit = yield* drive(engine, instance)

      expect(Exit.isSuccess(exit)).toBe(true)
      expect(Exit.isSuccess(exit) && exit.value.value).toBe(50)
      // One request, naming the parent: a durable driver records
      // (child, parent) as the run-parent edge before the child's run row exists.
      expect(requests).toEqual([{
        executionId: yield* withCrypto(Interpreter.childExecutionId("boundary-parent", boundaryNode, Child._tag, {
          value: 4
        })),
        parent: "boundary-parent"
      }])
    }))

  it.effect("suspends the parent when the child suspends", () =>
    Effect.gen(function*() {
      const { engine, requests } = scripted(new Flow.Suspended({}))
      const instance = FlowEngine.makeInstance(Parent, "boundary-suspended")

      const exit = yield* drive(engine, instance)

      // Suspension interrupts the running fiber rather than answering, which is
      // how the engine parks a parent behind its child.
      expect(Exit.isSuccess(exit)).toBe(false)
      expect(instance.suspended).toBe(true)
      expect(requests).toHaveLength(1)
    }))

  it.effect("interrupts the child by its derived id when the parent is torn down interrupted", () =>
    Effect.gen(function*() {
      const { engine, interrupts } = scripted(new Flow.Suspended({}))
      const instance = FlowEngine.makeInstance(Parent, "boundary-interrupted")
      instance.interrupted = true

      yield* drive(engine, instance)

      expect(interrupts).toEqual([
        yield* withCrypto(Interpreter.childExecutionId("boundary-interrupted", boundaryNode, Child._tag, { value: 4 }))
      ])
    }))

  it.effect("absorbs a linked-cancellation recording failure after logging it", () =>
    Effect.gen(function*() {
      const failure = new FlowRuntime.CancelRequestFailed({
        code: "cancel_request_failed",
        executionId: "boundary-interrupt-failure",
        reason: "database unavailable"
      })
      const { engine, interrupts } = scripted(new Flow.Suspended({}), failure)
      const instance = FlowEngine.makeInstance(Parent, "boundary-interrupt-failure")
      instance.interrupted = true

      const logs: Array<{ logLevel: string; message: unknown }> = []
      const logger = Logger.make((entry) => {
        logs.push(entry)
      })
      const exit = yield* drive(engine, instance).pipe(Effect.provide(Logger.layer([logger])))

      expect(Exit.isFailure(exit)).toBe(true)
      expect(interrupts).toEqual([
        yield* withCrypto(
          Interpreter.childExecutionId(
            "boundary-interrupt-failure",
            boundaryNode,
            Child._tag,
            { value: 4 }
          )
        )
      ])
      const warnings = logs.filter((entry) => entry.logLevel === "Warn")
      expect(warnings).toHaveLength(1)
      expect(String(warnings[0]!.message)).toContain(interrupts[0])
      expect(String(warnings[0]!.message)).toContain("could not record the linked cancellation")
      expect(warnings[0]!.message).toContainEqual(expect.objectContaining({
        _tag: failure._tag,
        reason: "database unavailable"
      }))
    }))

  it.effect("bounds linked-cancellation delivery when the store blocks", () =>
    Effect.gen(function*() {
      const entered = yield* Deferred.make<void>()
      const blocked = yield* Deferred.make<void>()
      const { engine, interrupts } = scripted(
        new Flow.Suspended({}),
        undefined,
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(blocked)))
      )
      const instance = FlowEngine.makeInstance(Parent, "boundary-interrupt-blocked")
      instance.interrupted = true
      const logs: Array<{ logLevel: string; message: unknown }> = []
      const logger = Logger.make((entry) => {
        logs.push(entry)
      })
      const fiber = yield* engine.execute(Child, {
        executionId: "boundary-blocked-child",
        payload: { value: 4 },
        discard: true
      }).pipe(
        Effect.scoped,
        Effect.provideService(FlowRuntime.FlowInstance, instance),
        Effect.provide(Logger.layer([logger])),
        Effect.forkChild
      )
      yield* Deferred.await(entered)
      yield* TestClock.adjust("4999 millis")
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("1 millis")
      for (let attempt = 0; attempt < 100 && fiber.pollUnsafe() === undefined; attempt++) {
        yield* Effect.yieldNow
      }
      const closed = fiber.pollUnsafe()
      // Release even on the unfixed implementation, so the regression fails
      // an assertion instead of hanging the test's own finalizers.
      yield* Deferred.succeed(blocked, undefined)
      yield* Fiber.await(fiber)
      expect(closed).toBeDefined()
      const warnings = logs.filter((entry) => entry.logLevel === "Warn")
      expect(warnings).toHaveLength(1)
      expect(String(warnings[0]!.message)).toContain(interrupts[0])
      expect(String(warnings[0]!.message)).toContain("timed out")
    }))

  it.effect("does not suspend the parent of a discarded child", () =>
    Effect.gen(function*() {
      const { engine, requests } = scripted(new Flow.Suspended({}))
      const instance = FlowEngine.makeInstance(Parent, "boundary-discard-parent")
      yield* engine.register(Child, () => Effect.succeed(5))
      const id = yield* engine.execute(Child, {
        executionId: "boundary-discard-child",
        payload: { value: 4 },
        discard: true
      }).pipe(
        Effect.scoped,
        Effect.provideService(FlowRuntime.FlowInstance, instance)
      )
      expect(id).toBe("boundary-discard-child")
      for (let attempt = 0; attempt < 100 && requests.length < 2; attempt++) {
        yield* Effect.yieldNow
      }
      expect(requests).toEqual([
        { executionId: id, parent: instance.executionId },
        { executionId: id, parent: instance.executionId }
      ])
      expect(instance.suspended).toBe(false)
    }).pipe(Effect.scoped))

  it.effect("runs the child as a separate registered execution on the real engine", () =>
    Effect.gen(function*() {
      const { calls, layer } = live()

      const value = yield* withCrypto(
        Parent.execute({ value: 4 }, { executionId: "boundary-live" }).pipe(Effect.provide(layer))
      )

      expect(value).toBe(50)
      expect(calls).toEqual(["bump:4"])
    }))

  it.effect("re-derives the same child id when the parent body is replayed, so the child runs once", () =>
    Effect.gen(function*() {
      const { calls, layer } = live()

      // Asking the engine for the same parent execution id twice answers from the
      // settled parent without planning anything, so it can never observe a
      // minted child id. Re-driving the BODY under one instance is the replay
      // that reaches the boundary node a second time.
      const replay = yield* withCrypto(
        Effect.gen(function*() {
          const instance = FlowEngine.makeInstance(Parent, "boundary-replay")
          const drive = Interpreter.interpret(Parent, { value: 4 }).pipe(
            Effect.provideService(FlowRuntime.FlowInstance, instance)
          )
          const first = yield* drive
          const second = yield* drive
          return [first.value, second.value]
        }).pipe(Effect.scoped, Effect.provide(layer))
      )

      expect(replay).toEqual([50, 50])
      expect(calls).toEqual(["bump:4"])
    }))

  it.effect("derives injective ids from the canonical parent, node, callee, and payload tuple", () =>
    Effect.gen(function*() {
      const derive = (parent: string, node: string, callee: string, payload: unknown) =>
        withCrypto(Interpreter.childExecutionId(parent, node, callee, payload))
      const base = yield* derive("a/child/b", "c", "boundary/child", { b: 2, a: 1 })

      expect(base).toMatch(/^[0-9a-f]{64}$/)
      expect(yield* derive("a", "b/child/c", "boundary/child", { a: 1, b: 2 })).not.toBe(base)
      expect(yield* derive("a/child/b", "c", "boundary/other", { a: 1, b: 2 })).not.toBe(base)
      expect(yield* derive("a/child/b", "c", "boundary/child", { a: 1, b: 3 })).not.toBe(base)
      expect(yield* derive("a/child/b", "c", "boundary/child", { a: 1, b: 2 })).toBe(base)
    }))
})
