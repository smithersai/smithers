import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { EventTypes } from "@smthrs/engine-store/EventTypes"
import * as Jj from "@smthrs/jj"
import { SqlJournal } from "@smthrs/journal"
import * as SqlConsensus from "@smthrs/journal/SqlConsensus"
import { RunStore } from "@smthrs/run-store"
import type { OwnerId } from "@smthrs/run-store/Ownership"
import { CacheStore } from "@smthrs/step-cache"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/sql/SqlClient"
import * as EffectHandlerRegistry from "../src/internal/EffectHandlerRegistry.ts"
import * as Rewind from "../src/internal/Rewind.ts"
import * as Migrations from "../src/Migrations.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"
import { TimeTravelStore } from "../src/TimeTravelStore.ts"

/**
 * The rewind fences over the real stores: `RunStore` over `SqlConsensus` and
 * the SQL time-travel store share one database, so a claim, a steal, and the
 * commit-time owner predicate all read the same rows. A double that ignores
 * the compare-and-swap snapshot or the archive fence cannot stand in here.
 */

const owner: OwnerId = { hostId: "time-travel:test", pid: 0, nonce: "rewind" }
const frame = { lineageId: "run/root", seq: 0 }
const frameState = JSON.stringify({ version: 1, flowName: "Demo", payload: { cursor: 1 } })
const laterState = JSON.stringify({ version: 1, flowName: "Demo", payload: { cursor: 9 } })
const database = Layer.provideMerge(Migrations.layer, TestDatabase.layer)
const persistence = SqlJournal.layer({ capacity: 16, overflow: "reject" }).pipe(Layer.provideMerge(database))

const seed = (sql: SqlClient.SqlClient, options: { readonly attachedChild?: boolean } = {}) =>
  Effect.gen(function*() {
    yield* sql`
      INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
      VALUES ('run', 'suspended', 0, ${laterState})
    `
    for (const [seq, state] of [[0, frameState], [1, laterState]] as const) {
      yield* sql`
        INSERT INTO flows_journal_events
          (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
        VALUES ('run', ${seq}, ${`event-${seq}`}, 'rewind', ${seq}, 0, ${EventTypes.runDecision},
                ${JSON.stringify({ state: JSON.parse(state) })}, ${JSON.stringify({ lineageId: frame.lineageId })})
      `
    }
    if (options.attachedChild === true) {
      yield* sql`
        INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
        VALUES ('child', 'suspended', 0, '{}')
      `
      yield* sql`
        INSERT INTO flows_journal_events
          (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
        VALUES ('child', 0, 'child-0', 'rewind', 0, 0, 'baseline', '{}', ${JSON.stringify({ lineageId: "child/root" })})
      `
      yield* sql`
        INSERT INTO flows_time_travel_edges (parent_run_id, parent_seq, child_run_id, kind, attached)
        VALUES ('run', 1, 'child', 'child', 1)
      `
    }
  })

/**
 * Takes `runId` from its current owner the way a peer engine does: a steal
 * against the exact row snapshot with same-host evidence that the owner's pid
 * is gone, then activation.
 */
const stealFrom = (runs: RunStore.Service, runId: string, thief: OwnerId) =>
  Effect.gen(function*() {
    const row = yield* runs.get(runId)
    const nowMs = yield* Clock.currentTimeMillis
    const expected = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const stolen = yield* runs.steal(runId, expected, thief, nowMs, {
      expectedOwner: row.owner!,
      checkedAtMs: nowMs,
      kind: "same-host-pid-dead"
    })
    if (stolen._tag !== "Claimed") return yield* Effect.die(`steal of ${runId} returned ${stolen._tag}`)
    const activated = yield* runs.activate(runId, thief, stolen.claimedAtMs, expected)
    if (activated._tag !== "Activated") return yield* Effect.die(`activation of ${runId} returned ${activated._tag}`)
  })

const provide = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  services: { readonly store: TimeTravelStore["Service"]; readonly runs: RunStore.Service }
) =>
  Effect.gen(function*() {
    const registry = yield* EffectHandlerRegistry.make()
    return yield* program.pipe(
      Effect.provideService(TimeTravelStore, services.store),
      Effect.provideService(RunStore.RunStore, services.runs),
      Effect.provideService(EffectHandlerRegistry.EffectHandlerRegistry, registry),
      Effect.provideService(Jj.Jj, Jj.makeNoop({})),
      Effect.provide(CacheStore.layerNoop())
    )
  })

