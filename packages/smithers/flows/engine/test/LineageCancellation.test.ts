import { describe, expect, it } from "@effect/vitest"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Deferred, Effect, Exit, Fiber, Option, Schema } from "effect"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"

// A round built from raw parts, including malformed ones only validation sees.
const roundOf = (rootExecutionId: string, ordinal: number): FlowEngine.Round.Round => ({
  rootExecutionId: rootExecutionId as FlowEngine.Round.RootExecutionId,
  ordinal
})

const Round = Flow.make("memory-lineage/round", {
  payload: { ordinal: Schema.Number },
  success: Schema.String,
  body: () => Node.succeed("inert")
})

const handoff = (ordinal: number) =>
  Effect.gen(function*() {
    const instance = yield* FlowRuntime.FlowInstance
    instance.handoff = new Flow.Handoff({ flow: Round._tag, payload: { ordinal } })
    return "ignored"
  })

const awaitSettlement = (id: string) =>
  Effect.gen(function*() {
    let result = yield* Round.poll(id)
    for (let attempt = 0; attempt < 40 && (Option.isNone(result) || result.value._tag !== "Complete"); attempt++) {
      yield* Effect.yieldNow
      result = yield* Round.poll(id)
    }
    expect(Option.isSome(result) && result.value._tag).toBe("Complete")
    if (Option.isSome(result) && result.value._tag === "Complete") {
      expect(Exit.isFailure(result.value.exit) && Cause.hasInterrupts(result.value.exit.cause)).toBe(true)
    }
  })

