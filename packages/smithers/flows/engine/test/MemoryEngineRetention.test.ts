/**
 * The in-memory engine keeps a bounded number of settled lineages: past
 * `settledLineageRetention` it forgets the one settled longest ago with the
 * children only it owned, the action results only it used, and its deferred
 * results. Everything here is observed through the engine's port: a forgotten
 * id is unknown to `poll` and runs anew on `execute`.
 */
import { describe, expect } from "@effect/vitest"
import { Action, DurableClock, DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Exit, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FlowEngine } from "../src/index.ts"
import { effect, pollUntil } from "./Harness.ts"

const retention = FlowEngine.settledLineageRetention

const Filler = Flow.make("memory-retention/filler", {
  payload: { n: Schema.Number },
  success: Schema.Number,
  body: () => Node.succeed(0)
})

/** What `poll` says of an id: forgotten, or the tag of what it holds. */
const stateOf = <A, E, R>(
  flow: {
    readonly poll: (id: string) => Effect.Effect<Option.Option<Flow.Result<A, E>>, FlowRuntime.FlowExecutionNotFound, R>
  },
  executionId: string
) =>
  flow.poll(executionId).pipe(
    Effect.map(Option.match({ onNone: () => "running", onSome: (result) => result._tag })),
    Effect.catchTag("@smthrs/flow/FlowExecutionNotFound", () => Effect.succeed("forgotten"))
  )

/** Settles `count` more top-level lineages, each under an id never used before. */
const makeFill = Effect.gen(function*() {
  const engine = yield* FlowRuntime.FlowRuntime
  yield* engine.register(Filler, ({ n }) => Effect.succeed(n))
  let next = 0
  return (count: number) =>
    Effect.forEach(
      Array.from({ length: count }, () => next++),
      (n) => Filler.execute({ n }, { executionId: `filler-${n}` }),
      { discard: true }
    )
})

