import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { Journal } from "../src/Journal.ts"
import { Input, type RunId, type Seq, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"
import * as Migrations from "../src/Migrations.ts"
import * as SqlJournal from "../src/SqlJournal.ts"
import * as Leases from "./fixtures/leases.ts"

const database = Layer.provideMerge(Migrations.layer, TestDatabase.layer)
const services = Layer.provideMerge(SqlJournal.layer({ capacity: 16, overflow: "reject" }), database)
const append = (journal: Journal["Service"], runId: string, seq: number) =>
  journal.emitDurableUnfenced(
    new Input({
      runId: runId as RunId,
      sourceId: "fixture" as SourceId,
      sourceSeq: seq as SourceSeq,
      eventType: "fixture",
      payload: { seq }
    })
  )

describe("journal heads", () => {
  it.effect("returns every requested head across 5000 ids, including unknown, rewound and compacted runs", () =>
    Effect.gen(function*() {
      const journal = yield* Journal
      expect(typeof journal.heads).toBe("function")
      const sql = yield* SqlClient.SqlClient
      const owner = { hostId: "fixture", pid: 1, nonce: "fixture" }
      for (const id of ["rewound", "compacted"]) {
        for (let seq = 0; seq < 4; seq++) yield* append(journal, id, seq)
      }
      yield* sql.withTransaction(Effect.gen(function*() {
        yield* sql`INSERT INTO flows_journal_generations (run_id, generation, after_seq) VALUES ('rewound', 2, 1)`
        yield* sql`DELETE FROM flows_journal_events WHERE run_id = 'rewound' AND seq > 1`
      }))
      yield* Leases.hold(sql, "compacted", owner)
      yield* journal.checkpoint({ runId: "compacted" as RunId, seq: 2 as Seq, state: null }, owner)
      expect((yield* journal.compact({ runId: "compacted" as RunId }, owner)).deleted).toBe(2)
      const ids = ["rewound", "compacted", ...Array.from({ length: 4998 }, (_, i) => `unknown-${i}`)] as Array<RunId>
      const heads = yield* journal.heads!(ids)
      expect(heads).toHaveLength(5000)
      expect(new Map(heads.map((head) => [head.runId, head])).size).toBe(5000)
      const byId = new Map(heads.map((head) => [head.runId, head]))
      expect([byId.get("rewound" as RunId), byId.get("compacted" as RunId)]).toEqual([
        { runId: "rewound", generation: 2, afterSeq: 1, maxSeq: 1 },
        { runId: "compacted", generation: 0, afterSeq: -1, maxSeq: 3 }
      ])
      expect(ids.slice(2).map((id) => byId.get(id))).toEqual(
        ids.slice(2).map((runId) => ({ runId, generation: 0, afterSeq: -1, maxSeq: null }))
      )
      expect(yield* journal.heads!([])).toEqual([])
      expect(yield* journal.heads!([ids[0]!, ids[0]!])).toEqual([byId.get(ids[0]!), byId.get(ids[0]!)])
    }).pipe(Effect.provide(services)))

  it.effect("reports a heads storage failure as read_failed", () =>
    Effect.gen(function*() {
      const journal = yield* Journal
      expect(typeof journal.heads).toBe("function")
      const sql = yield* SqlClient.SqlClient
      yield* sql`DROP TABLE flows_journal_generations`
      expect(yield* Effect.result(journal.heads!(["unknown" as RunId]))).toMatchObject({
        _tag: "Failure",
        failure: { code: "read_failed" }
      })
    }).pipe(Effect.provide(services)))
})
