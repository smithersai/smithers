import { expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Journal, JournalEvent, SqlConsensus, SqlJournal } from "@smthrs/journal"
import { NodeHost } from "@smthrs/platform-node"
import { AttemptStore, Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import { Deferred, Effect, Fiber, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as Migrations from "../src/Migrations.vibe"
import * as StepBoundary from "../src/StepBoundary.ts"
import { withCrypto } from "./Sha256.ts"

const stores = Layer.mergeAll(
  RunStore.layerWith,
  AttemptStore.layer,
  CacheStore.layer,
  SqlJournal.layerWith({ capacity: 1024, overflow: "reject" })
).pipe(
  Layer.provide(SqlConsensus.layer),
  Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer))
)

it.live("journal progress moves the feed during one unsettled action, bounded to one bump per two seconds", () =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const runs = yield* RunStore.RunStore
    const journal = yield* Journal.Journal
    const owner: Ownership.OwnerId = { hostId: "progress", pid: 1, nonce: "progress" }
    const runId = "progress"
    yield* runs.create(runId, "{}")
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const claim = yield* runs.claim(runId, snapshot, owner, 1)
    expect(claim._tag).toBe("Claimed")
    if (claim._tag !== "Claimed") return
    yield* runs.activate(runId, owner, claim.claimedAtMs, snapshot)
    const started = yield* Deferred.make<void>()
    const advance = yield* Deferred.make<void>()
    const ready = yield* Deferred.make<void>()
    const finish = yield* Deferred.make<void>()
    const enqueue = (n: number) =>
      journal.emitLossy(
        new JournalEvent.Input({
          runId: JournalEvent.RunId.make(runId),
          sourceId: JournalEvent.SourceId.make("agent/trail"),
          eventType: "agent.turn",
          payload: { n }
        })
      )
    const emit = (n: number) => enqueue(n).pipe(Effect.andThen(journal.flush))
    const action = yield* Effect.forkChild(
      ActionPersistence.make({
        runId,
        owner,
        sourceId: "progress",
        execute: () =>
          Effect.gen(function*() {
            yield* emit(0)
            yield* Deferred.succeed(started, undefined)
            yield* Deferred.await(advance)
            yield* emit(1)
            yield* Deferred.succeed(ready, undefined)
            yield* Deferred.await(finish)
            return "done"
          })
      })({ action: {}, key: "progress/implement", attempt: 1, tier: "irreversible" })
    )
    yield* Deferred.await(started)
    const revision = () =>
      sql<{ revision: number }>`SELECT revision FROM flows_run_changes WHERE run_id = ${runId}`.pipe(
        Effect.map((rows) => Number(rows[0]!.revision))
      )
    // Capture the baseline before releasing the next emission. Database eligibility is controlled explicitly,
    // so a slow read cannot consume the change the assertion is meant to observe.
    yield* sql`UPDATE flows_runs SET progress_at_ms = 1 WHERE run_id = ${runId}`
    const before = yield* revision()
    yield* Deferred.succeed(advance, undefined)
    yield* Deferred.await(ready)
    const during = yield* revision()
    expect(during).toBeGreaterThan(before)
    // Keep the suppression window open even if PostgreSQL writes take >2 s.
    yield* sql`UPDATE flows_runs SET progress_at_ms = 9007199254740991 WHERE run_id = ${runId}`
    const throttled = yield* revision()
    for (let n = 2; n <= 10; n++) yield* enqueue(n)
    yield* journal.flush
    expect(yield* revision()).toBe(throttled)
    const attempts = yield* sql<{ event_type: string }>`SELECT event_type FROM flows_journal_events
      WHERE run_id = ${runId} AND event_type LIKE 'flows.engine.attempt-%'`
    expect(attempts).toHaveLength(1)
    expect(yield* sql`SELECT state FROM flows_attempts WHERE run_id = ${runId}`).toEqual([{ state: "running" }])
    expect(yield* sql`SELECT * FROM flows_journal_events WHERE event_type = 'agent.turn'`).toHaveLength(11)
    yield* sql`UPDATE flows_runs SET progress_at_ms = 1 WHERE run_id = ${runId}`
    const eligible = yield* revision()
    yield* emit(11)
    expect(yield* revision()).toBe(eligible + 1)
    yield* Deferred.succeed(finish, undefined)
    const settled = yield* Fiber.await(action)
    expect(yield* sql`SELECT status, owner_nonce FROM flows_runs WHERE run_id = ${runId}`).toEqual([
      { status: "running", owner_nonce: owner.nonce }
    ])
    expect(yield* sql`SELECT state FROM flows_attempts WHERE run_id = ${runId}`).toEqual([{ state: "succeeded" }])
    expect(settled).toMatchObject({ _tag: "Success", value: "done" })
  }).pipe(
    Effect.provide(
      Layer.mergeAll(stores, NodeHost.layer, StepBoundary.layerUnsupported)
    ),
    Effect.scoped,
    withCrypto
  ))