describe("memory logical cancellation", () => {
  it.effect("a cancelled parent joining an existing independent child cancels that child", () =>
    Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const Parent = Flow.make("memory-lineage/join-parent", {
        payload: {},
        success: Schema.String,
        body: () => Node.succeed("inert")
      })
      const entered = yield* Deferred.make<void>()
      yield* engine.register(Parent, () => Effect.never)
      yield* engine.register(Round, () => Effect.andThen(Deferred.succeed(entered, undefined), Effect.never))
      yield* engine.execute(Parent, { executionId: "parent", payload: {}, discard: true })
      yield* engine.execute(Round, { executionId: "independent", payload: { ordinal: 0 }, discard: true })
      yield* Deferred.await(entered)
      yield* engine.interrupt(Parent, "parent")
      // A resumed/captured instance can predate cancellation. The engine's own
      // record, not only that caller's boolean, must decide late attachment.
      const staleParent = FlowEngine.makeInstance(Parent, "parent")
      yield* engine.execute(Round, { executionId: "independent", payload: { ordinal: 0 }, discard: true }).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, staleParent)
      )
      yield* awaitSettlement("independent")
      yield* engine.execute(Round, { executionId: "new-child", payload: { ordinal: 0 }, discard: true }).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, staleParent)
      )
      yield* awaitSettlement("new-child")
    }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory), withCrypto))

  it.effect("cancels a parked successor through its completed predecessor", () =>
    Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      yield* engine.register(Round, ({ ordinal }) =>
        ordinal === 0 ? handoff(1) : Effect.flatMap(
          FlowRuntime.FlowInstance,
          (instance) => Flow.suspend(instance)
        ))
      yield* engine.execute(Round, { executionId: "root", payload: { ordinal: 0 } }).pipe(Effect.forkScoped)
      const next = yield* FlowEngine.Round.executionId(roundOf("root", 1))
      let parked = false
      for (let attempt = 0; attempt < 40 && !parked; attempt++) {
        yield* Effect.yieldNow
        const polled = yield* Round.poll(next).pipe(Effect.catch(() => Effect.succeedNone))
        parked = Option.isSome(polled) && polled.value._tag === "Suspended"
      }
      expect(parked).toBe(true)
      yield* Round.interrupt("root")
      yield* awaitSettlement(next)
    }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory), withCrypto))

  it.effect("normal and unsafe cancellation tolerate a child edge whose admission failed", () =>
    Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      yield* engine.register(Round, () => Effect.never)
      yield* engine.execute(Round, { executionId: "parent", payload: { ordinal: 0 }, discard: true })
      const parent = FlowEngine.makeInstance(Round, "parent")
      const failed = yield* engine.execute(Round, {
        executionId: "invalid-child",
        payload: { ordinal: "not a number" as never },
        discard: true
      }).pipe(Effect.provideService(FlowRuntime.FlowInstance, parent), Effect.exit)
      expect(Exit.isFailure(failed)).toBe(true)
      yield* Round.interrupt("parent")
      yield* awaitSettlement("parent")
      yield* engine.interruptUnsafe(Round, "parent")
      yield* engine.interruptUnsafe(Round, "unknown")
      expect((yield* Effect.flip(Round.poll("invalid-child"))).executionId).toBe("invalid-child")
    }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory), withCrypto))

  it.effect("cascades into a child lineage and refuses a child admitted after cancellation", () =>
    Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const Parent = Flow.make("memory-lineage/parent", {
        payload: {},
        success: Schema.String,
        body: () => Node.succeed("inert")
      })
      let parent: FlowRuntime.FlowInstance["Service"] | undefined
      const parentEntered = yield* Deferred.make<void>()
      const childEntered = yield* Deferred.make<void>()
      let childCalls = 0
      yield* engine.register(Parent, () =>
        Effect.gen(function*() {
          parent = yield* FlowRuntime.FlowInstance
          yield* Deferred.succeed(parentEntered, undefined)
          return yield* Effect.never
        }))
      yield* engine.register(Round, ({ ordinal }) =>
        ordinal === 0 ? handoff(1) : Effect.gen(function*() {
          childCalls++
          yield* Deferred.succeed(childEntered, undefined)
          return yield* Effect.never
        }))
      yield* engine.execute(Parent, { executionId: "parent", payload: {}, discard: true })
      yield* Deferred.await(parentEntered)
      yield* engine.execute(Round, { executionId: "child", payload: { ordinal: 0 } }).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, parent!),
        Effect.forkScoped
      )
      yield* Deferred.await(childEntered)
      yield* engine.interrupt(Parent, "parent")
      const next = yield* FlowEngine.Round.executionId(roundOf("child", 1))
      yield* awaitSettlement(next)
      yield* engine.execute(Round, { executionId: "late-child", payload: { ordinal: 1 }, discard: true }).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, parent!)
      )
      yield* awaitSettlement("late-child")
      expect(childCalls).toBe(1)
    }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory), withCrypto))

  for (const requestedOrdinal of [0, 1]) {
    it.effect(`cancels a live third round through round ${requestedOrdinal} without changing handoff history`, () =>
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        const entered = yield* Deferred.make<void>()
        let cleanup = 0
        yield* engine.register(Round, ({ ordinal }) =>
          ordinal < 2
            ? handoff(ordinal + 1)
            : Effect.andThen(Deferred.succeed(entered, undefined), Effect.never).pipe(
              Effect.ensuring(Effect.sync(() => {
                cleanup++
              }))
            ))
        const execution = yield* engine.execute(Round, { executionId: "root", payload: { ordinal: 0 } }).pipe(
          Effect.forkScoped
        )
        yield* Deferred.await(entered)
        const second = yield* FlowEngine.Round.executionId(roundOf("root", 1))
        const third = yield* FlowEngine.Round.executionId(roundOf("root", 2))
        yield* Round.interrupt(requestedOrdinal === 0 ? "root" : second)
        yield* awaitSettlement(third)
        expect(cleanup).toBe(1)
        expect(Option.getOrThrow(yield* Round.poll("root"))._tag).toBe("Handoff")
        expect(Exit.isFailure(yield* Fiber.await(execution))).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory), withCrypto))
  }

  it.effect("a cancellation between rounds refuses the next body when a caller follows the handoff later", () =>
    Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      let nextCalls = 0
      yield* engine.register(Round, ({ ordinal }) =>
        ordinal === 0 ? handoff(1) : Effect.sync(() => {
          nextCalls++
          return "forbidden"
        }))
      yield* engine.execute(Round, { executionId: "root", payload: { ordinal: 0 }, discard: true })
      let polled = yield* Round.poll("root")
      for (let attempt = 0; attempt < 40 && Option.isNone(polled); attempt++) {
        yield* Effect.yieldNow
        polled = yield* Round.poll("root")
      }
      expect(Option.getOrThrow(polled)._tag).toBe("Handoff")
      yield* Round.interrupt("root")
      const exit = yield* engine.execute(Round, { executionId: "root", payload: { ordinal: 0 } }).pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(nextCalls).toBe(0)
    }).pipe(Effect.scoped, Effect.provide(FlowEngine.layerMemory), withCrypto))
})
