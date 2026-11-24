import { DurableWriter } from "@smthrs/database/DurableWriter"
import { Effect, Exit, Metric, Scope, Stream } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { afterAll, describe, expect, it } from "vitest"
import * as Embedding from "../src/Embedding.ts"
import { MemoryError } from "../src/MemoryError.ts"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as Semantic from "../src/RecallSemantic.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

// Tests keep the constructor's owner alive through every projection assertion.
const projectorScope = Scope.makeUnsafe()
afterAll(() => Effect.runPromise(Scope.close(projectorScope, Exit.void)))
const makeProjector = (options: Semantic.Options): Semantic.Projector =>
  Effect.runSync(Semantic.makeProjector(options).pipe(Scope.provide(projectorScope)))

// The authoritative SQLite store and its vector table on a test clock.
const withMemory = <A, E>(
  body: Effect.Effect<A, E, MemoryStore.MemoryStore | SqlClient.SqlClient | DurableWriter>
) => Effect.runPromise(body.pipe(Effect.provide(TestMemory.layerWithDatabase), Effect.provide(TestClock.layer())))

const sqlVectors = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const writer = yield* DurableWriter
  return Semantic.makeSqlVectorStore({ sql, write: writer.write })
})

const storedModels = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const rows = yield* sql<{ readonly record_id: string; readonly embedding_model: string }>`
    SELECT record_id, embedding_model FROM memory_vectors ORDER BY record_id, embedding_model`
  return rows.map((row) => [row.record_id, row.embedding_model])
})

const failures = Metric.value(Semantic.projectionFailures).pipe(Effect.map((state) => state.count))

// A provider that embeds everything as [1, 0] until the test takes it down.
const outage = (options: { readonly model?: string } = {}) => {
  const state = { down: false }
  const service = Embedding.make(
    (inputs) =>
      state.down
        ? Effect.fail(new MemoryError({ code: "embedding_unavailable", message: "provider outage" }))
        : Effect.succeed(inputs.map(() => [1, 0])),
    options
  )
  return { state, service }
}

