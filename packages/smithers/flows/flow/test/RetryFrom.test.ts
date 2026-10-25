/**
 * `Flow.retryFrom` over the port, and the child execution a `.child()`
 * boundary's settlement names, which is how a durable engine finds a boundary
 * step's child in a run's journal.
 *
 * What a retry replays and executes is the durable engine's to decide; that
 * is tested against the real engine in `@smthrs/engine-store`
 * (`test/RetryFrom.test.ts`). This package declares the port and the authoring
 * surface, so its suite pins those: a runtime with no history refuses, the
 * port is asked with the id the caller gets back, and refusals and identity
 * conflicts reach the caller typed.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { withCrypto } from "./Crypto.ts"
import { layerMemory, layerWired, makeMemoryState } from "./MemoryFlowRuntime.ts"

const Bump = Action.make("retry-from/bump", {
  payload: { value: Schema.Number },
  success: Schema.Number
})

const bumps = Bump.toLayer(({ value }) => Effect.succeed(value + 1))

const Child = Flow.make("retry-from/child", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: ({ value }) => Bump.call({ value })
})

const Parent = Flow.make("retry-from/parent", {
  payload: { value: Schema.Number },
  success: Schema.Number,
  body: ({ value }) => Bump.call({ value }).pipe(Node.andThen(Child.child({ value })))
})

type Port = FlowRuntime.FlowRuntime["Service"]

/** The memory runtime with `retryFrom` answered by `answer`, every request kept in `asked`. */
const withRetryFrom = (
  asked: Array<Parameters<NonNullable<Port["retryFrom"]>>[1]>,
  answer: Effect.Effect<void, FlowRuntime.RetryFromRefused> = Effect.void
) =>
  Layer.effect(FlowRuntime.FlowRuntime)(
    Effect.map(FlowRuntime.FlowRuntime, (runtime) =>
      FlowRuntime.FlowRuntime.of({
        ...runtime,
        retryFrom: (_flow, options) => Effect.andThen(Effect.sync(() => asked.push(options)), answer)
      }))
  ).pipe(Layer.provide(layerMemory))

const registered = (runtime: Layer.Layer<FlowRuntime.FlowRuntime>) =>
  Layer.mergeAll(bumps, Interpreter.layer(Parent), Interpreter.layer(Child)).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(runtime)
  )

describe("a boundary's node settlement", () => {
  it.effect("names the child execution the boundary opened, and no other node names one", () =>
    withCrypto(Effect.gen(function*() {
      const memory = makeMemoryState()
      const layer = layerWired(Layer.mergeAll(bumps, Interpreter.layer(Parent), Interpreter.layer(Child)), memory)
      yield* Parent.execute({ value: 2 }, { executionId: "retry-from-parent" }).pipe(Effect.provide(layer))
      const settled = memory.nodeRecords.flatMap((entry) =>
        entry.runId === "retry-from-parent" && entry.record._tag === "NodeSettled" ? [entry.record] : []
      )
      const boundary = settled.find((record) => record.action === Child._tag)!
      expect(boundary.childExecutionId).toBe(
        yield* Interpreter.childExecutionId("retry-from-parent", boundary.nodeId, Child._tag, { value: 2 })
      )
      expect(settled.filter((record) => record !== boundary).map((record) => record.childExecutionId)).toEqual(
        settled.filter((record) => record !== boundary).map(() => undefined)
      )
    })))
})

describe("Flow.retryFrom", () => {
  it.effect("refuses unsupported on a runtime that keeps no history", () =>
    withCrypto(Effect.gen(function*() {
      const refused = yield* Effect.flip(
        Parent.retryFrom("source-run", { step: "root.flow" }).pipe(Effect.provide(registered(layerMemory)))
      )
      expect(refused).toEqual(
        new FlowRuntime.RetryFromRefused({ code: "unsupported", executionId: "source-run", step: "root.flow" })
      )
      const refusal = new FlowRuntime.RetryFromRefused({ code: "step_not_run", executionId: "a", step: "b" })
      expect(refusal.message).toBe("Cannot retry execution \"a\" from step \"b\": step_not_run")
    })))

  it.effect("asks the port under the id it was given, and answers that id", () =>
    withCrypto(Effect.gen(function*() {
      const asked: Array<Parameters<NonNullable<Port["retryFrom"]>>[1]> = []
      const id = yield* Parent.retryFrom("source-run", { step: "root.flow", executionId: "retry-1" }).pipe(
        Effect.provide(registered(withRetryFrom(asked)))
      )
      expect(id).toBe("retry-1")
      expect(asked).toEqual([{ source: "source-run", step: "root.flow", executionId: "retry-1" }])
    })))

  it.effect("mints a fresh id when the caller names none", () =>
    withCrypto(Effect.gen(function*() {
      const asked: Array<Parameters<NonNullable<Port["retryFrom"]>>[1]> = []
      const layer = registered(withRetryFrom(asked))
      const first = yield* Parent.retryFrom("source-run", { step: "root.flow" }).pipe(Effect.provide(layer))
      const second = yield* Parent.retryFrom("source-run", { step: "root.flow" }).pipe(Effect.provide(layer))
      expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(second).not.toBe(first)
      expect(asked.map((options) => options.executionId)).toEqual([first, second])
    })))

  it.effect("passes the port's refusal through typed", () =>
    withCrypto(Effect.gen(function*() {
      const refusal = new FlowRuntime.RetryFromRefused({ code: "not_settled", executionId: "source-run", step: "x" })
      const passed = yield* Effect.flip(
        Parent.retryFrom("source-run", { step: "x", executionId: "retry-2" }).pipe(
          Effect.provide(registered(withRetryFrom([], Effect.fail(refusal))))
        )
      )
      expect(passed).toEqual(refusal)
    })))

  it.effect("turns an engine's identity conflict into a typed failure, and keeps any other defect", () =>
    withCrypto(Effect.gen(function*() {
      const conflict = new FlowRuntime.ExecutionIdentityConflict({
        executionId: "retry-3",
        field: "retry",
        expected: "a retry of source-run from a",
        actual: "a retry of source-run from b",
        message: "taken"
      })
      const conflicted = yield* Effect.flip(
        Parent.retryFrom("source-run", { step: "b", executionId: "retry-3" }).pipe(
          Effect.provide(registered(withRetryFrom([], Effect.die(conflict))))
        )
      )
      expect(conflicted).toEqual(conflict)
      const broken = yield* Effect.exit(
        Parent.retryFrom("source-run", { step: "b", executionId: "retry-4" }).pipe(
          Effect.provide(registered(withRetryFrom([], Effect.die("store gone"))))
        )
      )
      expect(Exit.isFailure(broken) && Cause.squash(broken.cause)).toBe("store gone")
    })))
})
