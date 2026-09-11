import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as Recall from "../src/Recall.ts"
import * as Keyword from "../src/RecallKeyword.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

const rows = [
  { key: "alpha", text: "alpha beta", tags: ["scope:x"], status: "accepted", updatedAtMs: 1 },
  { key: "new", text: "alpha", tags: ["scope:y"], status: "accepted", updatedAtMs: 2 },
  { key: "hidden", text: "alpha alpha", tags: ["scope:x"], status: "rejected", updatedAtMs: 3 }
]

const storeOf = (searchRows: () => Effect.Effect<ReadonlyArray<Keyword.Row>>) =>
  MemoryStore.MemoryStore.of({ searchRows } as unknown as MemoryStore.Service)

describe("RecallKeyword", () => {
  it.each([4, 5, 6])(
    "recalls a tagged SQLite row behind %i rejected candidates at a five-row window",
    async (rejected) => {
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const store = yield* MemoryStore.MemoryStore
          yield* store.putNote({
            namespace: "bank",
            id: "wanted",
            text: "durable recovery guidance for restoring a workflow after an interrupted run",
            tags: ["scope:wanted"],
            provenance: {}
          })
          for (let index = 0; index < rejected; index++) {
            yield* store.putNote({
              namespace: "bank",
              id: `other-${index}`,
              text: "durable durable durable",
              tags: ["scope:other"],
              provenance: {}
            })
          }
          const unfiltered = yield* store.searchRows({
            namespace: "bank",
            status: "accepted",
            limit: rejected + 1
          })
          const recalled = yield* Keyword.recall({
            banks: ["bank"],
            query: "durable",
            tagGroups: [{ tags: ["scope:wanted"], match: "all_strict" }],
            maxTokens: 256
          })
          return { unfiltered, recalled }
        }).pipe(Effect.provide(TestMemory.layer))
      )

      expect(result.unfiltered).toHaveLength(rejected + 1)
      expect(result.unfiltered.at(-1)?.key).toBe("wanted")
      expect(result.recalled.map((row) => row.key)).toEqual(["wanted"])
    }
  )

  it("scores terms, applies authoritative tags/status, and breaks ties by recency", async () => {
    const store = MemoryStore.MemoryStore.of({
      searchRows: () => Effect.succeed(rows)
    } as unknown as MemoryStore.Service)
    const result = await Effect.runPromise(
      Keyword.recall({
        banks: ["bank"],
        query: "alpha",
        tagGroups: [{ tags: ["scope:x"], match: "all_strict" }],
        maxTokens: 2048
      }).pipe(Effect.provideService(MemoryStore.MemoryStore, store))
    )
    expect(result.map(({ key }) => key)).toEqual(["alpha"])
  })

  it("preserves Smithers substring matching instead of exact-token matching", async () => {
    const store = MemoryStore.MemoryStore.of({
      searchRows: () => Effect.succeed(rows)
    } as unknown as MemoryStore.Service)
    const result = await Effect.runPromise(
      Keyword.recall({ banks: ["bank"], query: "lph" }).pipe(
        Effect.provideService(MemoryStore.MemoryStore, store)
      )
    )
    expect(result.map(({ key }) => key)).toEqual(["new", "alpha"])
  })

  it("returns no rows and never reads the store when no bank is selected", async () => {
    const result = await Effect.runPromise(
      Keyword.recall({ banks: [], query: "alpha" }).pipe(
        Effect.provideService(
          MemoryStore.MemoryStore,
          storeOf(() => Effect.die("searchRows must not be called for an empty bank list"))
        )
      )
    )
    expect(result).toEqual([])
  })

  it("rejects an empty bank before scanning the store", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(Keyword.recall({ banks: [""], query: "alpha" })).pipe(
        Effect.provideService(
          MemoryStore.MemoryStore,
          storeOf(() => Effect.die("searchRows must not be called for an invalid bank"))
        )
      )
    )
    expect(failure.code).toBe("invalid_namespace")
  })

  it.each(
    [
      [["bank", "bank"], "duplicate"],
      [["bank", "flow-bank"], "aliased"]
    ] as const
  )("scans one resolved namespace and returns one row for %s banks", async (banks, _label) => {
    let scans = 0
    const result = await Effect.runPromise(
      Keyword.recall({ banks: [...banks], query: "alpha" }).pipe(
        Effect.provideService(
          MemoryStore.MemoryStore,
          storeOf(() =>
            Effect.sync(() => {
              scans += 1
              return [rows[0]!]
            })
          )
        )
      )
    )
    expect(scans).toBe(1)
    expect(result.map((row) => row.key)).toEqual(["alpha"])
  })

  it("scores an absent term as zero, drops zero-scoring rows, and breaks exact ties by key", async () => {
    const tied = [
      { key: "b", text: "alpha", tags: [], updatedAtMs: 5 },
      { key: "a", text: "alpha", tags: [], updatedAtMs: 5 },
      { key: "é", text: "alpha", tags: [], updatedAtMs: 5 },
      { key: "z", text: "alpha", tags: [], updatedAtMs: 5 },
      { key: "unmatched", text: "delta", tags: [], updatedAtMs: 9 }
    ]
    const result = await Effect.runPromise(
      Keyword.recall({ banks: ["bank"], query: "alpha gamma" }).pipe(
        Effect.provideService(MemoryStore.MemoryStore, storeOf(() => Effect.succeed(tied)))
      )
    )
    expect(result.map(({ key, score }) => [key, score])).toEqual([["a", 1], ["b", 1], ["z", 1], ["é", 1]])
  })

  it("orders a key tied across banks by bank, independent of the request's bank order", async () => {
    const tied = [{ key: "same", text: "alpha", tags: [], updatedAtMs: 5 }]
    const result = await Effect.runPromise(
      Keyword.recall({ banks: ["zeta", "alpha"], query: "alpha" }).pipe(
        Effect.provideService(MemoryStore.MemoryStore, storeOf(() => Effect.succeed(tied)))
      )
    )
    expect(result.map(({ bank }) => bank)).toEqual(["alpha", "zeta"])
  })

  it("recalls nothing for a query with no terms and nothing from an empty bank", async () => {
    const empty = await Effect.runPromise(
      Keyword.recall({ banks: ["bank"], query: "   " }).pipe(
        Effect.provideService(MemoryStore.MemoryStore, storeOf(() => Effect.succeed(rows)))
      )
    )
    const noRows = await Effect.runPromise(
      Keyword.recall({ banks: ["bank"], query: "alpha" }).pipe(
        Effect.provideService(MemoryStore.MemoryStore, storeOf(() => Effect.succeed([])))
      )
    )
    expect([empty, noRows]).toEqual([[], []])
  })

  it("installs keyword recall as the recall service", async () => {
    const result = await Effect.runPromise(
      Effect.service(Recall.Recall).pipe(
        Effect.flatMap((recall) => recall.recall({ banks: ["bank"], query: "alpha" })),
        Effect.provide(Keyword.layer),
        Effect.provideService(MemoryStore.MemoryStore, storeOf(() => Effect.succeed(rows)))
      )
    )
    expect(result.map(({ key }) => key)).toEqual(["new", "alpha"])
  })

  it("normalizes query terms and scores a row against them", () => {
    expect(Keyword.normalizeQueryTerms("")).toEqual([])
    expect(Keyword.normalizeQueryTerms("   ")).toEqual([])
    expect(Keyword.normalizeQueryTerms(" , ; ")).toEqual([])
    expect(Keyword.normalizeQueryTerms("Ålpha-BÉTA_1, gamma")).toEqual(["ålpha-béta_1", "gamma"])
    const row = { key: "alpha", text: "alpha beta", tags: [], updatedAtMs: 0 }
    expect(Keyword.scoreRow([], row)).toBe(0)
    expect(Keyword.scoreRow(["alpha", "beta", "gamma"], row)).toBe(2)
  })
})
