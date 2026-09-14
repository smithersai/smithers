import { afterAll, expect, it } from "@effect/vitest"
import { Action, DurableDeferred, Flow, Interpreter } from "@smthrs/flow"
import { EventTypes } from "@smthrs/engine-store"
import { Journal, JournalEvent } from "@smthrs/journal"
import { RunStore } from "@smthrs/run-store"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { durableEngine, requirements } from "../src/durable-layer.ts"
import { parkRun } from "../src/park-run.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-park-run-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const Gate = Action.make("examples/ParkRun/Gate", { payload: {}, success: Schema.String })
const Answer = DurableDeferred.make("examples/ParkRun/Answer", { success: Schema.String })
const delayedRunId = "delayed-test" as JournalEvent.RunId
const Waiting = Flow.make("examples/ParkRun/Waiting", {
  payload: {},
  success: Schema.String,
  body: () => Gate.call({})
})

it.effect("waits for the durable park, joins the caller, and preserves resumability", () =>
  Effect.gen(function*() {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const stopped = yield* Deferred.make<void>()
    const stack = Layer.mergeAll(
      Gate.toLayer(() => Effect.gen(function*() {
        yield* Deferred.succeed(entered, undefined)
        yield* Deferred.await(release)
        return yield* DurableDeferred.await(Answer)
      })),
      Interpreter.layer(Waiting)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(durableEngine(join(directory, "park.sqlite"), "park-test"))
    )
    yield* Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const parked = yield* parkRun("park-test", Waiting.execute({}, { executionId: "park-test" }).pipe(
        Effect.ensuring(Deferred.succeed(stopped, undefined))
      ), stack).pipe(Effect.forkScoped)
      yield* Effect.raceFirst(Deferred.await(entered), Fiber.join(parked))
      expect((yield* store.get("park-test")).status).toBe("running")
      expect(parked.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(parked)
      expect(yield* Deferred.isDone(stopped)).toBe(true)
      const row = yield* store.get("park-test")
      expect(row.status).toBe("suspended")
      expect(row.cancelRequestedAtMs).toBeNull()

      const resumed = yield* Effect.gen(function*() {
        yield* DurableDeferred.succeed(Answer, {
          token: DurableDeferred.tokenFromExecutionId(Answer, { flow: Waiting, executionId: "park-test" }),
          value: "resumed"
        })
        return yield* Waiting.execute({}, { executionId: "park-test" })
      }).pipe(Effect.provide(stack))
      expect(resumed).toBe("resumed")
      expect((yield* store.get("park-test")).status).toBe("completed")
    }).pipe(Effect.provide(requirements(join(directory, "park.sqlite"))), Effect.scoped)
  }))

it.live("quiesces a retry admitted before suspension observation", () =>
  Effect.gen(function*() {
    const secondEntered = yield* Deferred.make<void>()
    const releaseSecond = yield* Deferred.make<void>()
    const stopped = yield* Deferred.make<void>()
    const cleanupEntered = yield* Deferred.make<void>()
    const releaseCleanup = yield* Deferred.make<void>()
    const secondStopped = yield* Deferred.make<void>()
    const parkReturned = yield* Deferred.make<void>()
    let attempts = 0
    let held = false
    const stack = Layer.mergeAll(
      Gate.toLayer(() => Effect.gen(function*() {
        attempts++
        if (attempts === 2) {
          yield* Deferred.succeed(secondEntered, undefined)
          yield* Deferred.await(releaseSecond).pipe(Effect.ensuring(Effect.gen(function*() {
            yield* Deferred.succeed(cleanupEntered, undefined)
            yield* Deferred.await(releaseCleanup)
            yield* Deferred.succeed(secondStopped, undefined)
          })))
        }
        return yield* DurableDeferred.await(Answer)
      })),
      Interpreter.layer(Waiting)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(durableEngine(join(directory, "delayed.sqlite"), "delayed-test"))
    )
    // Only the observer sees delayed delivery. The engine still commits real
    // SQLite events and uses its unchanged default automatic retry policy.
    const observed = Layer.effect(Journal.Journal, Effect.gen(function*() {
      const journal = yield* Journal.Journal
      const isSuspension = (entry: JournalEvent.Entry) =>
        entry.eventType === EventTypes.runDecision &&
        Schema.is(Schema.Struct({ decision: Schema.Literal("transitioned"), status: Schema.Literal("suspended") }))(entry.payload)
      return Journal.make({
        ...journal,
        stream: options => journal.stream(options).pipe(Stream.mapEffect(entry => Effect.gen(function*() {
          if (!held && isSuspension(entry)) {
            held = true
            yield* Deferred.await(secondEntered)
          }
          return entry
        })))
      })
    })).pipe(Layer.provideMerge(stack))
    yield* Effect.gen(function*() {
      const journal = yield* Journal.Journal
      const store = yield* RunStore.RunStore
      const parked = yield* parkRun("delayed-test", Waiting.execute({}, { executionId: "delayed-test" }).pipe(
        Effect.ensuring(Deferred.succeed(stopped, undefined))
      ), observed).pipe(
        Effect.ensuring(Deferred.succeed(parkReturned, undefined)),
        Effect.forkScoped
      )
      // A caller-finalizer assertion alone missed the defect. Wait until either
      // engine cleanup begins or the helper returns, then require the former.
      yield* Effect.raceFirst(Deferred.await(cleanupEntered), Deferred.await(parkReturned))
      expect(yield* Deferred.isDone(stopped)).toBe(true)
      expect(yield* Deferred.isDone(cleanupEntered)).toBe(true)
      expect(yield* Deferred.isDone(parkReturned)).toBe(false)
      expect(parked.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(releaseCleanup, undefined)
      yield* Fiber.join(parked)
      expect(yield* Deferred.isDone(secondStopped)).toBe(true)
      expect(attempts).toBe(2)
      const row = yield* store.get("delayed-test")
      const before = yield* journal.entries({ runId: delayedRunId, limit: 1000 })
      const tailAtReturn = before.entries.at(-1)!.seq
      // Releasing the exact action barrier that moved the old journal cannot
      // restart a joined drive. No sleep or absence-of-notification timeout is
      // needed: both the action finalizer and the engine scope have completed.
      yield* Deferred.succeed(releaseSecond, undefined)
      yield* journal.flush
      const after = yield* journal.entries({ runId: delayedRunId, limit: 1000 })
      const evidence = {
        attempts, callerStopped: yield* Deferred.isDone(stopped), statusAtParkReturn: row.status,
        cancelRequestedAtMs: row.cancelRequestedAtMs, tailAtReturn, tailAfterReturn: after.entries.at(-1)!.seq
      }
      console.log(JSON.stringify(evidence))
      expect(evidence.statusAtParkReturn).toBe("suspended")
      expect(evidence.cancelRequestedAtMs).toBeNull()
      expect(evidence.tailAfterReturn).toBe(tailAtReturn)
      const resumed = yield* Effect.gen(function*() {
        yield* DurableDeferred.succeed(Answer, {
          token: DurableDeferred.tokenFromExecutionId(Answer, { flow: Waiting, executionId: "delayed-test" }),
          value: "resumed after retry shutdown"
        })
        return yield* Waiting.execute({}, { executionId: "delayed-test" })
      }).pipe(Effect.provide(stack))
      expect(resumed).toBe("resumed after retry shutdown")
      expect((yield* store.get("delayed-test")).status).toBe("completed")
    }).pipe(
      Effect.ensuring(Deferred.succeed(releaseCleanup, undefined)),
      Effect.provide(requirements(join(directory, "delayed.sqlite"))),
      Effect.scoped
    )
  }))
