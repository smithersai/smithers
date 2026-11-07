import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { Journal } from "../src/Journal.ts"
import { Input, type RunId, type Seq, type SourceId } from "../src/JournalEvent.vibe"
import * as Migrations from "../src/Migrations.vibe"
import * as Projection from "../src/Projection.vibe"
import * as SqlJournal from "../src/SqlJournal.ts"

const runId = (value: string): RunId => value as RunId
const sourceId = (value: string): SourceId => value as SourceId

const effect = <E>(name: string, body: () => Effect.Effect<void, E>) => it.effect(name, () => body())

const input = (
  run: RunId,
  source: SourceId,
  eventType: string,
  payload: unknown
): Input =>
  new Input({
    runId: run,
    sourceId: source,
    eventType,
    payload
  }, { disableChecks: true })

const database = Layer.provideMerge(Migrations.layer, TestDatabase.layer)
const journalLayer = SqlJournal.layer({
  capacity: 32,
  overflow: "reject",
  batchSize: 4
}).pipe(Layer.provide(database))

const runJournal = <A, E>(effect: Effect.Effect<A, E, Journal>) =>
  effect.pipe(
    Effect.provide(journalLayer),
    Effect.scoped
  )

const sumProjection = Projection.make({
  name: "sum",
  initial: 0,
  reduce: (state: number, entry) =>
    Effect.succeed(
      state + (entry.payload as { readonly value: number }).value
    )
})

describe("Projection", () => {
  effect("replays deterministically to identical state", () => {
    const run = runId("deterministic")

    return runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        yield* Effect.forEach(
          [1, 2, 3],
          (value) =>
            journal.emitLossy(
              input(run, sourceId("producer"), "number", { value })
            ),
          { discard: true }
        )
        yield* journal.flush

        const replay = () =>
          journal.project(sumProjection, { runId: run }).pipe(
            Stream.take(4),
            Stream.runCollect
          )
        const first = yield* replay()
        const second = yield* replay()
        expect(first).toEqual([0, 1, 3, 6])
        expect(second).toEqual(first)

        // Resuming from a cursor folds only the entries after it.
        const resumed = yield* journal.project(sumProjection, { runId: run, afterSequence: 1 as Seq }).pipe(
          Stream.take(2),
          Stream.runCollect
        )
        expect(resumed).toEqual([0, 3])
      })
    )
  })

  effect("folds live entries incrementally", () => {
    const run = runId("live-projection")

    return runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const states = yield* journal.project(sumProjection, { runId: run }).pipe(
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        yield* journal.emitLossy(
          input(run, sourceId("producer"), "number", { value: 2 })
        )
        yield* journal.emitLossy(
          input(run, sourceId("producer"), "number", { value: 5 })
        )
        yield* journal.flush

        expect(yield* Fiber.join(states)).toEqual([0, 2, 7])
      })
    )
  })

  effect("isolates reducer failure from emitters and persistence", () => {
    const run = runId("projection-failure")
    const failing = Projection.make({
      name: "failing",
      initial: 0,
      reduce: () => Effect.fail("reducer failed")
    })

    return runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        yield* journal.emitLossy(
          input(run, sourceId("producer"), "number", { value: 1 })
        )
        yield* journal.flush

        const failure = yield* journal.project(failing, { runId: run }).pipe(
          Stream.runDrain,
          Effect.flip
        )
        expect(failure.code).toBe("projection_failed")

        const later = yield* journal.emitLossy(
          input(run, sourceId("producer"), "number", { value: 2 })
        )
        expect(later).toMatchObject({ _tag: "Accepted", sourceSeq: 1 })
        yield* journal.flush
        const page = yield* journal.entries({ runId: run, limit: 10 })
        expect(page.entries.map((entry) => ({
          payload: entry.payload,
          sourceSeq: entry.sourceSeq
        }))).toEqual([
          { payload: { value: 1 }, sourceSeq: 0 },
          { payload: { value: 2 }, sourceSeq: 1 }
        ])
      })
    )
  })

  effect("interrupts a live projection consumer cleanly", () => {
    const run = runId("projection-interrupt")

    return runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        const consumer = yield* journal.project(sumProjection, { runId: run }).pipe(
          Stream.runDrain,
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        yield* Fiber.interrupt(consumer)
        const exit = yield* Fiber.await(consumer)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        }
      })
    )
  })

  effect("preserves interruption while a reducer is running", () => {
    const run = runId("projection-reducer-interrupt")
    return runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        yield* journal.emitLossy(
          input(run, sourceId("producer"), "number", { value: 1 })
        )
        yield* journal.flush
        const reducing = yield* Deferred.make<void>()
        const projection = Projection.make({
          name: "interrupting",
          initial: 0,
          reduce: () => Deferred.succeed(reducing, undefined).pipe(Effect.andThen(Effect.never))
        })
        const consumer = yield* journal.project(projection, { runId: run }).pipe(
          Stream.runDrain,
          Effect.forkChild({ startImmediately: true })
        )
        yield* Deferred.await(reducing)
        yield* Fiber.interrupt(consumer)
        const exit = yield* Fiber.await(consumer)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      })
    )
  })

  effect("passes through an interruption cause raised by a reducer", () => {
    const run = runId("projection-reducer-interrupt-cause")
    return runJournal(
      Effect.gen(function*() {
        const journal = yield* Journal
        yield* journal.emitLossy(
          input(run, sourceId("producer"), "number", { value: 1 })
        )
        yield* journal.flush
        const projection = Projection.make({
          name: "interrupt-cause",
          initial: 0,
          reduce: () => Effect.failCause(Cause.interrupt())
        })
        const exit = yield* journal.project(projection, { runId: run }).pipe(
          Stream.runDrain,
          Effect.exit
        )
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      })
    )
  })
})
