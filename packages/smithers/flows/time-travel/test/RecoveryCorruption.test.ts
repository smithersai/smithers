import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Jj from "@smthrs/jj"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as EffectHandlerRegistry from "../src/internal/EffectHandlerRegistry.ts"
import * as Recovery from "../src/internal/Recovery.ts"
import type { AuditDetail } from "../src/internal/Rewind.ts"
import * as Migrations from "../src/Migrations.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"
import { TimeTravelStore } from "../src/TimeTravelStore.ts"

const owner = { hostId: "recovery-corruption", pid: 0, nonce: "recovery-corruption" } as const

const persistence = Layer.mergeAll(
  SqlJournal.layer({ capacity: 32, overflow: "reject" }),
  RunStore.layer,
  SqlTimeTravelStore.layer
).pipe(
  Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer))
)

interface Corruption {
  readonly suffixRows: ReadonlyArray<{ readonly seq: number; readonly payload: string }>
  readonly suffixCount: number
  readonly suffixTailSeq?: number
}

const recover = (corruption: Corruption) =>
  Effect.scoped(
    Effect.gen(function*() {
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const store = yield* TimeTravelStore
      yield* sql`
          INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
          VALUES ('run', 'suspended', 0, ${JSON.stringify({ version: 1, flowName: "Recovery", payload: {} })})
        `
      yield* sql`
          INSERT INTO flows_journal_events
            (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
          VALUES ('run', 0, 'base', 'recovery', 0, 0, 'base', '{}',
                  ${JSON.stringify({ lineageId: "run/root" })})
        `
      for (const row of corruption.suffixRows) {
        yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
            VALUES ('run', ${row.seq}, ${`suffix-${row.seq}`}, 'recovery', ${row.seq}, 0,
                    'flows.time-travel.effect-boundary', ${row.payload},
                    ${JSON.stringify({ lineageId: "run/root" })})
          `
      }
      const detail: AuditDetail = {
        version: 1,
        phase: "compensated",
        originalStatus: "suspended",
        suffixCount: corruption.suffixCount,
        ...(corruption.suffixTailSeq === undefined ? {} : { suffixTailSeq: corruption.suffixTailSeq }),
        compensation: { handlerReceipts: [] },
        warnings: [],
        cancelledChildren: []
      }
      yield* store.writeAudit({
        id: "audit",
        runId: "run",
        frame: { lineageId: "run/root", seq: 0 },
        status: "in_progress",
        detail
      })
      const outcomes = yield* Recovery.recover({ owner, livenessEvidence: () => Effect.succeed(undefined) })
      const audits = yield* sql<{ readonly status: string; readonly detail_json: string }>`
          SELECT status, detail_json FROM flows_time_travel_audits WHERE id = 'audit'
        `
      const archive = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM flows_time_travel_archive WHERE run_id = 'run'
        `
      const receipts = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM flows_time_travel_receipts WHERE audit_id = 'audit'
        `
      return { archive: Number(archive[0]!.count), audits, outcomes, receipts: Number(receipts[0]!.count) }
    }).pipe(
      Effect.provide(persistence),
      Effect.provide(Layer.succeed(Jj.Jj)(Jj.makeNoop({ restore: () => Effect.void }))),
      Effect.provide(EffectHandlerRegistry.layerNoop)
    )
  )

describe("SQL recovery corruption", () => {
  const boundary = JSON.stringify({
    effect: {
      id: "sealed-effect",
      kind: "sealed/effect",
      tier: "sealed",
      status: "succeeded",
      runId: "run",
      lineageId: "run/root",
      durableBoundary: true,
      providerStream: false
    }
  })

  it.effect("rolls back when the recorded suffix tail is missing", () =>
    Effect.gen(function*() {
      const result = yield* recover({ suffixRows: [{ seq: 1, payload: boundary }], suffixCount: 2, suffixTailSeq: 2 })

      expect(result.outcomes).toEqual([{ _tag: "RolledBack", auditId: "audit" }])
      expect(result.audits[0]?.status).toBe("failed")
      expect(result.archive).toBe(0)
      expect(result.receipts).toBe(0)
    }))

  it.effect("rolls back when only a partial suffix remains", () =>
    Effect.gen(function*() {
      const result = yield* recover({ suffixRows: [{ seq: 2, payload: boundary }], suffixCount: 2, suffixTailSeq: 2 })

      expect(result.outcomes).toEqual([{ _tag: "RolledBack", auditId: "audit" }])
      expect(result.audits[0]?.status).toBe("failed")
    }))

  it.effect("rolls back rather than trusting a malformed boundary payload", () =>
    Effect.gen(function*() {
      const result = yield* recover({ suffixRows: [{ seq: 1, payload: "{}" }], suffixCount: 1, suffixTailSeq: 1 })

      expect(result.outcomes).toEqual([{ _tag: "RolledBack", auditId: "audit" }])
      expect(JSON.parse(result.audits[0]!.detail_json)).toMatchObject({ phase: "rolled_back" })
    }))

  it.effect("requires archive evidence when all live suffix rows are absent", () =>
    Effect.gen(function*() {
      const result = yield* recover({ suffixRows: [], suffixCount: 1, suffixTailSeq: 1 })

      expect(result.archive).toBe(0)
      expect(result.outcomes[0]?._tag).not.toBe("Completed")
      expect(result.audits[0]?.status).not.toBe("completed")
    }))

  it.effect("rolls back when the audit records a suffix but no tail coordinate", () =>
    Effect.gen(function*() {
      const result = yield* recover({ suffixRows: [], suffixCount: 1 })

      expect(result.outcomes).toEqual([{ _tag: "RolledBack", auditId: "audit" }])
      expect(result.audits[0]?.status).toBe("failed")
    }))
})
