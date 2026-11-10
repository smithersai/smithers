/** A queued timer must sleep until its persisted deadline, not a stale relative delay. */
import { expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { DurableClock, Flow } from "@smthrs/flow"
import { Journal, SqlJournal } from "@smthrs/journal"
import { Node } from "@smthrs/plan"
import { RunStore } from "@smthrs/run-store"
import { Clock, Duration, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.vibe"
import * as DeferredPersistence from "../src/internal/DeferredPersistence.vibe"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const services = Layer.mergeAll(
  SqlJournal.layer({ capacity: 256, overflow: "reject" }),
  RunStore.layer,
  DurableEngineState.layer
).pipe(Layer.provideMerge(TestStores.database))

it.effect("arms a queued clock against its absolute deadline after the caller's clock advances", () =>
  withCrypto(
    Effect.gen(function*() {
      const runId = "late-clock-arm"
      const owner = { hostId: "late-clock", pid: 7, nonce: "owner" }
      const flow = Flow.make("LateClockArm", {
        payload: {},
        success: Schema.Void,
        body: Node.capture({}, () => Node.succeed(undefined))
      })
      const runs = yield* RunStore.RunStore
      yield* runs.create(runId, "{}")
      expect(yield* runs.claimAndOwn(runId, yield* runs.get(runId), owner, 0)).toEqual({ _tag: "Activated" })
      const base = yield* Clock.Clock
      const caller = yield* Effect.withFiber((fiber) => Effect.succeed(fiber.id))
      const journal = yield* Journal.Journal
      const sql = yield* SqlClient
      const sleeps: number[] = []
      const resumed: string[] = []
      let flushed = false
      let arming = true
      let moved = false
      const clock: Clock.Clock = {
        currentTimeMillisUnsafe: () => base.currentTimeMillisUnsafe(),
        currentTimeNanosUnsafe: () => base.currentTimeNanosUnsafe(),
        monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
        currentTimeNanos: base.currentTimeNanos,
        monotonicTimeNanos: base.monotonicTimeNanos,
        currentTimeMillis: Effect.gen(function*() {
          const sampled = yield* base.currentTimeMillis
          const fiber = yield* Effect.withFiber((fiber) => Effect.succeed(fiber.id))
          // Simulate the registering fiber being delayed after its clock read.
          // SQL and the journal have already committed the absolute deadline.
          if (arming && flushed && fiber === caller && !moved) {
            moved = true
            yield* TestClock.adjust(3_000).pipe(Effect.provideService(Clock.Clock, base))
          }
          return sampled
        }),
        sleep: (duration) =>
          Effect.gen(function*() {
            sleeps.push((yield* base.currentTimeMillis) + Duration.toMillis(duration))
            yield* base.sleep(duration)
          })
      }
      yield* Effect.gen(function*() {
        const persistence = yield* DeferredPersistence.make({
          owner,
          journalSource: "late-clock-arm",
          scheduleResume: (_flow, id) => Effect.sync(() => void resumed.push(id))
        })
        yield* persistence.scheduleClock(flow, {
          executionId: runId,
          clock: DurableClock.make({ name: "due", duration: "3 seconds" })
        })
        arming = false
        yield* TestDatabase.until(Effect.sync(() => sleeps.length > 0))
        expect(sleeps).toEqual([3_000])
        yield* TestClock.adjust(3_000 - (yield* base.currentTimeMillis)).pipe(
          Effect.provideService(Clock.Clock, base)
        )
        yield* TestDatabase.until(Effect.sync(() => resumed.length > 0))
        expect(resumed).toEqual([runId])
        const [row] = yield* sql<{ due: number | string; completed: number | string | null }>`
        SELECT due_at_ms AS due, completed_at_ms AS completed FROM flows_clock_deadlines
        WHERE execution_id = ${runId}`
        expect({ due: Number(row?.due), completed: row?.completed === null ? null : Number(row?.completed) })
          .toEqual({ due: 3_000, completed: 3_000 })
      }).pipe(
        Effect.provideService(Clock.Clock, clock),
        Effect.provideService(Journal.Journal, {
          ...journal,
          flush: journal.flush.pipe(Effect.tap(() =>
            Effect.sync(() => {
              flushed = true
            })
          ))
        })
      )
    }).pipe(Effect.scoped, Effect.provide(services), Effect.provide(TestClock.layer()))
  ))
