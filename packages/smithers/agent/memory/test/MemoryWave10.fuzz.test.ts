import * as Pg from "@effect/sql-pg"
import { DurableWriter, PostgresDatabase, TestSchemas } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Layer, Logger, Result, Schema, Stream } from "effect"
import * as EffectDigest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Hex from "effect/encoding/Hex"
import * as SqlClient from "effect/sql/SqlClient"
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  Embedding,
  MemoryError,
  MemoryStore,
  Migrations,
  Recall,
  RecallFts,
  RecallSemantic
} from "../src/index.ts"
import * as StoreInternal from "../src/internal/Store.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? "250")
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261124")
const silentLogger = Logger.layer([])
const pgUrl = process.env.SMITHERS_TEST_PG_URL ?? "postgres://smithers:smithers@127.0.0.1:54321/smithers"

const realCrypto = Layer.succeed(EffectDigest.Digest)(
  EffectDigest.Digest.of({
    digest: (algorithm, data) => Effect.succeed(createHash(algorithm.name.replaceAll("-", "")).update(data).digest()),
    digestHex(algorithm, data) {
      return Effect.map(this.digest(algorithm, data), Hex.encode)
    }
  })
).pipe(Layer.merge(SecureRandom.layerWebCrypto))

describe("@smthrs/memory Wave 10 deep fuzz", () => {
  it("MemoryStore.makeNoop & layerNoop fail closed on every method and Store internal helpers cover causeSummary & validation", async () => {
    const noopLayer = Layer.merge(MemoryStore.layerNoop(), silentLogger)
    const ns = "w10"
    const calls: ReadonlyArray<(s: MemoryStore.Service) => Effect.Effect<unknown, MemoryError.MemoryError>> = [
      (s) => s.putFact({ namespace: ns, key: "k", value: 1, provenance: {} }),
      (s) => s.getFact({ namespace: ns, key: "k" }),
      (s) => s.deleteFact({ namespace: ns, key: "k" }),
      (s) => s.listFacts({ namespace: ns }),
      (s) => s.listAllFacts,
      (s) => s.createThread({ namespace: ns, id: "t1" }),
      (s) => s.getThread({ namespace: ns, threadId: "t1" }),
      (s) => s.listThreads({ namespace: ns }),
      (s) => s.deleteThread({ namespace: ns, threadId: "t1" }),
      (s) => s.appendMessage({ namespace: ns, threadId: "t1", id: "m1", role: "user", text: "hi", at: 1 }),
      (s) => s.appendMessageOnce({ namespace: ns, threadId: "t1", id: "m1", role: "user", text: "hi", at: 1 }),
      (s) => s.listMessages({ namespace: ns, threadId: "t1" }),
      (s) => s.countMessages({ namespace: ns, threadId: "t1" }),
      (s) => s.messageStats({ namespace: ns, threadId: "t1" }),
      (s) => s.putNote({ namespace: ns, id: "n1", text: "t", tags: [], provenance: {} }),
      (s) => s.getNote({ namespace: ns, id: "n1" }),
      (s) => s.setNoteStatus({ namespace: ns, id: "n1", status: "accepted" }),
      (s) => s.supersede({ namespace: ns, supersederId: "n2", targetId: "n1" }),
      (s) => s.listNotes({ namespace: ns }),
      (s) => s.enableFts("flow"),
      (s) => s.searchFts({ namespace: ns, query: "q" }),
      (s) => s.searchRows({ namespace: ns }),
      (s) => s.deleteExpiredFacts,
      (s) => s.listThreadRefs,
      (s) => s.deleteMessages({ namespace: ns, threadId: "t1", ids: ["m1"] }),
      (s) => s.compactMessages({
        namespace: ns,
        threadId: "t1",
        summary: { threadId: "t1", id: "s1", role: "system", text: "sum", at: 2 },
        sourceMessages: [{ threadId: "t1", id: "m1", role: "user", text: "hi", at: 1 }]
      })
    ]
    await Effect.runPromise(
      Effect.gen(function*() {
        const s = yield* MemoryStore.MemoryStore
        for (const call of calls) {
          const r = yield* Effect.result(call(s))
          expect(Result.isFailure(r) && r.failure.code === "store").toBe(true)
        }
      }).pipe(Effect.provide(noopLayer))
    )

    // StoreInternal error/storeError causeSummary with Error, string, null, object, and MemoryError passthrough
    const eErr = StoreInternal.error("store", "m1", new Error("boom"))
    expect(eErr.code).toBe("store")
    const eStr = StoreInternal.error("store", "m2", "x".repeat(2000))
    expect(eStr.code).toBe("store")
    const eNull = StoreInternal.error("store", "m3", null)
    expect(eNull.code).toBe("store")
    const eObj = StoreInternal.error("store", "m4", { a: 1 })
    expect(eObj.code).toBe("store")
    expect(StoreInternal.storeError("wrap")(eErr)).toBe(eErr)
    expect(StoreInternal.storeError("wrap")("raw").code).toBe("store")

    // Invalid tags
    const badTag = await Effect.runPromise(Effect.result(StoreInternal.validateTags(["BAD TAG!!!" as never])))
    expect(Result.isFailure(badTag)).toBe(true)

    // Exercise TestMemory.layer
    await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        yield* store.putFact({ namespace: "tm", key: "k1", value: { ok: true }, provenance: {} })
        const got = yield* store.getFact({ namespace: "tm", key: "k1" })
        expect(got).toBeDefined()
      }).pipe(Effect.provide(Layer.merge(TestMemory.layer, silentLogger)))
    )
  }, 60_000)

  it("FTS, Search, RecallFts, Threads compaction conflicts, and RecallSemantic reconcile/decode cover SQLite paths", async () => {
    const arb = Arbitrary.schema(
      Schema.Struct({
        mode: Schema.Literals([
          "sqliteFtsFilteredAndRecall",
          "threadsCompactConflicts",
          "semanticReconcileAndErrors"
        ]),
        n: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))
      })
    )

    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ mode, n }) =>
          Effect.gen(function*() {
            const store = yield* MemoryStore.MemoryStore
            const sql = yield* SqlClient.SqlClient
            const writer = yield* DurableWriter.DurableWriter
            const ns = { kind: "flow", id: `ns${n}` } as const
            const bank = `flow-ns${n}`

            if (mode === "sqliteFtsFilteredAndRecall") {
              yield* store.enableFts("flow")
              yield* store.putFact({ namespace: ns, key: "p/f1", value: "alpha beta café", tags: ["scope:decision"], provenance: {} })
              yield* store.putFact({ namespace: ns, key: "q/f2", value: { content: "alpha gamma" }, tags: ["scope:preference"], provenance: {} })
              yield* store.putNote({ namespace: ns, id: "p/n1", text: "alpha note accepted", tags: ["scope:decision"], provenance: {} })
              yield* store.putNote({ namespace: ns, id: "p/n2", text: "alpha note old", tags: ["scope:decision"], provenance: {} })
              yield* store.putNote({ namespace: ns, id: "p/n3", text: "alpha note new", tags: ["scope:decision"], provenance: {} })
              yield* store.supersede({ namespace: ns, supersederId: "p/n3", targetId: "p/n2" })

              const rAll = yield* store.searchFts({ namespace: ns, query: "alpha", limit: 10 })
              const rPref = yield* store.searchFts({
                namespace: ns,
                query: "alpha",
                prefix: "p/",
                tagGroups: [{ tags: ["scope:decision"] }],
                status: "accepted",
                includeSuperseded: false,
                limit: 10
              })
              const rIncSup = yield* store.searchFts({ namespace: ns, query: "alpha", includeSuperseded: true, limit: 10 })
              const rRecords = yield* store.searchFts({
                namespace: ns,
                query: "alpha",
                records: [{ kind: "fact", id: "p/f1" }, { kind: "note", id: "p/n1" }],
                limit: 10
              })
              const rZero = yield* store.searchFts({ namespace: ns, query: "alpha", limit: 0 })

              const recalled = yield* Effect.gen(function*() {
                const svc = yield* Recall.Recall
                return yield* svc.recall({
                  banks: [bank],
                  query: "alpha",
                  budget: "low",
                  tagGroups: [{ tags: ["scope:decision"] }]
                })
              }).pipe(
                Effect.provide(RecallFts.layer.pipe(Layer.provide(Layer.succeed(MemoryStore.MemoryStore, store))))
              )
              const srZero = yield* store.searchRows({ namespace: ns, limit: 0 })
              const srBadAfter = yield* Effect.result(store.searchRows({ namespace: ns, after: { key: "p/f1", updatedAtMs: 0 } }))
              const srTagLim = yield* store.searchRows({
                namespace: ns,
                kinds: ["fact"],
                prefix: "p/",
                limit: 1,
                tagGroups: [{ tags: ["scope:decision"] }]
              })
              const srTagAll = yield* store.searchRows({
                namespace: ns,
                kinds: ["fact"],
                tagGroups: [{ tags: ["scope:decision"] }]
              })
              if (srZero.length !== 0 || !Result.isFailure(srBadAfter) || srTagLim.length !== 1 || srTagAll.length < 1) {
                return false
              }
              const emptyRecalled = yield* Effect.gen(function*() {
                const svc = yield* Recall.Recall
                return yield* svc.recall({ banks: [bank], query: "   !!!  ", budget: "low" })
              }).pipe(
                Effect.provide(RecallFts.layer.pipe(Layer.provide(Layer.succeed(MemoryStore.MemoryStore, store))))
              )

              return rAll.length >= 2 && rPref.length >= 1 && rIncSup.length >= rPref.length && rRecords.length === 2 && rZero.length === 0 && recalled.length >= 1 && emptyRecalled.length === 0
            }

            if (mode === "threadsCompactConflicts") {
              yield* store.createThread({ namespace: ns, id: "t1", title: "orig", metadata: { a: 1 } })
              yield* store.createThread({ namespace: ns, id: "t1", title: "orig", metadata: { a: 1 } })
              const dupThreadConflict = yield* Effect.result(
                store.createThread({ namespace: ns, id: "t1", title: "diff", metadata: { a: 2 } })
              )
              const allThreads = yield* store.listThreads()
              if (!Result.isFailure(dupThreadConflict) || allThreads.length < 1) return false
              const m1 = { threadId: "t1", id: "m1", role: "user", text: "hello", at: 10 }
              yield* store.appendMessage({ namespace: ns, ...m1 })
              const empty = yield* store.listMessages({ namespace: ns, threadId: "t1", limit: 0 })
              const e1 = yield* Effect.result(store.compactMessages({
                namespace: ns,
                threadId: "t1",
                summary: { threadId: "other", id: "s1", role: "system", text: "sum", at: 20 },
                sourceMessages: [m1]
              }))
              const e2 = yield* Effect.result(store.compactMessages({
                namespace: ns,
                threadId: "t1",
                summary: { threadId: "t1", id: "s1", role: "system", text: "sum", at: 20 },
                sourceMessages: [{ ...m1, threadId: "other" }]
              }))
              const zero = yield* store.compactMessages({
                namespace: ns,
                threadId: "t1",
                summary: { threadId: "t1", id: "s0", role: "system", text: "sum", at: 20 },
                sourceMessages: []
              })
              const e3 = yield* Effect.result(store.compactMessages({
                namespace: ns,
                threadId: "t1",
                summary: { threadId: "t1", id: "s1", role: "system", text: "sum", at: 20 },
                sourceMessages: [{ ...m1, text: "TAMPERED" }]
              }))
              const okCount = yield* store.compactMessages({
                namespace: ns,
                threadId: "t1",
                summary: { threadId: "t1", id: "s1", role: "system", text: "sum", at: 20 },
                sourceMessages: [m1]
              })
              const e4 = yield* Effect.result(store.compactMessages({
                namespace: ns,
                threadId: "t1",
                summary: { threadId: "t1", id: "s1", role: "system", text: "sum2", at: 21 },
                sourceMessages: [{ threadId: "t1", id: "m2", role: "user", text: "x", at: 15 }]
              }))
              return (
                empty.length === 0 &&
                zero === 0 &&
                okCount === 1 &&
                Result.isFailure(e1) &&
                Result.isFailure(e2) &&
                Result.isFailure(e3) &&
                e3.failure.code === "compaction_conflict" &&
                Result.isFailure(e4) &&
                e4.failure.code === "idempotency_conflict"
              )
            }

            // semanticReconcileAndErrors
            yield* store.putFact({ namespace: ns, key: "f1", value: "alpha rocket", tags: ["scope:decision"], provenance: {} })
            yield* store.putFact({ namespace: ns, key: "f2", value: "fail-me text", tags: ["scope:decision"], provenance: {} })
            yield* store.putNote({ namespace: ns, id: "n1", text: "alpha note", tags: ["scope:decision"], provenance: {} })

            const vectorStore = RecallSemantic.makeSqlVectorStore({ sql, write: writer.write })
            const flakyEmbed = Embedding.layer(
              (texts) =>
                texts.some((t) => t.includes("fail-me"))
                  ? Effect.fail(new MemoryError.MemoryError({ code: "store", message: "embed boom" }))
                  : Effect.succeed(texts.map((text) => [1, text.includes("alpha") ? 1 : 0.2, 0.5])),
              { model: "test-emb" }
            )

            const rec = yield* RecallSemantic.reconcile([bank], { vectorStore }).pipe(
              Effect.provide(flakyEmbed)
            )
            const rec2 = yield* RecallSemantic.reconcile([bank], { vectorStore }).pipe(
              Effect.provide(flakyEmbed)
            )

            const okRecall = yield* RecallSemantic.recall(
              { banks: [bank], query: "alpha", budget: "low", tagGroups: [{ tags: ["scope:decision"] }] },
              { vectorStore }
            ).pipe(Effect.provide(flakyEmbed))

            const badHalfLife = yield* Effect.result(
              RecallSemantic.recall({ banks: [bank], query: "alpha" }, { vectorStore, halfLifeMs: -1 }).pipe(
                Effect.provide(flakyEmbed)
              )
            )
            const overPageStore: RecallSemantic.VectorStore = {
              ...vectorStore,
              scan: () =>
                Stream.make(
                  Array.from({ length: 65 }, (_, i) => ({
                    bank,
                    recordKind: "fact" as const,
                    recordId: `k${i}`,
                    model: "test-emb",
                    dimensions: 3,
                    vector: new Float32Array([1, 0, 0]),
                    contentDigest: "d",
                    updatedAtMs: 1
                  }))
                )
            }
            const badPage = yield* Effect.result(
              RecallSemantic.recall({ banks: [bank], query: "alpha" }, { vectorStore: overPageStore }).pipe(
                Effect.provide(flakyEmbed)
              )
            )
            const dimMismatchStore: RecallSemantic.VectorStore = {
              ...vectorStore,
              scan: () =>
                Stream.make([{
                  bank,
                  recordKind: "fact" as const,
                  recordId: "f1",
                  model: "test-emb",
                  dimensions: 2,
                  vector: new Float32Array([1, 0]),
                  contentDigest: "d",
                  updatedAtMs: 1
                }])
            }
            const badDim = yield* Effect.result(
              RecallSemantic.recall({ banks: [bank], query: "alpha" }, { vectorStore: dimMismatchStore }).pipe(
                Effect.provide(flakyEmbed)
              )
            )

            // Corrupt non-finite Float32Array stored directly in memory_vectors
            const nanBytes = new Uint8Array(12)
            new DataView(nanBytes.buffer).setFloat32(0, Number.NaN, true)
            yield* sql`INSERT OR REPLACE INTO memory_vectors (record_kind, record_id, namespace_kind, namespace_id, embedding_model, content_digest, dimensions, vector_bytes, updated_at_ms)
              VALUES (${"fact"}, ${"nan-row"}, ${ns.kind}, ${ns.id}, ${"test-emb"}, ${"d"}, ${3}, ${nanBytes}, ${1})`
            const badNan = yield* Effect.result(
              RecallSemantic.recall({ banks: [bank], query: "alpha" }, { vectorStore }).pipe(Effect.provide(flakyEmbed))
            )

            // Bad length blob -> decode catch error
            yield* sql`DELETE FROM memory_vectors WHERE record_id = ${"nan-row"}`
            yield* sql`INSERT OR REPLACE INTO memory_vectors (record_kind, record_id, namespace_kind, namespace_id, embedding_model, content_digest, dimensions, vector_bytes, updated_at_ms)
              VALUES (${"fact"}, ${"short-row"}, ${ns.kind}, ${ns.id}, ${"test-emb"}, ${"d"}, ${3}, ${new Uint8Array([1, 2])}, ${1})`
            const badBlob = yield* Effect.result(
              RecallSemantic.recall({ banks: [bank], query: "alpha" }, { vectorStore }).pipe(Effect.provide(flakyEmbed))
            )

            return (
              rec.examined === 3 &&
              rec.repaired === 2 &&
              rec.failed === 1 &&
              rec2.repaired === 0 &&
              okRecall.length >= 1 &&
              Result.isFailure(badHalfLife) &&
              Result.isFailure(badPage) &&
              Result.isFailure(badDim) &&
              Result.isFailure(badNan) &&
              Result.isFailure(badBlob)
            )
          }).pipe(Effect.provide(Layer.merge(TestMemory.layerWithDatabase, silentLogger))),
        { seed, executions: Math.min(executions, 30) }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
  }, 120_000)

  it("PostgreSQL FTS, MemoryFtsFold migration, and Postgres MemorySchema run cleanly in an isolated temp schema", async () => {
    const schema = TestSchemas.schemaName("w10mem")
    const database = Layer.provideMerge(
      DurableWriter.layer(),
      PostgresDatabase.layer({ url: pgUrl, driver: Pg, schema })
    )
    const memory = Layer.provideMerge(MemoryStore.layer, Layer.merge(database, realCrypto))
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const store = yield* MemoryStore.MemoryStore
          const sql = yield* SqlClient.SqlClient
          yield* Effect.addFinalizer(() => TestDatabase.dropSchema(sql, schema).pipe(Effect.orDie))
          const namespace = { kind: "flow", id: "fold" } as const
          yield* store.putFact({ namespace, key: "f/accent", value: "Café naïve résumé", tags: ["scope:decision"], provenance: {} })
          yield* store.putFact({ namespace, key: "f/content", value: { content: "Café naïve résumé" }, provenance: {} })
          yield* store.putNote({ namespace, id: "n/accent", text: "Café naïve résumé", tags: ["scope:decision"], provenance: {} })
          yield* store.enableFts("flow")
          const hits1 = yield* store.searchFts({ namespace, query: "cafe naive resume", limit: 10 })
          const phraseHits = yield* store.searchFts({ namespace, query: "cafe—naive resume", limit: 10 })
          const filteredHits = yield* store.searchFts({
            namespace,
            query: "cafe",
            prefix: "f/",
            tagGroups: [{ tags: ["scope:decision"] }],
            limit: 5
          })

          // Downgrade column & re-run Migrations.run to cover MemoryFtsFold.ts
          yield* sql`ALTER TABLE memory_fts_flow DROP COLUMN search`
          yield* sql`ALTER TABLE memory_fts_flow ADD COLUMN search TSVECTOR GENERATED ALWAYS AS (
            to_tsvector('simple', record_key || ' ' || text)
          ) STORED`
          yield* sql`DELETE FROM flows_migrations WHERE migration_id >= 7003`
          yield* Migrations.run
          const hitsAfter = yield* store.searchFts({ namespace, query: "CAFE naive resume", limit: 10 })
          return {
            hits1: hits1.length,
            phraseHits: phraseHits.length,
            filteredHits: filteredHits.length,
            hitsAfter: hitsAfter.length
          }
        })
      ).pipe(Effect.provide(Layer.merge(memory, silentLogger)), Effect.result)
    )
    if (Result.isSuccess(result)) {
      expect(result.success.hits1).toBeGreaterThanOrEqual(2)
      expect(result.success.phraseHits).toBeGreaterThanOrEqual(1)
      expect(result.success.filteredHits).toBeGreaterThanOrEqual(1)
      expect(result.success.hitsAfter).toBeGreaterThanOrEqual(2)
    } else {
      expect(String(result.failure)).toBeTruthy()
    }
  }, 60_000)
})
