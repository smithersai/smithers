/**
 * RunStore.lineage lifecycle projection, before and after omitting state.
 *
 * Run with: pnpm --filter @smthrs/run-store bench test/LineageRead.bench.ts
 * Optionally set SMITHERS_RUN_STORE_BENCH_DB to a private COPY of engine.db.
 * That copy is opened read-only, without migrations. No identifiers or payloads
 * are printed. Never commit the database or include it in published artifacts.
 *
 * The generated stores contain 10, 100 and 1,000 completed rounds, each with
 * a distinct wide state and a journal payload, plus one pending round. Setup
 * is outside timing. Each sample sweeps all lineage roots once; the retained
 * store therefore exercises its whole historical working set. The first sweep
 * is reported separately, followed by five measured sweeps. Generated stores
 * are seeded through create, which warms the bounded admission cache. Counts are actual
 * state/journal bytes returned by the injected production SQL client; timing
 * is observational, never a gate. Metadata rows still cost O(rounds).
 *
 * Run this same file and LineageReadFixture.ts on the parent for the baseline:
 * the old implementation ignores the includeState option and loads full rows.
 */
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { describe, expect, test } from "vitest"
import * as Migrations from "../src/Migrations.ts"
import * as RunStore from "../src/RunStore.ts"
import { history, observedSql } from "./LineageReadFixture.ts"

describe("lineage lifecycle reads", () => {
  const kept = process.env.SMITHERS_RUN_STORE_BENCH_DB
  for (const size of [10, 100, 1_000, ...(kept === undefined ? [] : ["kept" as const])]) {
    test(String(size), async () => {
      let payloadBytes = 0
      const database = size === "kept"
        ? DurableWriter.layer().pipe(Layer.provideMerge(NodeDatabase.layer({ filename: kept!, readOnly: true })))
        : Migrations.layer.pipe(Layer.provideMerge(TestDatabase.sqliteLayer))
      const layer = RunStore.layer.pipe(Layer.provideMerge(
        observedSql((bytes) => {
          payloadBytes += bytes
        }).pipe(Layer.provideMerge(database))
      ))
      await Effect.runPromise(
        Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          const sql = yield* SqlClient.SqlClient
          if (size !== "kept") yield* history(store, size)
          const roots = yield* sql<
            { id: string }
          >`SELECT DISTINCT COALESCE(lineage_id, run_id) AS id FROM flows_runs ORDER BY id`
          const total = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM flows_runs`
          const sweep = Effect.gen(function*() {
            let rows = 0
            for (const root of roots) rows += (yield* store.lineage(root.id, { includeState: false })).length
            expect(rows).toBe(Number(total[0]!.count))
          })
          payloadBytes = 0
          const firstStart = performance.now()
          yield* sweep
          const firstMs = performance.now() - firstStart
          const firstBytes = payloadBytes
          payloadBytes = 0
          const start = performance.now()
          for (let iteration = 0; iteration < 5; iteration++) yield* sweep
          console.log(JSON.stringify({
            fixture: size,
            runs: Number(total[0]!.count),
            lineages: roots.length,
            firstMs,
            firstPayloadBytes: firstBytes,
            repeatedMsPerSweep: (performance.now() - start) / 5,
            repeatedPayloadBytesPerSweep: payloadBytes / 5
          }))
        }).pipe(Effect.provide(layer), Effect.scoped)
      )
    }, 180_000)
  }
})