describe("FlowEngine.layerMemory settled lineages", () => {
  effect("forgets the lineage settled longest ago, and runs a forgotten id anew", () =>
    Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const Short = Flow.make("memory-retention/short", {
        payload: { n: Schema.Number },
        success: Schema.Number,
        body: () => Node.succeed(0)
      })
      let calls = 0
      yield* engine.register(Short, ({ n }) => Effect.sync(() => (calls++, n * 2)))
      const extra = 8
      for (let n = 0; n < retention + extra; n++) {
        expect(yield* Short.execute({ n }, { executionId: `short-${n}` })).toBe(n * 2)
      }
      expect(calls).toBe(retention + extra)

      const states = yield* Effect.forEach(
        Array.from({ length: retention + extra }, (_, n) => n),
        (n) => stateOf(Short, `short-${n}`)
      )
      expect(states.slice(0, extra)).toEqual(Array.from({ length: extra }, () => "forgotten"))
      expect(new Set(states.slice(extra))).toEqual(new Set(["Complete"]))

      // A retained id still joins its recorded result; a forgotten one is a new run.
      const last = retention + extra - 1
      expect(yield* Short.execute({ n: last }, { executionId: `short-${last}` })).toBe(last * 2)
      expect(calls).toBe(retention + extra)
      expect(yield* Short.execute({ n: 0 }, { executionId: "short-0" })).toBe(0)
      expect(calls).toBe(retention + extra + 1)
      // The new run is the newest lineage, and it pushed out the oldest one left.
      expect(yield* stateOf(Short, "short-0")).toBe("Complete")
      expect(yield* stateOf(Short, `short-${extra}`)).toBe("forgotten")
    }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory)))

  effect("forgets a lineage's action results with it", () =>
    Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const fill = yield* makeFill
      let calls = 0
      const sealed = Action.make({
        name: "memory-retention/sealed",
        success: Schema.Number,
        tier: "sealed",
        idempotencyKey: "memory-retention/sealed",
        execute: Effect.sync(() => ++calls)
      })
      const Uses = Flow.make("memory-retention/uses", {
        payload: {},
        success: Schema.Number,
        body: () => Node.succeed(0)
      })
      // Twice in one run: the second dispatch replays the first one's record.
      yield* engine.register(Uses, () => Effect.andThen(sealed, sealed))
      const run = Uses.execute({}, { executionId: "uses" })

      expect(yield* run).toBe(1)
      yield* fill(retention - 1)
      expect(yield* run).toBe(1)
      expect(calls).toBe(1)
      // Forgotten, the id is a new run with no record to replay: the action runs again.
      yield* fill(1)
      expect(yield* stateOf(Uses, "uses")).toBe("forgotten")
      expect(yield* run).toBe(2)
      expect(calls).toBe(2)
    }).pipe(Effect.scoped, Effect.provide(Action.layerImplementations), Effect.provide(FlowEngine.layerMemory)))

  for (const sharedFirst of [true, false]) {
    effect(
      `forgets the children only a forgotten lineage owned, shared child ${sharedFirst ? "first" : "last"}`,
      () =>
        Effect.gen(function*() {
          const engine = yield* FlowRuntime.FlowRuntime
          const fill = yield* makeFill
          const Gate = DurableDeferred.make("memory-retention/gate", { success: Schema.String })
          const flow = (name: string) =>
            Flow.make(`memory-retention/${name}`, { payload: {}, success: Schema.String, body: () => Node.succeed("") })
          const Parent = flow("parent")
          const Other = flow("other-parent")
          const Middle = flow("middle")
          const Shared = flow("shared")
          const Parked = flow("parked")
          const Twice = flow("twice")
          const twice = Effect.orDie(Twice.execute({}, { executionId: "twice" }))
          yield* engine.register(Twice, () => Effect.succeed("twice done"))
          const shared = Effect.orDie(Shared.execute({}, { executionId: "shared" }))
          const middle = Effect.orDie(Middle.execute({}, { executionId: "middle" }))
          yield* engine.register(Shared, () => Effect.succeed("shared done"))
          // `middle` owns `shared` and `twice` too, so one forgotten parent reaches each twice.
          yield* engine.register(Middle, () => Effect.andThen(twice, shared))
          yield* engine.register(Parked, () => DurableDeferred.await(Gate))
          yield* engine.register(Parent, () =>
            Effect.gen(function*() {
              yield* twice
              yield* sharedFirst ? Effect.andThen(shared, middle) : Effect.andThen(middle, shared)
              yield* Effect.orDie(Parked.execute({}, { executionId: "parked", discard: true }))
              return "parent done"
            }))
          yield* engine.register(Other, () => shared)

          expect(yield* Parent.execute({}, { executionId: "parent" })).toBe("parent done")
          yield* fill(1)
          expect(yield* Other.execute({}, { executionId: "other" })).toBe("shared done")
          // Children are not counted on their own: only the two parents and the filler are.
          yield* fill(retention - 3)
          expect(yield* stateOf(Parent, "parent")).toBe("Complete")
          yield* fill(1)
          expect(yield* stateOf(Parent, "parent")).toBe("forgotten")
          expect(yield* stateOf(Middle, "middle")).toBe("forgotten")
          expect(yield* stateOf(Twice, "twice")).toBe("forgotten")
          // `other` still owns the shared child, and a parked child outlives its owner.
          expect(yield* stateOf(Shared, "shared")).toBe("Complete")
          expect(yield* stateOf(Parked, "parked")).toBe("Suspended")

          yield* fill(2)
          expect(yield* stateOf(Other, "other")).toBe("forgotten")
          expect(yield* stateOf(Shared, "shared")).toBe("forgotten")

          // The parked child settles as a lineage of its own, and is counted from then.
          const token = DurableDeferred.tokenFromExecutionId(Gate, { flow: Parked, executionId: "parked" })
          yield* DurableDeferred.succeed(Gate, { token, value: "released" })
          const settled = yield* pollUntil(Parked.poll("parked"), (result) => result._tag === "Complete", {
            turns: 200
          })
          expect(Option.isSome(settled) && settled.value._tag === "Complete" && settled.value.exit).toEqual(
            Exit.succeed("released")
          )
          yield* fill(retention - 1)
          expect(yield* stateOf(Parked, "parked")).toBe("Complete")
          yield* fill(1)
          expect(yield* stateOf(Parked, "parked")).toBe("forgotten")
          // Its recorded completion went with it: the same id parks again.
          yield* Parked.execute({}, { executionId: "parked", discard: true })
          const again = yield* pollUntil(Parked.poll("parked"), (result) => result._tag === "Suspended", { turns: 200 })
          expect(Option.isSome(again)).toBe(true)
        }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory))
    )
  }

  effect("holds completions sent before admission for a bounded number of execution ids", () =>
    Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const Gate = DurableDeferred.make("memory-retention/early", { success: Schema.Number })
      const Waits = Flow.make("memory-retention/waits", {
        payload: {},
        success: Schema.Number,
        body: () => Node.succeed(0)
      })
      yield* engine.register(Waits, () => DurableDeferred.await(Gate))
      const complete = (n: number) =>
        DurableDeferred.succeed(Gate, {
          token: DurableDeferred.tokenFromExecutionId(Gate, { flow: Waits, executionId: `early-${n}` }),
          value: n
        })
      // The oldest id also has a timer armed, which goes with its completion.
      const clock = DurableClock.make({ name: "memory-retention/early-clock", duration: "1 minute" })
      yield* engine.scheduleClock(Waits, { executionId: "early-0", clock })
      for (let n = 0; n <= retention; n++) yield* complete(n)
      // Completing an id twice lists it once.
      yield* complete(retention)

      expect(yield* Waits.execute({}, { executionId: `early-${retention}` })).toBe(retention)
      expect(yield* Waits.execute({}, { executionId: "early-1" })).toBe(1)
      // The oldest completion was dropped: its run parks until it is sent again.
      yield* Waits.execute({}, { executionId: "early-0", discard: true })
      const parked = yield* pollUntil(Waits.poll("early-0"), (result) => result._tag === "Suspended", { turns: 200 })
      expect(Option.isSome(parked)).toBe(true)
      yield* TestClock.adjust("2 minutes")
      const clockRead = engine.deferredResult(clock.deferred).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(Waits, "early-0"))
      )
      expect(Option.isNone(yield* clockRead)).toBe(true)
      yield* complete(0)
      const settled = yield* pollUntil(Waits.poll("early-0"), (result) => result._tag === "Complete", { turns: 200 })
      expect(Option.isSome(settled) && settled.value._tag === "Complete" && settled.value.exit).toEqual(
        Exit.succeed(0)
      )
    }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory)))
})
