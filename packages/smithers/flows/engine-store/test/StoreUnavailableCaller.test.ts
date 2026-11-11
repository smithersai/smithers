/**
 * A store that cannot record a step's attempt does not decide the step: the
 * dispatch interrupts itself and releases the run, its attempt left for a
 * later drive to adopt (`EngineStore.persistAction`). The outermost caller
 * waiting in `execute` was not cancelled, so it reads a typed
 * `FlowRuntime.StoreUnavailable`; the run is not cancelled either, and the next
 * `execute` of the same execution id, once the store is back, settles it.
 */
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as EngineStore from "../src/EngineStore.ts"
import { EventTypes } from "../src/EventTypes.ts"
import * as StepBoundary from "../src/StepBoundary.vibe"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const jj = Jj.layerNoop({})

const Answer = Action.make("StoreUnavailable/Answer", {
  payload: {},
  success: Schema.String,
  idempotencyKey: "store-unavailable-answer",
  implementationVersion: "v1"
})
const Ask = Flow.make("StoreUnavailable/Ask", { payload: {}, success: Schema.String, body: () => Answer.call({}) })
const Forward = Action.make("StoreUnavailable/Forward", { payload: {}, success: Schema.String })
const Delegate = Flow.make("StoreUnavailable/Delegate", {
  payload: {},
  success: Schema.String,
  body: () => Forward.call({})
})

/** The engine over SQLite, with faulty attempt and lifecycle journal services while `world.down`. */
const engineOf = (
  world: { down: boolean; finish?: boolean; journal?: boolean; ran: number; answer: Effect.Effect<string> }
) => {
  const faulty = Layer.effect(
    AttemptStore.AttemptStore,
    Effect.map(AttemptStore.AttemptStore, (store) => ({
      ...store,
      put: (attempt: AttemptStore.Attempt, owner: Ownership.OwnerId) =>
        Effect.suspend(() =>
          world.down && !world.finish && !world.journal && attempt.runId !== "delegate"
            ? Effect.fail(
              new AttemptStore.AttemptStoreError({ code: "persistence_failed", method: "put", message: "store down" })
            )
            : store.put(attempt, owner)
        ),
      finish: (...args: Parameters<typeof store.finish>) =>
        Effect.suspend(() =>
          world.down && world.finish
            ? Effect.fail(
              new AttemptStore.AttemptStoreError({
                code: "persistence_failed",
                method: "finish",
                message: "store down"
              })
            )
            : store.finish(...args)
        )
    }))
  )
  const faultyJournal = Layer.effect(
    Journal.Journal,
    Effect.map(Journal.Journal, (journal) => ({
      ...journal,
      emitDurable: (input: Parameters<typeof journal.emitDurable>[0], owner: Ownership.OwnerId) =>
        Effect.suspend(() =>
          world.down && world.journal && input.eventType === EventTypes.attemptStarted
            ? Effect.fail(new Journal.JournalError({ code: "sink_failed", message: "journal down" }))
            : journal.emitDurable(input, owner)
        )
    }))
  )
  return Layer.mergeAll(Interpreter.layer(Ask), Interpreter.layer(Delegate)).pipe(
    Layer.provideMerge(
      Forward.toLayer(() => Ask.execute({}, { executionId: "delegated-ask" }).pipe(Effect.orDie)).pipe(
        Layer.provideMerge(Answer.toLayer(
          () => Effect.suspend(() => (world.ran++, world.answer)),
          { implementationVersion: "v1" }
        ))
      )
    ),
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(
      EngineStore.layer({ owner: { hostId: "unavailable" }, journalSource: "unavailable-engine" }).pipe(
        Layer.provideMerge(
          Layer.provideMerge(
            faulty,
            Layer.provideMerge(
              faultyJournal,
              Layer.mergeAll(TestStores.layerAt(":memory:"), StepBoundary.layerUnsupported, jj)
            )
          )
        )
      )
    )
  )
}

const run = <A, E>(
  world: Parameters<typeof engineOf>[0],
  program: Effect.Effect<A, E, Layer.Success<ReturnType<typeof engineOf>>>
) => Effect.runPromise(withCrypto(Effect.scoped(program.pipe(Effect.provide(engineOf(world))))) as Effect.Effect<A, E>)