describe("RecallSemantic repair", () => {
  it("projects again the rows a failed projection left stale or missing, then recalls them", async () => {
    const { state, service } = outage()
    const result = await withMemory(Effect.gen(function*() {
      const vectorStore = yield* sqlVectors
      const options = { vectorStore, halfLifeMs: 1_000 }
      const authoritative = yield* MemoryStore.MemoryStore
      const store = Semantic.decorateStore(authoritative, makeProjector(options), service)
      const recall = Semantic.recall({ banks: ["bank"], query: "q" }, options).pipe(
        Effect.map((rows) => rows.map((row) => [row.key, row.text]))
      )
      const reconcile = Semantic.reconcile(["bank", "flow-bank"], options)
      const provided = <A, E>(effect: Effect.Effect<A, E, MemoryStore.MemoryStore | Embedding.Embedding>) =>
        effect.pipe(
          Effect.provideService(MemoryStore.MemoryStore, authoritative),
          Effect.provideService(Embedding.Embedding, service)
        )

      yield* store.putFact({ namespace: "bank", key: "row", value: "old text", provenance: {} })
      const failedBefore = yield* failures
      state.down = true
      yield* store.putFact({ namespace: "bank", key: "row", value: "new text", provenance: {} })
      yield* store.putNote({ namespace: "bank", id: "note", text: "never projected", tags: [], provenance: {} })
      const failedDuring = yield* failures
      // The query embedding fails with the provider, so recall is read once it is back.
      const stillDown = yield* provided(reconcile)
      const failedAfterPass = yield* failures
      state.down = false
      const stale = yield* provided(recall)
      const repaired = yield* provided(reconcile)
      const recalled = yield* provided(recall)
      const settled = yield* provided(reconcile)
      return {
        counted: [failedDuring - failedBefore, failedAfterPass - failedDuring],
        stillDown,
        stale,
        repaired,
        recalled,
        settled
      }
    }))

    // One failure per write, then one per row the pass could not repair.
    expect(result.counted).toEqual([2, 2])
    expect(result.stillDown).toEqual({ examined: 2, repaired: 0, failed: 2 })
    expect(result.stale).toEqual([])
    expect(result.repaired).toEqual({ examined: 2, repaired: 2, failed: 0 })
    expect([...result.recalled].sort()).toEqual([["note", "never projected"], ["row", "new text"]])
    expect(result.settled).toEqual({ examined: 2, repaired: 0, failed: 0 })
  })

  it("reads a bank in pages and holds one digest per stored vector", async () => {
    const stored = new Map<string, Semantic.Vector>()
    const vectorStore: Semantic.VectorStore = {
      scan: () =>
        Stream.suspend(() => {
          const vectors = [...stored.values()]
          return Stream.fromIterable(
            Array.from(
              { length: Math.ceil(vectors.length / 64) },
              (_, page) => vectors.slice(page * 64, page * 64 + 64)
            )
          )
        }),
      upsert: (vector) => Effect.sync(() => void stored.set(`${vector.recordKind}/${vector.recordId}`, vector))
    }
    const { service } = outage()
    const result = await withMemory(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      for (let index = 0; index < 257; index++) {
        yield* store.putNote({
          namespace: "bank",
          id: `note-${index}`,
          text: `text ${index}`,
          tags: [],
          provenance: {}
        })
      }
      const pass = Semantic.reconcile(["bank"], { vectorStore }).pipe(
        Effect.provideService(Embedding.Embedding, service)
      )
      return { first: yield* pass, second: yield* pass }
    }))

    expect(result.first).toEqual({ examined: 257, repaired: 257, failed: 0 })
    expect(result.second).toEqual({ examined: 257, repaired: 0, failed: 0 })
    expect(stored.size).toBe(257)
  })

  it("stamps vectors with the provider's model and refuses a provider of another vector space", async () => {
    const providerA = outage({ model: "provider-a" }).service
    const providerB = outage({ model: "provider-b" }).service
    const result = await withMemory(Effect.gen(function*() {
      const vectorStore = yield* sqlVectors
      const authoritative = yield* MemoryStore.MemoryStore
      const input = { banks: ["bank"], query: "q" }
      const keys = (rows: ReadonlyArray<{ readonly key: string }>) => rows.map((row) => row.key)
      // No declared model: the provider names the space.
      const store = Semantic.decorateStore(authoritative, makeProjector({ vectorStore }), providerA)
      yield* store.putFact({ namespace: "bank", key: "row", value: "text", provenance: {} })
      const stamped = yield* storedModels
      const sameSpace = yield* Semantic.recall(input, { vectorStore, model: "provider-a" }).pipe(
        Effect.provideService(Embedding.Embedding, providerA),
        Effect.map(keys)
      )
      // The host swapped providers and kept its declared model.
      const declared = { vectorStore, model: "provider-a" }
      const swapped = yield* Effect.flip(
        Semantic.recall(input, declared).pipe(Effect.provideService(Embedding.Embedding, providerB))
      )
      const reconciled = yield* Effect.flip(
        Semantic.reconcile(["bank"], declared).pipe(Effect.provideService(Embedding.Embedding, providerB))
      )
      const before = yield* failures
      const mismatched = Semantic.decorateStore(authoritative, makeProjector(declared), providerB)
      yield* mismatched.putFact({ namespace: "bank", key: "other", value: "other text", provenance: {} })
      const counted = (yield* failures) - before
      // With no declared model the swapped provider reads only its own space.
      const otherSpace = yield* Semantic.recall(input, { vectorStore }).pipe(
        Effect.provideService(Embedding.Embedding, providerB),
        Effect.map(keys)
      )
      return { stamped, sameSpace, swapped, reconciled, counted, otherSpace, after: yield* storedModels }
    }))

    expect(result.stamped).toEqual([["row", "provider-a"]])
    expect(result.sameSpace).toEqual(["row"])
    expect(result.swapped).toMatchObject({ code: "vector_model_mismatch" })
    expect(result.swapped.message).toContain("provider-a")
    expect(result.swapped.message).toContain("provider-b")
    expect(result.reconciled).toMatchObject({ code: "vector_model_mismatch" })
    expect(result.counted).toBe(1)
    expect(result.otherSpace).toEqual([])
    expect(result.after).toEqual(result.stamped)
  })

  it("names the vector space of every built-in and injected provider", async () => {
    const embedMany: Embedding.EmbedMany = (inputs) => Effect.succeed(inputs.map(() => [1]))
    const layered = await Effect.runPromise(
      Effect.service(Embedding.Embedding).pipe(Effect.provide(Embedding.layer(embedMany, { model: "layered" })))
    )
    expect(layered.model).toBe("layered")
    expect(Embedding.make(embedMany).model).toBeUndefined()
    expect("model" in Embedding.make(embedMany)).toBe(false)
    expect(Embedding.makeInProcess().model).toBe(Embedding.inProcessModel)
  })
})
