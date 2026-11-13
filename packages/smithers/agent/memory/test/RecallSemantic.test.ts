import { DurableWriter } from "@smthrs/database/DurableWriter"
import { Cause, Deferred, Effect, Exit, Fiber, Option, Scope, Stream } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { afterAll, describe, expect, it } from "vitest"
import type { DatabaseService } from "../src/Database.ts"
import * as Embedding from "../src/Embedding.ts"
import { digest } from "../src/internal/Digest.ts"
import { MemoryError } from "../src/MemoryError.ts"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as Recall from "../src/Recall.ts"
import * as Semantic from "../src/RecallSemantic.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

// Tests keep the constructor's owner alive through every projection assertion.
const projectorScope = Scope.makeUnsafe()
afterAll(() => Effect.runPromise(Scope.close(projectorScope, Exit.void)))
const makeProjector = (options: Semantic.Options): Semantic.Projector =>
  Effect.runSync(Semantic.makeProjector(options).pipe(Scope.provide(projectorScope)))

const projection = (overrides: Partial<Semantic.Vector>): Semantic.Vector => ({
  bank: "flow-bank",
  recordKind: "note",
  recordId: "key",
  model: Semantic.defaultModel,
  contentDigest: digest("text"),
  dimensions: 2,
  vector: [1, 0],
  updatedAtMs: 0,
  ...overrides
})

const vectorStoreOf = (vectors: ReadonlyArray<Semantic.Vector>): Semantic.VectorStore => ({
  scan: () =>
    Stream.fromIterable(
      Array.from({ length: Math.ceil(vectors.length / 64) }, (_, index) => vectors.slice(index * 64, index * 64 + 64))
    ),
  upsert: () => Effect.void
})

const collectVectors = (store: Semantic.VectorStore, banks: ReadonlyArray<string>, model: string) =>
  Stream.runCollect(store.scan(banks, model)).pipe(Effect.map((pages) => pages.flat()))

const queryVector = Embedding.make(() => Effect.succeed([[1, 0]]))

// The authoritative SQLite store and its vector table on a test clock, with
// every query embedded as [1, 0].
const withMemory = <A, E>(
  body: Effect.Effect<A, E, MemoryStore.MemoryStore | SqlClient.SqlClient | DurableWriter | Embedding.Embedding>
) =>
  Effect.runPromise(body.pipe(
    Effect.provideService(Embedding.Embedding, queryVector),
    Effect.provide(TestMemory.layerWithDatabase),
    Effect.provide(TestClock.layer())
  ))

const sqlVectors = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const writer = yield* DurableWriter
  return Semantic.makeSqlVectorStore({ sql, write: writer.write })
})

// Commits one note in flow/bank and stores a vector current for its text.
const remember = (
  vectors: Semantic.VectorStore,
  id: string,
  text: string,
  note: Partial<MemoryStore.PutNoteInput> = {},
  vector: Partial<Semantic.Vector> = {}
) =>
  Effect.gen(function*() {
    const store = yield* MemoryStore.MemoryStore
    yield* store.putNote({ namespace: "bank", id, text, tags: [], provenance: {}, ...note })
    yield* vectors.upsert(projection({ recordId: id, contentDigest: digest(text), ...vector }))
  })

