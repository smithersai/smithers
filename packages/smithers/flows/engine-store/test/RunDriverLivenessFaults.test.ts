/** Liveness faults preserve a running SQL-backed flow and later cancellation. */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { SqlJournal } from "@smthrs/journal"
import { Node } from "@smthrs/plan"
import { Ownership, RunStore } from "@smthrs/run-store"
import { Clock, Deferred, Effect, Layer, Logger, Metric, Option, References, Schema } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStoreMetrics from "../src/EngineStoreMetrics.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const flow = Flow.make("RunDriverLivenessFaults/Hold", {
  payload: {},
  success: Schema.String,
  body: () => Node.succeed("done")
})
const owner: Ownership.OwnerId = { hostId: "liveness-faults", pid: 1, nonce: "owner" }
const stores = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer,
  DurableEngineState.layer
).pipe(
  Layer.provideMerge(TestStores.database)
)
const receiptCount = (outcome: "completed" | "skipped" | "failed") =>
  Metric.value(Metric.withAttributes(EngineStoreMetrics.heartbeatReceipts, { outcome })).pipe(
    Effect.map((value) => value.count)
  )

describe("SQL-backed driver liveness faults", () => {
  it.effect("retries a failed cancellation read and then acknowledges a remote cancellation", () =>
    withCrypto(
      Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        const engine = yield* FlowRuntime.FlowRuntime
        const started = yield* Deferred.make<void>()
        const readFailed = yield* Deferred.make<void>()
        const bodyEnded = yield* Deferred.make<void>()
        let armed = false
        let failures = 0
        let executions = 0
        const outage = new RunStore.RunStoreError({
          code: "persistence_failed",
          method: "get",
          message: "one cancellation-read outage",
          cause: undefined
        })
        const faulty: RunStore.Service = {
          ...runs,
          get: (runId) =>
            Effect.suspend(() => {
              if (!armed) return runs.get(runId)
              armed = false
              failures++
              return Deferred.succeed(readFailed, undefined).pipe(Effect.andThen(Effect.fail(outage)))
            })
        }
        const driver = yield* RunDriver.make({
          owner,
          journalSource: "cancel-read-outage",
          engine: Effect.succeed(engine),
          // Only the cancellation poll reads during the held body; this host
          // supplies wakeups rather than starting the unrelated process sweeps.
          sweep: { host: "cancel-read-outage" }
        }).pipe(Effect.provideService(RunStore.RunStore, faulty))
        yield* driver.register(flow, () =>
          Effect.gen(function*() {
            executions++
            armed = true
            yield* Deferred.succeed(started, undefined)
            return yield* Effect.never
          }).pipe(Effect.ensuring(Deferred.succeed(bodyEnded, undefined))))
        yield* driver.execute(flow, { executionId: "cancel-read-outage", payload: {}, discard: true })
        yield* Deferred.await(started)
        yield* TestClock.adjust(Ownership.heartbeatInterval)
        yield* Deferred.await(readFailed)
        expect(failures).toBe(1)
        expect(yield* runs.get("cancel-read-outage")).toMatchObject({
          status: "running",
          owner,
          cancelRequestedAtMs: null
        })
        // Another process records intent directly in the real store. The driver
        // must discover it on its next poll without an in-process interrupt.
        const requestedAtMs = yield* Clock.currentTimeMillis
        yield* runs.requestCancel("cancel-read-outage", requestedAtMs)
        yield* TestClock.adjust(Ownership.heartbeatInterval)
        const observedAtMs = yield* Clock.currentTimeMillis
        yield* Deferred.await(bodyEnded)
        yield* TestDatabase.until(runs.get("cancel-read-outage").pipe(Effect.map((row) => row.status === "cancelled")))
        expect(yield* runs.get("cancel-read-outage")).toMatchObject({
          status: "cancelled",
          owner: null,
          cancelRequestedAtMs: requestedAtMs
        })
        const sql = yield* SqlClient
        const rows = yield* sql<{ acknowledgement: string }>`
        SELECT cancel_acknowledgement_json AS acknowledgement FROM flows_runs WHERE run_id = 'cancel-read-outage'`
        expect(JSON.parse(rows[0]!.acknowledgement)).toEqual({ observedAtMs, owner })
        expect(executions).toBe(1)
        yield* TestDatabase.until(driver.active.pipe(Effect.map((active) => active.size === 0)))
        expect(yield* driver.active).toEqual(new Set())
      }).pipe(
        Effect.scoped,
        Effect.provide(stores),
        Effect.provide(FlowEngine.layerMemory)
      )
    ))

  it.effect("an interrupted heartbeat receipt stays quiet and releases the next pulse", () => {
    const warnings: Array<unknown> = []
    const capture = Logger.make((entry) => {
      // TestClock diagnostics carry no run annotation and are independent of
      // whether this driver's external receipt succeeded or was interrupted.
      if (
        entry.logLevel === "Warn" &&
        entry.fiber.getRef(References.CurrentLogAnnotations)["runId"] === "receipt-interruption"
      ) warnings.push(entry.message)
    })
    return withCrypto(
      Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        const engine = yield* FlowRuntime.FlowRuntime
        const started = yield* Deferred.make<void>()
        const interrupted = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let receipts = 0
        let executions = 0
        const before = yield* Effect.all({
          completed: receiptCount("completed"),
          skipped: receiptCount("skipped"),
          failed: receiptCount("failed")
        })
        const driver = yield* RunDriver.make({
          owner,
          journalSource: "receipt-interruption",
          engine: Effect.succeed(engine)
        })
        yield* driver.register(flow, () =>
          Effect.gen(function*() {
            executions++
            const instance = yield* FlowRuntime.FlowInstance
            instance.heartbeat = Effect.suspend(() => {
              receipts++
              return receipts === 1
                ? Effect.interrupt.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined)))
                : Effect.void
            })
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(release)
            return "done"
          }))
        yield* driver.execute(flow, { executionId: "receipt-interruption", payload: {}, discard: true })
        yield* Deferred.await(started)
        const first = yield* runs.get("receipt-interruption")
        yield* TestClock.adjust(Ownership.heartbeatInterval)
        yield* Deferred.await(interrupted)
        yield* TestClock.adjust(Ownership.heartbeatInterval)
        yield* TestDatabase.until(receiptCount("completed").pipe(Effect.map((count) => count === before.completed + 1)))
        expect(receipts).toBe(2)
        expect(yield* receiptCount("skipped")).toBe(before.skipped)
        expect(yield* receiptCount("failed")).toBe(before.failed)
        expect(warnings).toEqual([])
        const renewed = yield* runs.get("receipt-interruption")
        expect(renewed.status).toBe("running")
        expect(renewed.owner).toEqual(owner)
        expect(renewed.heartbeatAtMs).toBeGreaterThan(first.heartbeatAtMs!)
        yield* Deferred.succeed(release, undefined)
        yield* TestDatabase.until(
          runs.get("receipt-interruption").pipe(Effect.map((row) => row.status === "completed"))
        )
        expect(Option.getOrThrow(yield* driver.poll(flow, "receipt-interruption"))).toMatchObject({
          _tag: "Complete",
          exit: { _tag: "Success", value: "done" }
        })
        yield* TestClock.adjust(Ownership.heartbeatInterval)
        expect(receipts).toBe(2)
        expect(executions).toBe(1)
      }).pipe(
        Effect.scoped,
        Effect.provide(stores),
        Effect.provide(FlowEngine.layerMemory),
        Effect.provide(Logger.layer([capture]))
      )
    )
  })
})
