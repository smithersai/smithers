import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as NodeJj from "@smthrs/jj/node/NodeJj"
import * as Journal from "@smthrs/journal/Journal"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/sql/SqlClient"
import * as EffectHandlerRegistry from "../src/internal/EffectHandlerRegistry.ts"
import * as Recovery from "../src/internal/Recovery.ts"
import * as Rewind from "../src/internal/Rewind.ts"
import * as Memory from "../src/MemoryTimeTravelStore.ts"
import * as Migrations from "../src/Migrations.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"
import { error } from "../src/TimeTravelError.vibe"
import { TimeTravelStore } from "../src/TimeTravelStore.ts"

const owner = { hostId: "generation-evidence", pid: 0, nonce: "generation-evidence" } as const
const frame = { lineageId: "run/root", seq: 1 }
const record = (seq: number) => ({ runId: "run", seq, eventId: `event-${seq}`, payload: {} })
const persistence = Layer.mergeAll(
  SqlJournal.layer({ capacity: 32, overflow: "reject" }),
  RunStore.layer,
  SqlTimeTravelStore.layer
).pipe(Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer)))

describe("rewind generation commit evidence", () => {
  for (const reportsGeneration of [true, false]) {
    it.effect(`rewind failure ${reportsGeneration ? "rolls back earlier archive evidence" : "preserves a committed archive without journal generations"}`, () =>
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const store = yield* TimeTravelStore
        const journal = yield* Journal.Journal
        yield* sql`
          INSERT INTO flows_runs
            (run_id, status, created_at_ms, state_json, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms)
          VALUES ('run', 'running', 0, '{"version":1,"flowName":"Recovery","payload":{}}',
                  ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 0)
        `
        for (const seq of [0, 1, 2]) {
          yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
            VALUES ('run', ${seq}, ${`event-${seq}`}, 'generation', ${seq}, 0, 'event', '{}', '{}')
          `
        }
        yield* store.archiveAndTruncate("run", frame, [], owner)
        yield* sql`
          INSERT INTO flows_journal_events
            (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
          VALUES ('run', 2, 'regrown', 'generation', 2, 0, 'event', '{}', '{}')
        `
        yield* sql`
          UPDATE flows_runs SET status = 'suspended', owner_host_id = NULL,
            owner_pid = NULL, owner_nonce = NULL, heartbeat_at_ms = NULL WHERE run_id = 'run'
        `
        let calls = 0
        const failure = yield* Effect.flip(
          Rewind.rewind({ runId: "run", frame, owner, auditId: "second-rewind" }).pipe(
            Effect.provideService(TimeTravelStore, {
              ...store,
              archiveAndTruncate: (...args) => {
                if (calls++ > 0) return store.archiveAndTruncate(...args)
                return Effect.gen(function*() {
                  const audits = yield* store.pendingAudits()
                  expect(audits[0]?.detail).toMatchObject({ phase: "compensated", suffixTailSeq: 2 })
                  expect((audits[0]?.detail as Rewind.AuditDetail).generation).toBe(reportsGeneration ? 1 : undefined)
                  if (reportsGeneration) {
                    yield* sql`DELETE FROM flows_journal_events WHERE run_id = 'run' AND seq > ${frame.seq}`.pipe(
                      Effect.orDie
                    )
                  } else {
                    yield* store.archiveAndTruncate(...args)
                  }
                  return yield* Effect.fail(error("unknown", "interrupted during archive"))
                })
              }
            }),
            Effect.provideService(Journal.Journal, reportsGeneration ? journal : { ...journal, generation: undefined })
          )
        )
        expect(failure.message).toBe("interrupted during archive")
        expect(calls).toBe(1)
        const audits = yield* sql<{ readonly status: string; readonly detail_json: string }>`
          SELECT status, detail_json FROM flows_time_travel_audits WHERE id = 'second-rewind'
        `
        expect(audits[0]?.status).toBe(reportsGeneration ? "failed" : "in_progress")
        const detail = JSON.parse(audits[0]!.detail_json)
        expect(detail.phase).toBe(reportsGeneration ? "rolled_back" : "archive_committed")
        expect(detail.generation).toBe(reportsGeneration ? 1 : undefined)
        const runs = yield* RunStore.RunStore
        if (!reportsGeneration) {
          expect(yield* runs.get("run")).toMatchObject({ status: "running", owner })
          expect(yield* store.archivedAt("run", 2, 1)).toBe(true)
          expect(yield* Recovery.recover({ owner, livenessEvidence: () => Effect.succeed(undefined) }))
            .toEqual([{ _tag: "Completed", auditId: "second-rewind" }])
        }
        expect(yield* runs.get("run")).toMatchObject({ status: "suspended", owner: null })
      }).pipe(
        Effect.provide(CacheStore.layer),
        Effect.provide(persistence),
        Effect.provide(EffectHandlerRegistry.layerNoop),
        Effect.provide(NodeJj.layer)
      ))
  }
  for (const backend of ["SQL", "memory"] as const) {
    for (const firstFrame of [0, 1]) {
      for (const legacy of [false, true]) {
        for (const committed of [false, true]) {
          const completed = committed || legacy
          it.effect(`${backend}: ${completed ? "completes" : "rolls back"} ${legacy ? "legacy" : "generation-bound"} audit with ${committed ? "current" : "earlier"} archive after rewind to frame ${firstFrame}`, () =>
            Effect.gen(function*() {
              const sql = yield* Effect.service(SqlClient.SqlClient)
              const sqlStore = yield* TimeTravelStore
              const memoryStore = backend === "memory"
                ? Memory.make({ records: [record(0), record(1), record(2)] })
                : undefined
              const store = memoryStore ?? sqlStore
              yield* sql`
              INSERT INTO flows_runs
                (run_id, status, created_at_ms, state_json, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms)
              VALUES ('run', 'running', 0, '{"version":1,"flowName":"Recovery","payload":{}}',
                      ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 0)
            `
              const append = (seq: number) =>
                sql`
              INSERT INTO flows_journal_events
                (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
              VALUES ('run', ${seq}, ${`event-${seq}`}, 'generation', ${seq}, 0, 'event', '{}', '{}')
            `
              for (const seq of [0, 1, 2]) yield* append(seq)
              // A real first commit leaves generation-zero archive rows at the
              // later rewind's tail, whether its frame was the same or lower.
              yield* store.archiveAndTruncate("run", { ...frame, seq: firstFrame }, [], owner)
              if (backend === "memory") {
                yield* sql`DELETE FROM flows_journal_events WHERE run_id = 'run' AND seq > ${firstFrame}`
              }
              for (let seq = firstFrame + 1; seq <= 2; seq++) {
                yield* append(seq)
                memoryStore?.append(record(seq))
              }
              if (committed) yield* store.archiveAndTruncate("run", frame, [], owner)
              expect(yield* store.archivedAt("run", 2, 0)).toBe(true)
              expect(yield* store.archivedAt("run", 2, 1)).toBe(committed)
              expect(yield* store.archivedAt("run", 2, 2)).toBe(false)
              expect(yield* store.archivedAt("run", 2)).toBe(true)
              expect(yield* store.archivedAt("other-run", 2)).toBe(false)
              expect(yield* store.archivedAt("run", 3)).toBe(false)
              expect(yield* store.archivedAt("other-run", 2, 0)).toBe(false)
              expect(yield* store.archivedAt("run", 3, 0)).toBe(false)
              yield* store.writeAudit({
                id: "second-rewind",
                runId: "run",
                frame,
                status: "in_progress",
                detail: {
                  version: 1,
                  phase: "compensated",
                  originalStatus: "suspended",
                  suffixCount: 1,
                  suffixTailSeq: 2,
                  ...(legacy ? {} : { generation: 1 }),
                  warnings: [],
                  cancelledChildren: []
                }
              })
              // For an uncommitted second rewind, simulate corruption: its
              // live suffix is absent without generation-one archive rows.
              // SQL is the real journal for both archive-store implementations.
              yield* sql`DELETE FROM flows_journal_events WHERE run_id = 'run' AND seq > ${frame.seq}`
              yield* sql`
              UPDATE flows_runs SET status = 'suspended', owner_host_id = NULL,
                owner_pid = NULL, owner_nonce = NULL, heartbeat_at_ms = NULL WHERE run_id = 'run'
            `
              const outcomes = yield* Recovery.recover({ owner, livenessEvidence: () => Effect.succeed(undefined) })
                .pipe(
                  Effect.provideService(TimeTravelStore, store)
                )
              expect(outcomes).toEqual([{ _tag: completed ? "Completed" : "RolledBack", auditId: "second-rewind" }])
              expect(yield* store.pendingAudits()).toEqual([])
              const runs = yield* RunStore.RunStore
              expect(yield* runs.get("run")).toMatchObject({ status: "suspended", owner: null })
              if (memoryStore !== undefined) {
                expect(memoryStore.state().audits[0]).toMatchObject({
                  status: completed ? "completed" : "failed",
                  detail: { phase: completed ? "completed" : "rolled_back" }
                })
              } else {
                expect(yield* sql`SELECT status FROM flows_time_travel_audits WHERE id = 'second-rewind'`)
                  .toEqual([{ status: completed ? "completed" : "failed" }])
              }
            }).pipe(
              Effect.provide(persistence),
              Effect.provide(EffectHandlerRegistry.layerNoop),
              Effect.provide(NodeJj.layer)
            ))
        }
      }
    }
  }
  for (const committed of [true, false]) {
    it.effect(`SQL: ${committed ? "completes legacy audit without reversing compensation when the tail is archived" : "rolls back legacy audit and compensation when no archive row exists"}`, () =>
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const store = yield* TimeTravelStore
        yield* sql`
          INSERT INTO flows_runs
            (run_id, status, created_at_ms, state_json, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms)
          VALUES ('run', 'running', 0, '{"version":1,"flowName":"Recovery","payload":{}}',
                  ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 0)
        `
        for (const seq of [0, 1, 2]) {
          yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
            VALUES ('run', ${seq}, ${`event-${seq}`}, 'generation', ${seq}, 0, 'event', '{}', '{}')
          `
        }
        // A real handler compensates an external SQL write. Its persisted
        // receipt lets an incorrect recovery rollback visibly restore it.
        yield* sql`CREATE TABLE generation_effects (effect_id TEXT PRIMARY KEY)`
        yield* sql`INSERT INTO generation_effects (effect_id) VALUES ('legacy-effect')`
        const registry = yield* EffectHandlerRegistry.make([{
          kind: "generation/sql-write",
          tier: "irreversible",
          residue: () => "SQL row",
          revert: (effect) =>
            sql`DELETE FROM generation_effects WHERE effect_id = ${effect.id}`.pipe(
              Effect.mapError((cause) => error("unknown", "could not compensate SQL write", cause)),
              Effect.as({ deleted: true })
            ),
          rollback: (effect, receipt) =>
            Effect.gen(function*() {
              expect(receipt).toEqual({ deleted: true })
              yield* sql`INSERT INTO generation_effects (effect_id) VALUES (${effect.id})`
            }).pipe(Effect.mapError((cause) => error("unknown", "could not roll back SQL compensation", cause)))
        }])
        const receipt = yield* registry.revert({
          id: "legacy-effect",
          kind: "generation/sql-write",
          tier: "irreversible",
          runId: "run",
          lineageId: "run/root",
          seq: 2,
          status: "succeeded",
          durableBoundary: true,
          providerStream: false
        })
        yield* store.writeAudit({
          id: "legacy-rewind",
          runId: "run",
          frame,
          status: "in_progress",
          detail: {
            version: 1,
            phase: "compensated",
            originalStatus: "suspended",
            suffixCount: 1,
            suffixTailSeq: 2,
            compensation: { handlerReceipts: [receipt] },
            warnings: [],
            cancelledChildren: []
          }
        })
        const before = yield* sql<{ readonly detail_json: string }>`
          SELECT detail_json FROM flows_time_travel_audits WHERE id = 'legacy-rewind'
        `
        expect(JSON.parse(before[0]!.detail_json)).not.toHaveProperty("generation")
        expect(JSON.parse(before[0]!.detail_json).compensation.handlerReceipts).toEqual([receipt])
        if (committed) yield* store.archiveAndTruncate("run", frame, [], owner)
        else yield* sql`DELETE FROM flows_journal_events WHERE run_id = 'run' AND seq > ${frame.seq}`
        expect(yield* store.archivedAt("run", 2)).toBe(committed)
        yield* sql`
          UPDATE flows_runs SET status = 'suspended', owner_host_id = NULL,
            owner_pid = NULL, owner_nonce = NULL, heartbeat_at_ms = NULL WHERE run_id = 'run'
        `
        expect(
          yield* Recovery.recover({ owner, livenessEvidence: () => Effect.succeed(undefined) }).pipe(
            Effect.provideService(EffectHandlerRegistry.EffectHandlerRegistry, registry)
          )
        ).toEqual([{ _tag: committed ? "Completed" : "RolledBack", auditId: "legacy-rewind" }])
        expect(yield* sql`SELECT effect_id FROM generation_effects`)
          .toEqual(committed ? [] : [{ effect_id: "legacy-effect" }])
        expect(yield* sql`SELECT seq FROM flows_journal_events WHERE run_id = 'run' ORDER BY seq`)
          .toEqual([{ seq: 0 }, { seq: 1 }])
        expect(yield* store.pendingAudits()).toEqual([])
        expect(yield* sql`SELECT status FROM flows_time_travel_audits WHERE id = 'legacy-rewind'`)
          .toEqual([{ status: committed ? "completed" : "failed" }])
      }).pipe(
        Effect.provide(persistence),
        Effect.provide(NodeJj.layer)
      ))
  }
})