describe("RecallSemantic", () => {
  it("ranks by cosine and recency decay", async () => {
    // The older row is the closer match, so only the decay ranks the newer one first.
    const result = await withMemory(Effect.gen(function*() {
      const vectors = yield* sqlVectors
      yield* remember(vectors, "old", "old", {}, { vector: [1, 0], updatedAtMs: 0 })
      yield* TestClock.setTime(1_000)
      yield* remember(vectors, "near", "near", {}, { vector: [0.99, 0.01], updatedAtMs: 1_000 })
      return yield* Semantic.recall({ banks: ["bank"], query: "q", budget: "low" }, {
        vectorStore: vectors,
        halfLifeMs: 1_000
      })
    }))
    expect(result.map((row) => row.key)).toEqual(["near", "old"])
    expect(result[0]?.score).toBeCloseTo(0.99995, 4)
    expect(result[1]?.score).toBeCloseTo(0.5, 6)
  })

  it("scans one resolved namespace for duplicate and aliased banks", async () => {
    const rows = await withMemory(Effect.gen(function*() {
      const vectors = yield* sqlVectors
      yield* remember(vectors, "one", "one")
      return yield* Semantic.recall({ banks: ["bank", "flow-bank", "bank"], query: "q" }, {
        vectorStore: vectors,
        halfLifeMs: 1_000
      })
    }))

    expect(rows.map((row) => [row.bank, row.key])).toEqual([["bank", "one"]])
  })

  it("logs projection failures without failing the committed write path", async () => {
    const embedding = Embedding.make(() => Effect.succeed([[1]]))
    const projector = makeProjector({
      vectorStore: {
        scan: () => Stream.empty,
        upsert: () => Effect.fail(new (class extends Error {})()) as never
      }
    })
    await expect(Effect.runPromise(
      projector.project({
        bank: "bank",
        recordKind: "note",
        recordId: "key",
        text: "text",
        updatedAtMs: 0
      }).pipe(Effect.provideService(Embedding.Embedding, embedding))
    )).resolves.toBeUndefined()
  })

  it("serializes same-record projections while other records proceed, then releases the key", async () => {
    const entered = Deferred.makeUnsafe<void>()
    const gate = Deferred.makeUnsafe<void>()
    const embedded: Array<string> = []
    const writes: Array<string> = []
    const embedding = Embedding.make((inputs) =>
      Effect.gen(function*() {
        embedded.push(...inputs)
        if (inputs[0] === "first") {
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(gate)
        }
        return inputs.map(() => [1])
      })
    )
    const projector = makeProjector({
      vectorStore: {
        scan: () => Stream.empty,
        upsert: (vector) =>
          Effect.sync(() => {
            writes.push(vector.contentDigest)
          })
      }
    })
    const row = (text: string, recordId = "key"): Semantic.ProjectionInput => ({
      bank: "bank",
      recordKind: "fact",
      recordId,
      text,
      updatedAtMs: 0
    })

    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const first = yield* Effect.forkChild(projector.project(row("first")), { startImmediately: true })
        yield* Deferred.await(entered)
        const second = yield* Effect.forkChild(projector.project(row("second")), { startImmediately: true })
        yield* Effect.sleep("10 millis")
        const whileBlocked = { embedded: [...embedded], writes: [...writes], active: projector.activeKeys() }
        yield* projector.project(row("other", "other-key"))
        const otherDone = { embedded: [...embedded], writes: [...writes], active: projector.activeKeys() }
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        return { whileBlocked, otherDone }
      }).pipe(Effect.provideService(Embedding.Embedding, embedding))
    )

    expect(observed.whileBlocked).toEqual({ embedded: ["first"], writes: [], active: 1 })
    expect(observed.otherDone).toEqual({ embedded: ["first", "other"], writes: [digest("other")], active: 1 })
    expect(embedded).toEqual(["first", "other", "second"])
    expect(writes).toEqual([digest("other"), digest("first"), digest("second")])
    expect(projector.activeKeys()).toBe(0)
  })

  it("releases the record key when a blocked projection is interrupted", async () => {
    const entered = Deferred.makeUnsafe<void>()
    const embedding = Embedding.make(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
    const projector = makeProjector({
      vectorStore: { scan: () => Stream.empty, upsert: () => Effect.void }
    })
    const row: Semantic.ProjectionInput = {
      bank: "bank",
      recordKind: "note",
      recordId: "key",
      text: "t",
      updatedAtMs: 0
    }

    const activeWhileHeld = await Effect.runPromise(
      Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(projector.project(row), { startImmediately: true })
        yield* Deferred.await(entered)
        const active = projector.activeKeys()
        yield* Fiber.interrupt(fiber)
        return active
      }).pipe(Effect.provideService(Embedding.Embedding, embedding))
    )

    expect(activeWhileHeld).toBe(1)
    expect(projector.activeKeys()).toBe(0)
  })

  it("drops a projection whose provider exceeds the projection timeout", async () => {
    let writes = 0
    const projector = makeProjector({
      projectionTimeout: "20 millis",
      vectorStore: {
        scan: () => Stream.empty,
        upsert: () =>
          Effect.sync(() => {
            writes += 1
          })
      }
    })

    await expect(Effect.runPromise(
      projector.project({ bank: "bank", recordKind: "note", recordId: "key", text: "t", updatedAtMs: 0 }).pipe(
        Effect.provideService(Embedding.Embedding, Embedding.make(() => Effect.never)),
        Effect.timeout("2 seconds")
      )
    )).resolves.toBeUndefined()
    expect(writes).toBe(0)
    expect(projector.activeKeys()).toBe(0)
  })

  it("returns the committed write once the projection times out", async () => {
    const namespace = { kind: "flow", id: "hung" } as const
    const committed = await withMemory(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const sql = yield* SqlClient.SqlClient
      const writer = yield* DurableWriter
      const vectorStore = Semantic.makeSqlVectorStore({ sql, write: writer.write })
      const entered = yield* Deferred.make<void>()
      const decorated = Semantic.decorateStore(
        store,
        makeProjector({ vectorStore, projectionTimeout: "20 millis" }),
        Embedding.make(() => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
      )
      const write = yield* Effect.forkChild(
        decorated.putFact({ namespace, key: "k", value: { content: "v" }, provenance: {} })
      )
      yield* Deferred.await(entered)
      const fact = yield* store.getFact({ namespace, key: "k" })
      expect(fact?.value).toEqual({ content: "v" })
      expect(write.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("19 millis")
      expect(write.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("1 millis")
      yield* Fiber.join(write)
      expect(write.pollUnsafe()).toEqual(Exit.void)
      return fact
    }))

    expect(committed?.value).toEqual({ content: "v" })
  })

  it("keeps the newest vector when an older projection from another projector lands late", async () => {
    const namespace = { kind: "flow", id: "race" } as const
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const writer = yield* DurableWriter
        const vectorStore = Semantic.makeSqlVectorStore({ sql, write: writer.write })
        const entered = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        const slow = Embedding.make((inputs) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.as(inputs.map(Embedding.inProcessVector))
          )
        )
        const fast = Embedding.makeInProcess()
        const writerOne = Semantic.decorateStore(store, makeProjector({ vectorStore }), slow)
        const writerTwo = Semantic.decorateStore(store, makeProjector({ vectorStore }), fast)

        const first = yield* Effect.forkChild(
          writerOne.putFact({ namespace, key: "k", value: { content: "first" }, provenance: {} }),
          { startImmediately: true }
        )
        yield* Deferred.await(entered)
        yield* Effect.sleep("5 millis")
        yield* writerTwo.putFact({ namespace, key: "k", value: { content: "second" }, provenance: {} })
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(first)

        const fact = yield* store.getFact({ namespace, key: "k" })
        const rows = yield* sql<{ readonly content_digest: string; readonly updated_at_ms: number }>`
          SELECT content_digest, updated_at_ms FROM memory_vectors WHERE record_kind = 'fact' AND record_id = 'k'`
        const recalled = yield* Semantic.recall({ banks: ["flow-race"], query: "second" }, { vectorStore }).pipe(
          Effect.provideService(Embedding.Embedding, fast)
        )
        return { fact, rows, recalled: recalled.map((row) => row.key) }
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(result.fact?.value).toEqual({ content: "second" })
    expect(result.rows).toEqual([{ content_digest: digest("second"), updated_at_ms: result.fact?.updatedAtMs }])
    expect(result.recalled).toEqual(["k"])
  })

  it.each([1000, 900])("keeps the current fact when a late projection races a write at %i", async (secondTime) => {
    const namespace = { kind: "flow", id: "collision" } as const
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        yield* TestClock.setTime(1000)
        const store = yield* MemoryStore.MemoryStore
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const writer = yield* DurableWriter
        const vectorStore = Semantic.makeSqlVectorStore({ sql, write: writer.write })
        const entered = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        const slow = Embedding.make((inputs) =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.as(inputs.map(Embedding.inProcessVector))
          )
        )
        const fast = Embedding.makeInProcess()
        const firstWriter = Semantic.decorateStore(store, makeProjector({ vectorStore }), slow)
        const secondWriter = Semantic.decorateStore(store, makeProjector({ vectorStore }), fast)
        const first = yield* Effect.forkChild(
          firstWriter.putFact({ namespace, key: "k", value: "first", provenance: {} }),
          { startImmediately: true }
        )
        yield* Deferred.await(entered)
        const older = yield* store.getFact({ namespace, key: "k" })
        yield* TestClock.setTime(secondTime)
        yield* secondWriter.putFact({ namespace, key: "k", value: "second", provenance: {} })
        const recall = () =>
          Semantic.recall(
            { banks: ["flow-collision"], query: "second" },
            { vectorStore }
          ).pipe(Effect.provideService(Embedding.Embedding, fast))
        const before = yield* recall()
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(first)
        const fact = yield* store.getFact({ namespace, key: "k" })
        const after = yield* recall()
        const rows = yield* sql<{ readonly content_digest: string }>`
          SELECT content_digest FROM memory_vectors WHERE record_kind = 'fact' AND record_id = 'k'`
        return { older, fact, before, after, rows }
      }).pipe(Effect.provide(TestMemory.layerWithDatabase), Effect.provide(TestClock.layer()))
    )
    expect(result.older?.updatedAtMs).toBe(1000)
    expect(result.fact?.updatedAtMs).toBe(secondTime)
    expect(result.fact?.value).toBe("second")
    expect(result.before.map((row) => row.text)).toEqual(["second"])
    expect(result.after.map((row) => row.text)).toEqual(["second"])
    expect(result.rows).toEqual([{ content_digest: digest("second") }])
  })

  it("propagates projection interruption", async () => {
    const embedding = Embedding.make(() => Effect.interrupt)
    const projector = makeProjector({
      vectorStore: {
        scan: () => Stream.empty,
        upsert: () => Effect.void
      }
    })
    const exit = await Effect.runPromiseExit(
      projector.project({ bank: "bank", recordKind: "note", recordId: "key", text: "text", updatedAtMs: 0 }).pipe(
        Effect.provideService(Embedding.Embedding, embedding)
      )
    )
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(Cause.hasInterrupts(exit.cause)).toBe(true)
  })

  it("skips foreign models and gives matching-model dimension failures their own code", async () => {
    const runRecall = (options: Semantic.Options) =>
      Effect.runPromise(
        Semantic.recall({ banks: ["flow-bank"], query: "q" }, options).pipe(
          Effect.provide(TestMemory.layer),
          Effect.provideService(Embedding.Embedding, queryVector),
          Effect.provide(TestClock.layer())
        )
      )
    const failing = (options: Semantic.Options) =>
      Effect.runPromise(
        Effect.flip(Semantic.recall({ banks: ["flow-bank"], query: "q" }, options)).pipe(
          Effect.provide(TestMemory.layer),
          Effect.provideService(Embedding.Embedding, queryVector),
          Effect.provide(TestClock.layer())
        )
      )

    const foreignModel = await runRecall({ vectorStore: vectorStoreOf([projection({ model: "other" })]) })
    const storedDimensions = await failing({
      vectorStore: vectorStoreOf([projection({ dimensions: 3, vector: [1, 0] })])
    })
    const vectorLength = await failing({
      vectorStore: vectorStoreOf([projection({ dimensions: 2, vector: [1, 0, 0] })])
    })
    const zeroHalfLife = await failing({ vectorStore: vectorStoreOf([]), halfLifeMs: 0 })
    const infiniteHalfLife = await failing({
      vectorStore: vectorStoreOf([]),
      halfLifeMs: Number.POSITIVE_INFINITY
    })

    expect(foreignModel).toEqual([])
    expect([storedDimensions, vectorLength, zeroHalfLife, infiniteHalfLife].map((error) => [
      error.code,
      error.message
    ])).toEqual([
      ["vector_model_mismatch", "embedding dimensions do not match the query vector"],
      ["vector_model_mismatch", "embedding dimensions do not match the query vector"],
      ["embedding_unavailable", "semantic recency configuration must be finite with a positive half-life"],
      ["embedding_unavailable", "semantic recency configuration must be finite with a positive half-life"]
    ])
  })

  it("skips unresolved, non-accepted, untagged, and orthogonal rows, then breaks ties by key", async () => {
    const project = { tags: ["scope:project" as const] }
    const rows = await withMemory(Effect.gen(function*() {
      const vectors = yield* sqlVectors
      yield* remember(vectors, "pending", "p", { ...project, status: "pending" })
      yield* remember(vectors, "rejected", "r", { ...project, status: "rejected" })
      yield* remember(vectors, "untagged", "u")
      yield* remember(vectors, "orthogonal", "o", project, { vector: [0, 1] })
      yield* vectors.upsert(projection({ recordId: "orphan" }))
      yield* TestClock.setTime(5)
      yield* remember(vectors, "tie-b", "b", project, { updatedAtMs: 5 })
      yield* remember(vectors, "tie-a", "a", project, { updatedAtMs: 5 })
      return yield* Semantic.recall({
        banks: ["flow-bank"],
        query: "q",
        tagGroups: [{ tags: ["scope:project"], match: "all_strict" }]
      }, { vectorStore: vectors, halfLifeMs: 1000 })
    }))

    expect(rows.map((row) => [row.bank, row.key])).toEqual([
      ["flow-bank", "tie-a"],
      ["flow-bank", "tie-b"]
    ])
  })

  it("skips a non-accepted row a faulty store returns against the requested status", async () => {
    // The store ignores the accepted-only filter, so recall must apply it itself.
    const store = MemoryStore.makeNoop({
      searchRows: () =>
        Effect.succeed([{
          id: "pending",
          kind: "note",
          bank: "flow-bank",
          namespace: { kind: "flow", id: "bank" },
          key: "pending",
          text: "pending",
          tags: [],
          updatedAtMs: 0,
          status: "pending"
        }])
    })
    const rows = await Effect.runPromise(
      Semantic.recall({ banks: ["flow-bank"], query: "q" }, {
        vectorStore: vectorStoreOf([projection({ recordId: "pending", contentDigest: digest("pending") })]),
        halfLifeMs: 1_000
      }).pipe(
        Effect.provideService(MemoryStore.MemoryStore, store),
        Effect.provideService(Embedding.Embedding, queryVector),
        Effect.provide(TestClock.layer())
      )
    )
    expect(rows).toEqual([])
  })

  it("skips a joined row whose current text does not match the vector digest", async () => {
    const rows = await withMemory(Effect.gen(function*() {
      const vectors = yield* sqlVectors
      yield* remember(vectors, "changed", "current text", {}, { contentDigest: digest("old text") })
      return yield* Semantic.recall({ banks: ["flow-bank"], query: "q" }, { vectorStore: vectors, halfLifeMs: 1_000 })
    }))

    expect(rows).toEqual([])
  })

  it("does not score a stale vector left behind by a failed projection", async () => {
    let stored: Semantic.Vector | undefined
    let rejectProjection = false
    let upsertAttempts = 0
    // The vector port fails the second projection, leaving the first vector behind.
    const vectorStore: Semantic.VectorStore = {
      scan: () => Stream.suspend(() => Stream.succeed(stored === undefined ? [] : [stored])),
      upsert: (vector) => {
        upsertAttempts += 1
        return rejectProjection
          ? Effect.fail(new MemoryError({ code: "store", message: "projection unavailable" }))
          : Effect.sync(() => {
            stored = vector
          })
      }
    }
    const rows = await withMemory(Effect.gen(function*() {
      const store = Semantic.decorateStore(yield* MemoryStore.MemoryStore, makeProjector({ vectorStore }), queryVector)
      yield* store.putFact({ namespace: "bank", key: "row", value: "old text", provenance: {} })
      rejectProjection = true
      yield* TestClock.setTime(1)
      yield* store.putFact({ namespace: "bank", key: "row", value: "unrelated replacement", provenance: {} })
      return yield* Semantic.recall({ banks: ["flow-bank"], query: "q" }, { vectorStore, halfLifeMs: 1_000 })
    }))

    expect(upsertAttempts).toBe(3)
    expect(stored?.contentDigest).toBe(digest("old text"))
    expect(rows).toEqual([])
  })

  it("limits results by the declared budget and then by the token cap", async () => {
    const keys = Array.from({ length: 6 }, (_, index) => `row-${index}`)
    const result = await withMemory(Effect.gen(function*() {
      const vectors = yield* sqlVectors
      for (const [index, key] of keys.entries()) {
        yield* remember(vectors, key, `text for ${key}`, {}, { vector: [1, index / 100] })
      }
      const recall = (input: Recall.Input) => Semantic.recall(input, { vectorStore: vectors, halfLifeMs: 1000 })
      return {
        low: yield* recall({ banks: ["flow-bank"], query: "q", budget: "low" }),
        mid: yield* recall({ banks: ["flow-bank"], query: "q" }),
        high: yield* recall({ banks: ["flow-bank"], query: "q", budget: "high" }),
        capped: yield* recall({ banks: ["flow-bank"], query: "q", budget: "high", maxTokens: 120 })
      }
    }))

    expect(Semantic.budgetLimits).toEqual({ low: 3, mid: 8, high: 20 })
    expect(result.low.map((row) => row.key)).toEqual(["row-0", "row-1", "row-2"])
    expect(result.mid).toHaveLength(6)
    expect(result.high).toHaveLength(6)
    expect(result.capped.length).toBeLessThan(6)
  })

  it("decays by the clock's time and a seven-day half-life when the caller declares none", async () => {
    const rows = await withMemory(Effect.gen(function*() {
      const vectors = yield* sqlVectors
      yield* remember(vectors, "week-old", "week-old", {}, { updatedAtMs: 0 })
      yield* TestClock.setTime(7 * 86_400_000)
      return yield* Semantic.recall({ banks: ["flow-bank"], query: "q" }, { vectorStore: vectors })
    }))

    expect(rows.map((row) => row.key)).toEqual(["week-old"])
    expect(rows[0]?.score).toBeCloseTo(0.5)
  })

  it("defaults to the in-process embedding model", () => {
    expect(Semantic.defaultModel).toBe(Embedding.inProcessModel)
  })

  it("round-trips vectors through the migration-owned table and updates them on conflict", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const writer = yield* DurableWriter
        const vectors = Semantic.makeSqlVectorStore({ sql, write: writer.write })
        yield* vectors.upsert({
          bank: "flow-one",
          recordKind: "fact",
          recordId: "runbook",
          model: "test",
          contentDigest: "a",
          dimensions: 2,
          vector: [0.5, -0.25],
          updatedAtMs: 7
        })
        yield* vectors.upsert({
          bank: "agent-fleet",
          recordKind: "note",
          recordId: "note",
          model: "test",
          contentDigest: "b",
          dimensions: 1,
          vector: [1],
          updatedAtMs: 8
        })
        yield* vectors.upsert({
          bank: "flow-one",
          recordKind: "note",
          recordId: "foreign",
          model: "other",
          contentDigest: "foreign",
          dimensions: 1,
          vector: [1],
          updatedAtMs: 8
        })
        const before = yield* collectVectors(vectors, ["flow-one", "agent-fleet", "user-empty"], "test")
        yield* vectors.upsert({
          bank: "flow-one",
          recordKind: "fact",
          recordId: "runbook",
          model: "test",
          contentDigest: "c",
          dimensions: 2,
          vector: [1, 0],
          updatedAtMs: 9
        })
        yield* vectors.upsert({
          bank: "flow-one",
          recordKind: "fact",
          recordId: "runbook",
          model: "test",
          contentDigest: "stale",
          dimensions: 2,
          vector: [0, 1],
          updatedAtMs: 8
        })
        const after = yield* collectVectors(vectors, ["flow-one"], "test")
        return { before, after }
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(result.before.map((vector) => [vector.bank, vector.recordId, vector.recordKind, vector.dimensions])).toEqual(
      [
        ["flow-one", "runbook", "fact", 2],
        ["agent-fleet", "note", "note", 1]
      ]
    )
    expect(Array.from(result.before[0]!.vector)).toEqual([0.5, -0.25])
    expect(result.after).toHaveLength(1)
    expect(result.after[0]).toMatchObject({ contentDigest: "c", updatedAtMs: 9 })
    expect(Array.from(result.after[0]!.vector)).toEqual([1, 0])
  })

  it.each(
    [
      ["bank", { bank: "" }, ["bank"]],
      ["recordId", { recordId: "" }, ["recordId"]],
      ["model", { model: "" }, ["model"]],
      ["contentDigest", { contentDigest: "" }, ["contentDigest"]],
      ["dimension length", { dimensions: 2, vector: [1] }, ["dimensions"]],
      ["minimum dimensions", { dimensions: 0, vector: [] }, ["dimensions"]],
      ["maximum dimensions", { dimensions: 65_537, vector: new Array(65_537).fill(1) }, ["dimensions"]],
      ["finite component", { vector: [Number.NaN] }, ["vector", "0"]],
      ["negative time", { updatedAtMs: -1 }, ["updatedAtMs"]],
      ["safe integer time", { updatedAtMs: Number.MAX_SAFE_INTEGER + 1 }, ["updatedAtMs"]]
    ] as const
  )("rejects malformed upsert field %s before persistence", async (_label, override, path) => {
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const writer = yield* DurableWriter
        const vectors = Semantic.makeSqlVectorStore({ sql, write: writer.write })
        return yield* Effect.flip(vectors.upsert({
          bank: "flow-one",
          recordKind: "note",
          recordId: "key",
          model: "test",
          contentDigest: "digest",
          dimensions: 1,
          vector: [1],
          updatedAtMs: 0,
          ...override
        }))
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(failure).toMatchObject(
      _label === "bank" ? { code: "invalid_namespace" } : { code: "invalid_argument", path }
    )
  })

  it.each([0, 1])(
    "rejects a sparse vector component at index %i without replacing its SQL projection",
    async (hole) => {
      const sparse = new Array<number>(2)
      sparse[1 - hole] = 9
      expect(Object.hasOwn(sparse, hole)).toBe(false)
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const sql = yield* Effect.service(SqlClient.SqlClient)
          const writer = yield* DurableWriter
          const vectors = Semantic.makeSqlVectorStore({ sql, write: writer.write })
          const original: Semantic.Vector = {
            bank: "flow-one",
            recordKind: "note",
            recordId: "key",
            model: "test",
            contentDigest: "original",
            dimensions: 2,
            vector: [1, 2],
            updatedAtMs: 1
          }
          yield* vectors.upsert(original)
          const failure = yield* Effect.flip(vectors.upsert({
            ...original,
            vector: sparse,
            contentDigest: "invalid",
            updatedAtMs: 2
          }))
          return { failure, rows: yield* collectVectors(vectors, ["flow-one"], "test") }
        }).pipe(Effect.provide(TestMemory.layerWithDatabase))
      )
      expect(result.failure).toMatchObject({
        code: "invalid_argument",
        message: "vector components must be finite",
        path: ["vector", String(hole)]
      })
      expect(result.rows).toHaveLength(1)
      expect(result.rows[0]).toMatchObject({ contentDigest: "original", updatedAtMs: 1 })
      expect(Array.from(result.rows[0]!.vector)).toEqual([1, 2])
    }
  )

  it("validates a malformed upsert before constructing or running SQL", async () => {
    let statements = 0
    let writes = 0
    const database = {
      sql: (() => {
        statements += 1
        return Effect.void
      }) as unknown as SqlClient.SqlClient,
      write: (effect: Effect.Effect<unknown, unknown, unknown>) => {
        writes += 1
        return effect
      }
    } as unknown as DatabaseService
    const failure = await Effect.runPromise(Effect.flip(
      Semantic.makeSqlVectorStore(database).upsert({
        bank: "",
        recordKind: "note",
        recordId: "key",
        model: "test",
        contentDigest: "digest",
        dimensions: 1,
        vector: [1],
        updatedAtMs: 0
      })
    ))

    expect(failure).toMatchObject({ code: "invalid_namespace" })
    expect({ statements, writes }).toEqual({ statements: 0, writes: 0 })
  })

  it("reports a typed store error when the vector table is unavailable", async () => {
    const failures = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const writer = yield* DurableWriter
        const vectors = Semantic.makeSqlVectorStore({ sql, write: writer.write })
        yield* sql`DROP TABLE memory_vectors ${
          sql.literal(sql.onDialectOrElse({ pg: () => "CASCADE", orElse: () => "" }))
        }`
        return [
          yield* Effect.flip(vectors.upsert({
            bank: "flow-one",
            recordKind: "fact",
            recordId: "runbook",
            model: "test",
            contentDigest: "a",
            dimensions: 1,
            vector: [1],
            updatedAtMs: 0
          })),
          yield* Effect.flip(collectVectors(vectors, ["flow-one"], "test"))
        ]
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(failures.map((error) => [error.code, error.message])).toEqual([
      ["store", "memory vector upsert failed"],
      ["store", "memory vector scan failed"]
    ])
    expect(failures.map((error) => error.cause)).toEqual([
      expect.objectContaining({ _tag: "@smthrs/database/DatabaseError" }),
      expect.objectContaining({ _tag: "SqlError" })
    ])
  })

  it.each(
    [
      ["largest finite Float32", 3.4028234663852886e38, true],
      ["overflowing positive", 1e39, false],
      ["overflowing negative", -1e39, false],
      ["smallest subnormal Float32", 2 ** -149, true],
      ["underflowing positive", 2 ** -150, false],
      ["underflowing negative", -(2 ** -150), false]
    ] as const
  )("checks Float32 storage range for %s without replacing a usable projection", async (
    _label,
    component,
    accepted
  ) => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const writer = yield* DurableWriter
        const vectors = Semantic.makeSqlVectorStore({ sql, write: writer.write })
        const original: Semantic.Vector = {
          bank: "flow-one",
          recordKind: "note",
          recordId: "key",
          model: "test",
          contentDigest: "original",
          dimensions: 1,
          vector: [1],
          updatedAtMs: 1
        }
        yield* vectors.upsert(original)
        const attempt = yield* Effect.exit(vectors.upsert({
          ...original,
          vector: [component],
          contentDigest: "replacement",
          updatedAtMs: 2
        }))
        return { attempt, rows: yield* collectVectors(vectors, ["flow-one"], "test") }
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )
    if (accepted) {
      expect(Exit.isSuccess(result.attempt)).toBe(true)
      expect(result.rows[0]).toMatchObject({ contentDigest: "replacement", updatedAtMs: 2 })
      expect(Array.from(result.rows[0]!.vector)).toEqual([component])
    } else {
      expect(Exit.isFailure(result.attempt)).toBe(true)
      if (Exit.isSuccess(result.attempt)) throw new Error("expected vector rejection")
      expect(Option.getOrThrow(Cause.findErrorOption(result.attempt.cause))).toMatchObject({
        code: "invalid_argument",
        path: ["vector", "0"]
      })
      expect(result.rows[0]).toMatchObject({ contentDigest: "original", updatedAtMs: 1 })
      expect(Array.from(result.rows[0]!.vector)).toEqual([1])
    }
  })

  it.each([Infinity, -Infinity, NaN])("rejects a stored nonfinite vector component %s as corruption", async (
    component
  ) => {
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const writer = yield* DurableWriter
        const vectors = Semantic.makeSqlVectorStore({ sql, write: writer.write })
        const bytes = new Uint8Array(4)
        new DataView(bytes.buffer).setFloat32(0, component, true)
        yield* sql`INSERT INTO memory_vectors (
          record_kind, record_id, namespace_kind, namespace_id,
          embedding_model, content_digest, dimensions, vector_bytes, updated_at_ms
        ) VALUES ('note', 'bad', 'flow', 'one', 'test', 'digest', 1, ${bytes}, 0)`
        return yield* Effect.flip(collectVectors(vectors, ["flow-one"], "test"))
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )
    expect(failure).toMatchObject({
      code: "store",
      message: "stored memory vector flow/one note/bad (model test) has nonfinite component at index 0",
      path: ["flow", "one", "note", "bad", "test"]
    })
  })

  it("rejects corrupt vector dimensions and byte lengths as a typed store error", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const writer = yield* DurableWriter
        const vectors = Semantic.makeSqlVectorStore({ sql, write: writer.write })
        yield* sql`INSERT INTO memory_vectors (
          record_kind, record_id, namespace_kind, namespace_id,
          embedding_model, content_digest, dimensions, vector_bytes, updated_at_ms
        ) VALUES ('note', 'bad', 'flow', 'one', 'test', 'digest', 2, ${new Uint8Array(4)}, 0)`
        return yield* Effect.flip(collectVectors(vectors, ["flow-one"], "test"))
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )
    expect(failure).toMatchObject({
      code: "store",
      message: "stored memory vector flow/one note/bad (model test) has invalid dimensions or byte length",
      path: ["flow", "one", "note", "bad", "test"]
    })
  })

  it("projects a decorated fact and note write after the authoritative commit", async () => {
    const projected: Array<Semantic.ProjectionInput> = []
    const projector: Semantic.Projector = {
      project: (row) =>
        Effect.sync(() => {
          projected.push(row)
        }),
      activeKeys: () => 0
    }
    const namespace = { kind: "flow", id: "one" } as const

    const result = await withMemory(Effect.gen(function*() {
      const decorated = Semantic.decorateStore(yield* MemoryStore.MemoryStore, projector, Embedding.makeInProcess())
      yield* TestClock.setTime(7)
      yield* decorated.putFact({ namespace, key: "string", value: "already text", provenance: {} })
      yield* decorated.putFact({ namespace, key: "json", value: { content: "structured" }, provenance: {} })
      yield* decorated.putFact({ namespace, key: "fallback", value: { other: "value" }, provenance: {} })
      yield* TestClock.setTime(11)
      const note = yield* decorated.putNote({ namespace, id: "note", text: "note text", tags: [], provenance: {} })
      const passthrough = yield* decorated.listAllFacts
      return { note, passthrough }
    }))

    expect(projected.map((row) => [row.recordKind, row.recordId, row.text])).toEqual([
      ["fact", "string", "already text"],
      ["fact", "json", "structured"],
      ["fact", "fallback", "{\"other\":\"value\"}"],
      ["note", "note", "note text"]
    ])
    expect(projected.every((row) => row.bank === "flow-one")).toBe(true)
    expect(projected.at(-1)?.updatedAtMs).toBe(11)
    expect(projected[0]?.updatedAtMs).toBe(7)
    expect(result.note.id).toBe("note")
    expect(result.passthrough.map((fact) => fact.key).sort()).toEqual(["fallback", "json", "string"])
  })

  it("returns a committed fact success when its post-commit lookup fails", async () => {
    let writes = 0
    let projections = 0
    const projector: Semantic.Projector = {
      project: () =>
        Effect.sync(() => {
          projections += 1
        }),
      activeKeys: () => 0
    }
    const decorated = Semantic.decorateStore(
      MemoryStore.makeNoop({
        putFact: () =>
          Effect.sync(() => {
            writes += 1
          }),
        getFact: () => Effect.fail(new MemoryError({ code: "store", message: "lookup failed" }))
      }),
      projector,
      Embedding.makeInProcess()
    )

    await expect(Effect.runPromise(
      decorated.putFact({
        namespace: { kind: "flow", id: "one" },
        key: "fact",
        value: "value",
        provenance: {}
      })
    )).resolves.toBeUndefined()
    expect({ writes, projections }).toEqual({ writes: 1, projections: 0 })
  })

  it("skips projection when a committed fact disappears before readback", async () => {
    let writes = 0
    let projections = 0
    const decorated = Semantic.decorateStore(
      MemoryStore.makeNoop({
        putFact: () =>
          Effect.sync(() => {
            writes += 1
          }),
        getFact: () => Effect.succeed(undefined)
      }),
      {
        project: () =>
          Effect.sync(() => {
            projections += 1
          }),
        activeKeys: () => 0
      },
      Embedding.makeInProcess()
    )

    await Effect.runPromise(decorated.putFact({
      namespace: { kind: "flow", id: "one" },
      key: "removed",
      value: "old value",
      provenance: {}
    }))
    expect({ writes, projections }).toEqual({ writes: 1, projections: 0 })
  })

  it("returns a committed note success when its projector interrupts", async () => {
    let writes = 0
    const projector: Semantic.Projector = { project: () => Effect.interrupt, activeKeys: () => 0 }
    const decorated = Semantic.decorateStore(
      MemoryStore.makeNoop({
        putNote: (input) =>
          Effect.sync(() => {
            writes += 1
            return {
              namespace: typeof input.namespace === "string"
                ? { kind: "flow" as const, id: input.namespace }
                : input.namespace,
              id: input.id,
              text: input.text,
              tags: input.tags,
              provenance: input.provenance,
              status: input.status ?? "accepted",
              createdAtMs: 1
            }
          })
      }),
      projector,
      Embedding.makeInProcess()
    )

    const note = await Effect.runPromise(
      decorated.putNote({
        namespace: { kind: "flow", id: "one" },
        id: "note",
        text: "value",
        tags: [],
        provenance: {}
      })
    )
    expect(note.id).toBe("note")
    expect(writes).toBe(1)
  })

  it("names the projected model and digest a committed row", async () => {
    const upserted: Array<Semantic.Vector> = []
    const projector = makeProjector({
      model: "test-model",
      vectorStore: {
        scan: () => Stream.empty,
        upsert: (vector) =>
          Effect.sync(() => {
            upserted.push(vector)
          })
      }
    })
    await Effect.runPromise(
      Effect.gen(function*() {
        yield* projector.project({
          bank: "flow-one",
          recordKind: "fact",
          recordId: "k",
          text: "same text",
          updatedAtMs: 1
        })
        yield* projector.project({
          bank: "flow-one",
          recordKind: "fact",
          recordId: "k",
          text: "same text",
          updatedAtMs: 2
        })
        yield* projector.project({
          bank: "flow-one",
          recordKind: "fact",
          recordId: "k",
          text: "edited text",
          updatedAtMs: 3
        })
      }).pipe(Effect.provideService(Embedding.Embedding, Embedding.makeInProcess()))
    )

    expect(upserted.map((vector) => vector.model)).toEqual(["test-model", "test-model", "test-model"])
    expect(upserted[0]?.contentDigest).toBe(upserted[1]?.contentDigest)
    expect(upserted[2]?.contentDigest).not.toBe(upserted[0]?.contentDigest)
    expect(upserted[0]?.dimensions).toBe(64)
    expect(projector.activeKeys()).toBe(0)
  })

  it("snapshots every projector field before embedding awaits", async () => {
    const upserted: Array<Semantic.Vector> = []
    const row = {
      bank: "flow-one",
      recordKind: "fact" as "fact" | "note",
      recordId: "record",
      text: "embedded text",
      updatedAtMs: 1
    }
    const embedding = Embedding.make((inputs) =>
      Effect.sync(() => {
        row.bank = "flow-mutated"
        row.text = "mutated text"
        row.updatedAtMs = 2
        row.recordKind = "note"
        row.recordId = "mutated-record"
        return inputs.map(() => [1])
      })
    )
    const projector = makeProjector({
      model: "test",
      vectorStore: {
        scan: () => Stream.empty,
        upsert: (vector) =>
          Effect.sync(() => {
            upserted.push(vector)
          })
      }
    })

    await Effect.runPromise(projector.project(row).pipe(Effect.provideService(Embedding.Embedding, embedding)))

    expect(upserted).toHaveLength(1)
    expect(upserted[0]).toMatchObject({
      bank: "flow-one",
      contentDigest: digest("embedded text"),
      updatedAtMs: 1,
      recordKind: "fact",
      recordId: "record"
    })
  })

  it("recalls decorated SQL rows with a provider dimension other than 64", async () => {
    const model = "provider/three-dimensional"
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const writer = yield* DurableWriter
        const authoritative = yield* MemoryStore.MemoryStore
        const embedding = yield* Embedding.Embedding
        const vectorStore = Semantic.makeSqlVectorStore({ sql, write: writer.write })
        const options = { vectorStore, model, halfLifeMs: 1_000 }
        const decorated = Semantic.decorateStore(authoritative, makeProjector(options), embedding)
        const namespace = { kind: "flow", id: "semantic-e2e" } as const

        yield* decorated.putNote({
          namespace,
          id: "note",
          text: "semantic note",
          tags: [],
          provenance: {}
        })
        yield* decorated.putFact({
          namespace,
          key: "fact",
          value: { content: "semantic fact" },
          provenance: {}
        })
        const recalled = yield* Semantic.recall({ banks: ["flow-semantic-e2e"], query: "semantic" }, options)
        const counts = yield* sql<{ readonly embedding_model: string; readonly count: number }>`
          SELECT embedding_model, count(*) AS count
          FROM memory_vectors
          GROUP BY embedding_model
          ORDER BY embedding_model
        `
        return { recalled, counts }
      }).pipe(
        Effect.provide(Embedding.layerFake(() => [1, 0, 0])),
        Effect.provide(TestMemory.layerWithDatabase)
      )
    )

    expect(result.recalled.map((row) => [row.key, row.text])).toEqual([
      ["fact", "semantic fact"],
      ["note", "semantic note"]
    ])
    expect(result.counts).toEqual([{ embedding_model: model, count: 2 }])
  })

  it("installs semantic recall as the recall service", async () => {
    const rows = await withMemory(Effect.gen(function*() {
      const vectors = yield* sqlVectors
      yield* remember(vectors, "runbook", "durable recovery", {}, { model: "test" })
      return yield* Effect.service(Recall.Recall).pipe(
        Effect.flatMap((recall) => recall.recall({ banks: ["flow-bank"], query: "runbook" })),
        Effect.provide(Semantic.layer({ vectorStore: vectors, model: "test", halfLifeMs: 1_000 }))
      )
    }))

    expect(rows).toEqual([
      { bank: "flow-bank", key: "runbook", text: "durable recovery", score: 1, updatedAtMs: 0 }
    ])
  })
})