describe("a store that cannot record a step's attempt", () => {
  it("answers the caller StoreUnavailable and releases the run; the next execute, with the store back, settles it", async () => {
    const world = { down: true, ran: 0, answer: Effect.succeed("answered") }
    const observed = await run(
      world,
      Effect.gen(function*() {
        const runtime = yield* FlowRuntime.FlowRuntime
        const first = yield* Effect.exit(runtime.execute(Ask, { executionId: "ask", payload: {} }))
        const released = yield* (yield* RunStore.RunStore).get("ask")
        world.down = false
        const second = yield* Effect.exit(runtime.execute(Ask, { executionId: "ask", payload: {} }))
        return { first, released, second }
      })
    )
    expect(observed.first).toEqual(Exit.fail(new FlowRuntime.StoreUnavailable({ executionId: "ask" })))
    expect(observed.released).toMatchObject({ status: "suspended", owner: null, cancelRequestedAtMs: null })
    expect(observed.second).toEqual(Exit.succeed("answered"))
    expect(world.ran).toBe(1)
  })

  it("answers unavailable when the step journal cannot commit, then records the same execution after recovery", async () => {
    const world = { down: true, journal: true, ran: 0, answer: Effect.succeed("journal recovered") }
    const observed = await run(
      world,
      Effect.gen(function*() {
        const runtime = yield* FlowRuntime.FlowRuntime
        const first = yield* Effect.exit(runtime.execute(Ask, { executionId: "journal", payload: {} }))
        const released = yield* (yield* RunStore.RunStore).get("journal")
        const attempts = yield* (yield* AttemptStore.AttemptStore).listRun!("journal")
        world.down = false
        const second = yield* runtime.execute(Ask, { executionId: "journal", payload: {} })
        return { first, released, attempts, second }
      })
    )
    expect(observed.first).toEqual(Exit.fail(new FlowRuntime.StoreUnavailable({ executionId: "journal" })))
    expect(observed.released).toMatchObject({ status: "suspended", owner: null, cancelRequestedAtMs: null })
    expect(observed.attempts).toHaveLength(0)
    expect(observed.second).toBe("journal recovered")
    expect(world.ran).toBe(1)
  })

  it("answers unavailable when the result cannot be recorded, then adopts the unfinished keyed attempt", async () => {
    const world = { down: true, finish: true, ran: 0, answer: Effect.succeed("answered") }
    const observed = await run(
      world,
      Effect.gen(function*() {
        const runtime = yield* FlowRuntime.FlowRuntime
        const first = yield* Effect.exit(runtime.execute(Ask, { executionId: "finish", payload: {} }))
        const attempts = yield* (yield* AttemptStore.AttemptStore).listRun!("finish")
        const ranBeforeRecovery = world.ran
        world.down = false
        const second = yield* runtime.execute(Ask, { executionId: "finish", payload: {} })
        return { first, attempts, ranBeforeRecovery, second }
      })
    )
    expect(observed.first).toEqual(Exit.fail(new FlowRuntime.StoreUnavailable({ executionId: "finish" })))
    expect(observed.attempts).toHaveLength(1)
    expect(observed.attempts[0]!.state).toBe("running")
    expect(observed.ranBeforeRecovery).toBe(1)
    expect(observed.second).toBe("answered")
    expect(world.ran).toBe(2)
  })

  it("answers the outermost caller when a child flow's step cannot be recorded", async () => {
    const world = { down: true, ran: 0, answer: Effect.succeed("delegated") }
    const observed = await run(
      world,
      Effect.gen(function*() {
        const runtime = yield* FlowRuntime.FlowRuntime
        const first = yield* Effect.exit(runtime.execute(Delegate, { executionId: "delegate", payload: {} }))
        world.down = false
        const second = yield* Effect.exit(runtime.execute(Delegate, { executionId: "delegate", payload: {} }))
        return { first, second }
      })
    )
    expect(observed.first).toEqual(Exit.fail(new FlowRuntime.StoreUnavailable({ executionId: "delegate" })))
    expect(observed.second).toEqual(Exit.succeed("delegated"))
    expect(world.ran).toBe(1)
  })

  it("answers every caller joining the same drive with the typed failure", async () => {
    const world = { down: true, ran: 0, answer: Effect.succeed("answered") }
    const exits = await run(
      world,
      Effect.gen(function*() {
        const runtime = yield* FlowRuntime.FlowRuntime
        return yield* Effect.all(
          Array.from({ length: 8 }, () => Effect.exit(runtime.execute(Ask, { executionId: "shared", payload: {} }))),
          { concurrency: "unbounded" }
        )
      })
    )
    expect(exits).toHaveLength(8)
    for (const exit of exits) {
      expect(exit).toEqual(Exit.fail(new FlowRuntime.StoreUnavailable({ executionId: "shared" })))
    }
    expect(world.ran).toBe(0)
  })

  it("keeps a step's own interruption an interruption and releases its run", async () => {
    const world = { down: false, ran: 0, answer: Effect.interrupt }
    const observed = await run(
      world,
      Effect.gen(function*() {
        const runtime = yield* FlowRuntime.FlowRuntime
        const exit = yield* Effect.exit(runtime.execute(Ask, { executionId: "interrupted-step", payload: {} }))
        const released = yield* (yield* RunStore.RunStore).get("interrupted-step")
        return { exit, released }
      })
    )
    expect(Exit.isFailure(observed.exit) && Cause.hasInterruptsOnly(observed.exit.cause)).toBe(true)
    expect(observed.released).toMatchObject({ status: "suspended", owner: null, cancelRequestedAtMs: null })
    expect(world.ran).toBe(1)
  })

  it("keeps an interruption of the caller's own fiber an interruption", async () => {
    const started = Deferred.makeUnsafe<void>()
    const world = {
      down: false,
      ran: 0,
      answer: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
    }
    const exit = await run(
      world,
      Effect.gen(function*() {
        const runtime = yield* FlowRuntime.FlowRuntime
        const fiber = yield* Effect.forkChild(runtime.execute(Ask, { executionId: "held", payload: {} }))
        yield* Deferred.await(started)
        return yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)))
      })
    )
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  })
})