const liveSeqs = (sql: SqlClient.SqlClient, runId: string) =>
  sql<{ readonly seq: number }>`SELECT seq FROM flows_journal_events WHERE run_id = ${runId} ORDER BY seq`.pipe(
    Effect.map((rows) => rows.map((row) => Number(row.seq)))
  )

const archivedCount = (sql: SqlClient.SqlClient) =>
  sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM flows_time_travel_archive`.pipe(
    Effect.map((rows) => Number(rows[0]!.n))
  )

describe("rewind fences over the SQL stores", () => {
  it.effect("refuses the commit with fence_lost when the parent is stolen between claim and commit", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* seed(sql)
      const store = yield* SqlTimeTravelStore.make
      const runs = yield* RunStore.make.pipe(Effect.provide(SqlConsensus.layer))
      const thief: OwnerId = { hostId: owner.hostId, pid: 1, nonce: "thief" }

      const failure = yield* Effect.flip(provide(
        Rewind.rewind({
          runId: "run",
          frame,
          owner,
          auditId: "audit",
          hooks: {
            beforeStep: (step) =>
              step === "archive-and-truncate" ? stealFrom(runs, "run", thief).pipe(Effect.orDie) : Effect.void
          }
        }),
        { store, runs }
      ))

      expect(failure.code).toBe("fence_lost")
      expect(failure.message).toContain("is no longer owned by")
      // Nothing was archived or truncated, and the thief still owns the run.
      expect(yield* liveSeqs(sql, "run")).toEqual([0, 1])
      expect(yield* archivedCount(sql)).toBe(0)
      expect(yield* runs.get("run")).toMatchObject({ status: "running", owner: thief, stateJson: laterState })
      // The restoration under the lost fence failed too, so the audit stays
      // open for recovery instead of claiming a clean rollback.
      expect(yield* store.pendingAudits()).toMatchObject([{ id: "audit", status: "in_progress" }])
    }).pipe(Effect.provide(persistence)))

  it.effect("refuses the commit with fence_lost when an attached child is re-owned before commit", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* seed(sql, { attachedChild: true })
      const store = yield* SqlTimeTravelStore.make
      const runs = yield* RunStore.make.pipe(Effect.provide(SqlConsensus.layer))
      const thief: OwnerId = { hostId: owner.hostId, pid: 1, nonce: "child-thief" }
      let childOwner: OwnerId | null = null

      const failure = yield* Effect.flip(provide(
        Rewind.rewind({
          runId: "run",
          frame,
          owner,
          auditId: "audit",
          detachedChildPolicy: "cancel",
          hooks: {
            beforeStep: (step) =>
              step === "archive-and-truncate"
                ? Effect.gen(function*() {
                  childOwner = (yield* runs.get("child")).owner
                  yield* stealFrom(runs, "child", thief)
                }).pipe(Effect.orDie)
                : Effect.void
          }
        }),
        { store, runs }
      ))

      // The rewind did claim the child before the commit; the steal displaced
      // that claim, and the archive's child fence refused the whole mutation.
      expect(childOwner).toEqual({ ...owner, nonce: "rewind:rewind-child:child" })
      expect(failure.code).toBe("fence_lost")
      expect(failure.message).toContain("attached child child is not owned by this rewind")
      expect(yield* liveSeqs(sql, "run")).toEqual([0, 1])
      expect(yield* liveSeqs(sql, "child")).toEqual([0])
      expect(yield* archivedCount(sql)).toBe(0)
      const edges = yield* sql`SELECT child_run_id FROM flows_time_travel_edges`
      expect(edges).toHaveLength(1)
      expect(yield* runs.get("child")).toMatchObject({ status: "running", owner: thief })
      // The parent was given back, but the child's restoration lost its fence,
      // so the audit stays open.
      expect(yield* runs.get("run")).toMatchObject({ status: "suspended", owner: null, stateJson: laterState })
      expect(yield* store.pendingAudits()).toMatchObject([{ id: "audit", status: "in_progress" }])
    }).pipe(Effect.provide(persistence)))

  it.effect("refuses a rewind whose row snapshot moved between its read and its claim", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* seed(sql)
      const store = yield* SqlTimeTravelStore.make
      const base = yield* RunStore.make.pipe(Effect.provide(SqlConsensus.layer))
      const peer: OwnerId = { hostId: "peer-host", pid: 7, nonce: "peer" }
      // Between the rewind's read and its claim a peer runs the row and gives
      // it back as pending: the claim columns are free and the status is claimable, so
      // only the snapshot comparison can tell the read is stale.
      let raced = false
      const runs: RunStore.Service = {
        ...base,
        claim: (runId, expected, claimant, nowMs) =>
          Effect.gen(function*() {
            if (!raced) {
              raced = true
              const outcome = yield* base.claimAndOwn(runId, expected, peer, nowMs)
              if (outcome._tag !== "Activated") return yield* Effect.die(`peer claim returned ${outcome._tag}`)
              const row = yield* base.get(runId)
              const parked = yield* base.transitionOwned(runId, peer, "pending", row.stateJson, {
                restorePending: true
              })
              if (parked._tag !== "Transitioned") return yield* Effect.die(`peer release returned ${parked._tag}`)
            }
            return yield* base.claim(runId, expected, claimant, nowMs)
          })
      }

      const failure = yield* Effect.flip(
        provide(Rewind.rewind({ runId: "run", frame, owner, auditId: "audit" }), { store, runs })
      )

      expect(raced).toBe(true)
      expect(failure).toMatchObject({ code: "busy", message: "run run lost the rewind claim" })
      expect(yield* liveSeqs(sql, "run")).toEqual([0, 1])
      expect(yield* archivedCount(sql)).toBe(0)
      expect(yield* store.pendingAudits()).toEqual([])
      expect(yield* runs.get("run")).toMatchObject({ status: "pending", owner: null, claim: null })
    }).pipe(Effect.provide(persistence)))

  it.effect("admits exactly one of two rewinds that both read the unowned row before either claims", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* seed(sql)
      const store = yield* SqlTimeTravelStore.make
      const base = yield* RunStore.make.pipe(Effect.provide(SqlConsensus.layer))
      // Both claims are held until both claimants have read the row, so they
      // carry the same unowned snapshot and only the store's serialized claim
      // can separate them.
      const bothRead = yield* Deferred.make<void>()
      const snapshots: Array<RunStore.RunSnapshot> = []
      const runs: RunStore.Service = {
        ...base,
        claim: (runId, expected, claimant, nowMs) =>
          Effect.gen(function*() {
            snapshots.push(expected)
            if (snapshots.length === 2) yield* Deferred.succeed(bothRead, undefined)
            yield* Deferred.await(bothRead)
            return yield* base.claim(runId, expected, claimant, nowMs)
          })
      }
      const rewindAs = (claimant: OwnerId, auditId: string) =>
        provide(Rewind.rewind({ runId: "run", frame, owner: claimant, auditId }), { store, runs }).pipe(Effect.exit)

      const [first, second] = yield* Effect.all([
        rewindAs({ hostId: "host-a", pid: 1, nonce: "a" }, "audit-a"),
        rewindAs({ hostId: "host-b", pid: 2, nonce: "b" }, "audit-b")
      ], { concurrency: 2 })

      expect(snapshots).toEqual([
        { status: "suspended", owner: null, heartbeatAtMs: null },
        { status: "suspended", owner: null, heartbeatAtMs: null }
      ])
      const exits = [first, second]
      const winners = exits.filter(Exit.isSuccess)
      const losers = exits.filter(Exit.isFailure)
      expect(winners).toHaveLength(1)
      expect(losers).toHaveLength(1)
      const loser = Exit.isFailure(losers[0]!) ? Cause.squash(losers[0]!.cause) : undefined
      expect(loser).toMatchObject({ code: "busy", message: "run run lost the rewind claim" })
      // The winner archived the suffix once; the loser left no audit.
      expect(yield* liveSeqs(sql, "run")).toEqual([0])
      expect(yield* archivedCount(sql)).toBe(1)
      const audits = yield* sql<{ readonly id: string; readonly status: string }>`
        SELECT id, status FROM flows_time_travel_audits
      `
      expect(audits).toHaveLength(1)
      expect(audits[0]!.status).toBe("completed")
      expect(yield* runs.get("run")).toMatchObject({ status: "suspended", owner: null, stateJson: frameState })
    }).pipe(Effect.provide(persistence)))
})
