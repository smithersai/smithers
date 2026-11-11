import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as Recall from "../src/Recall.ts"
import * as Keyword from "../src/RecallKeyword.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

const note = (namespace: string, id: string, text: string, extra: Partial<MemoryStore.PutNoteInput> = {}) =>
  Effect.service(MemoryStore.MemoryStore).pipe(
    Effect.flatMap((store) => store.putNote({ namespace, id, text, tags: [], provenance: {}, ...extra }))
  )

// The authoritative SQLite store on a test clock, so every write lands at a
// declared time.
const withMemory = <A, E>(body: Effect.Effect<A, E, MemoryStore.MemoryStore>) =>
  Effect.runPromise(body.pipe(Effect.provide(TestMemory.layer), Effect.provide(TestClock.layer())))

// Three notes in bank "bank": an older and a newer accepted match, and a
// rejected note that would outscore both.
const seeded = Effect.gen(function*() {
  yield* TestClock.setTime(1)
  yield* note("bank", "alpha", "alpha beta", { tags: ["scope:x"] })
  yield* TestClock.setTime(2)
  yield* note("bank", "new", "alpha", { tags: ["scope:y"] })
  yield* TestClock.setTime(3)
  yield* note("bank", "hidden", "alpha alpha", { tags: ["scope:x"], status: "rejected" })
})

// A store that must never be read; any call is a defect.
const unreadStore = (reason: string) => MemoryStore.makeNoop({ searchRows: () => Effect.die(reason) })

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

  it("recalls an old match behind 60 newer non-matching facts", async () => {
    const recalled = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        yield* store.putFact({ namespace: "bank", key: "old", value: "the banana recipe", provenance: {} })
        for (let index = 0; index < 60; index++) {
          yield* store.putFact({
            namespace: "bank",
            key: `newer-${index}`,
            value: `unrelated ${index}`,
            provenance: {}
          })
        }
        return yield* Keyword.recall({ banks: ["bank"], query: "banana", maxTokens: 2048 })
      }).pipe(Effect.provide(TestMemory.layer))
    )
    expect(recalled.map((row) => row.key)).toEqual(["old"])
  })

  it("scores terms, applies authoritative tags/status, and breaks ties by recency", async () => {
    const result = await withMemory(seeded.pipe(Effect.andThen(Keyword.recall({
      banks: ["bank"],
      query: "alpha",
      tagGroups: [{ tags: ["scope:x"], match: "all_strict" }],
      maxTokens: 2048
    }))))
    expect(result.map(({ key }) => key)).toEqual(["alpha"])
  })

  it("preserves Smithers substring matching instead of exact-token matching", async () => {
    const result = await withMemory(seeded.pipe(Effect.andThen(Keyword.recall({ banks: ["bank"], query: "lph" }))))
    expect(result.map(({ key }) => key)).toEqual(["new", "alpha"])
  })

  it("returns no rows and never reads the store when no bank is selected", async () => {
    const result = await Effect.runPromise(
      Keyword.recall({ banks: [], query: "alpha" }).pipe(
        Effect.provideService(
          MemoryStore.MemoryStore,
          unreadStore("searchRows must not be called for an empty bank list")
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
          unreadStore("searchRows must not be called for an invalid bank")
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
    const result = await withMemory(
      note("bank", "alpha", "alpha beta").pipe(Effect.andThen(Keyword.recall({ banks: [...banks], query: "alpha" })))
    )
    expect(result.map((row) => [row.bank, row.key])).toEqual([["bank", "alpha"]])
  })

  it("scores an absent term as zero, drops zero-scoring rows, and breaks exact ties by key", async () => {
    const result = await withMemory(Effect.gen(function*() {
      yield* TestClock.setTime(5)
      for (const id of ["b", "a", "é", "z"]) yield* note("bank", id, "alpha")
      yield* TestClock.setTime(9)
      yield* note("bank", "unmatched", "delta")
      return yield* Keyword.recall({ banks: ["bank"], query: "alpha gamma" })
    }))
    expect(result.map(({ key, score }) => [key, score])).toEqual([["a", 1], ["b", 1], ["z", 1], ["é", 1]])
  })

  it("orders a key tied across banks by bank, independent of the request's bank order", async () => {
    const result = await withMemory(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      for (const namespace of ["zeta", "alpha"]) {
        yield* store.putFact({ namespace, key: "same", value: "alpha", provenance: {} })
      }
      return yield* Keyword.recall({ banks: ["zeta", "alpha"], query: "alpha" })
    }))
    expect(result.map(({ bank, key }) => [bank, key])).toEqual([["alpha", "same"], ["zeta", "same"]])
  })

  it("recalls nothing for a query with no terms and nothing from an empty bank", async () => {
    const result = await withMemory(Effect.gen(function*() {
      yield* seeded
      return [
        yield* Keyword.recall({ banks: ["bank"], query: "   " }),
        yield* Keyword.recall({ banks: ["empty"], query: "alpha" })
      ]
    }))
    expect(result).toEqual([[], []])
  })

  it("installs keyword recall as the recall service", async () => {
    const result = await withMemory(
      Effect.gen(function*() {
        yield* seeded
        const recall = yield* Recall.Recall
        return yield* recall.recall({ banks: ["bank"], query: "alpha" })
      }).pipe(Effect.provide(Keyword.layer))
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
