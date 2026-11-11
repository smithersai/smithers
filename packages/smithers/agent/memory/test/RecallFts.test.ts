import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as Recall from "../src/Recall.ts"
import * as Fts from "../src/RecallFts.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

const note = (namespace: string, id: string, text: string, extra: Partial<MemoryStore.PutNoteInput> = {}) =>
  Effect.service(MemoryStore.MemoryStore).pipe(
    Effect.flatMap((store) => store.putNote({ namespace, id, text, tags: [], provenance: {}, ...extra }))
  )

// The authoritative SQLite store with FTS enabled for flow namespaces, on a
// test clock so every write lands at a declared time.
const withMemory = <A, E>(body: Effect.Effect<A, E, MemoryStore.MemoryStore>) =>
  Effect.runPromise(
    Effect.service(MemoryStore.MemoryStore).pipe(
      Effect.flatMap((store) => store.enableFts("flow")),
      Effect.andThen(body),
      Effect.provide(TestMemory.layer),
      Effect.provide(TestClock.layer())
    )
  )

// A store that must never be read; any call is a defect.
const unreadStore = MemoryStore.makeNoop({ searchFts: () => Effect.die("searchFts must not be called") })

describe("RecallFts", () => {
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
          yield* store.enableFts("flow")
          const unfiltered = yield* store.searchFts({
            namespace: "bank",
            query: "durable",
            status: "accepted",
            limit: rejected + 1
          })
          const recalled = yield* Fts.recall({
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

  it("quotes each term and preserves implicit AND", () => {
    expect(Fts.literalFtsQuery("one two\" three")).toBe("\"one\" \"two\"\"\" \"three\"")
    expect(Fts.literalFtsQuery(" \0 ")).toBe("")
  })

  it("orders a key tied across banks by bank, independent of the request's bank order", async () => {
    const result = await withMemory(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      for (const namespace of ["zeta", "alpha"]) {
        yield* store.putFact({ namespace, key: "same", value: "alpha", provenance: {} })
      }
      return yield* Fts.recall({ banks: ["zeta", "alpha"], query: "alpha" })
    }))
    expect(result.map(({ bank, key }) => [bank, key])).toEqual([["alpha", "same"], ["zeta", "same"]])
  })

  it("leaves store query escaping to the authoritative store, which reads operators as literal terms", async () => {
    const result = await withMemory(Effect.gen(function*() {
      yield* note("bank", "one", "one alone")
      yield* note("bank", "two", "two alone")
      yield* note("bank", "literal", "one or two")
      return yield* Fts.recall({ banks: ["bank"], query: "one OR two" })
    }))

    expect(result.map((row) => row.key)).toEqual(["literal"])
  })

  it("replaces lone surrogates, splits on NUL, and empties a whitespace-only query", () => {
    expect(Fts.literalFtsQuery("")).toBe("")
    expect(Fts.literalFtsQuery("   ")).toBe("")
    expect(Fts.literalFtsQuery("\uD800alpha")).toBe("\"�alpha\"")
    expect(Fts.literalFtsQuery("alpha\uDC00")).toBe("\"alpha�\"")
    expect(Fts.literalFtsQuery("a\0b")).toBe("\"a\" \"b\"")
    expect(Fts.literalFtsQuery("😀")).toBe("\"😀\"")
  })

  it("does not hide a disabled FTS namespace error", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(Fts.recall({ banks: ["bank"], query: "term" })).pipe(Effect.provide(TestMemory.layer))
    )
    expect(failure.code).toBe("fts_not_enabled")
  })

  it("returns no rows, and never reads the store, for a blank query or an empty bank list", async () => {
    const blankQuery = await Effect.runPromise(
      Fts.recall({ banks: ["bank"], query: "   " }).pipe(Effect.provideService(MemoryStore.MemoryStore, unreadStore))
    )
    const noBanks = await Effect.runPromise(
      Fts.recall({ banks: [], query: "durable" }).pipe(Effect.provideService(MemoryStore.MemoryStore, unreadStore))
    )
    expect([blankQuery, noBanks]).toEqual([[], []])
  })

  it.each(
    [
      ["duplicate", ["bank", "bank"]],
      ["aliased", ["bank", "flow-bank"]]
    ] as const
  )("scans one resolved namespace and returns one row for %s banks", async (_label, banks) => {
    const result = await withMemory(Effect.gen(function*() {
      yield* note("bank", "one", "durable")
      return yield* Fts.recall({ banks: [...banks], query: "durable" })
    }))
    expect(result.map((row) => [row.bank, row.key])).toEqual([["bank", "one"]])
  })

  it("merges banks, drops non-accepted and untagged rows, and orders by score, recency, then key", async () => {
    // Keys are indexed with the text, so the tied rows use keys of one length.
    const project = { tags: ["scope:project" as const] }
    const rows = await withMemory(Effect.gen(function*() {
      yield* TestClock.setTime(1)
      yield* note("flow-one", "high", "durable durable", project)
      yield* note("flow-one", "rejected", "durable durable durable", { ...project, status: "rejected" })
      yield* note("flow-one", "pending", "durable durable durable", { ...project, status: "pending" })
      yield* note("flow-one", "untagged", "durable durable durable")
      yield* note("flow-two", "oldc", "durable recovery", project)
      yield* TestClock.setTime(3)
      yield* note("flow-two", "tieb", "durable recovery", project)
      yield* note("flow-two", "tiea", "durable recovery", project)
      return yield* Fts.recall({
        banks: ["flow-one", "flow-two"],
        query: "durable",
        tagGroups: [{ tags: ["scope:project"], match: "all_strict" }]
      })
    }))

    expect(rows.map((row) => [row.bank, row.key, row.updatedAtMs])).toEqual([
      ["flow-one", "high", 1],
      ["flow-two", "tiea", 3],
      ["flow-two", "tieb", 3],
      ["flow-two", "oldc", 1]
    ])
    expect(rows[0]!.score).toBeGreaterThan(rows[1]!.score)
    expect(new Set(rows.slice(1).map((row) => row.score)).size).toBe(1)
  })

  it("returns one row per 256 tokens of budget and caps the rows it returns", async () => {
    const result = await withMemory(Effect.gen(function*() {
      yield* note("bank", "a", "durable durable")
      yield* note("bank", "b", "durable recovery")
      return {
        budgeted: yield* Fts.recall({ banks: ["bank"], query: "durable", maxTokens: 256 }),
        defaulted: yield* Fts.recall({ banks: ["bank"], query: "durable" })
      }
    }))

    expect(result.budgeted.map((row) => row.key)).toEqual(["a"])
    expect(result.defaulted.map((row) => row.key)).toEqual(["a", "b"])
  })

  it("drops rows a faulty store returns against the requested status and tags", async () => {
    const row = (key: string, overrides: Partial<MemoryStore.FtsRow>): MemoryStore.FtsRow => ({
      id: key,
      kind: "note",
      bank: "bank",
      namespace: { kind: "flow", id: "bank" },
      key,
      text: "durable",
      tags: ["scope:project"],
      updatedAtMs: 0,
      rank: -1,
      score: 1,
      ...overrides
    })
    // The store ignores both filters, so recall must apply them itself.
    const store = MemoryStore.makeNoop({
      searchFts: () =>
        Effect.succeed([row("rejected", { status: "rejected" }), row("untagged", { tags: [] }), row("kept", {})])
    })
    const rows = await Effect.runPromise(
      Fts.recall({ banks: ["bank"], query: "durable", tagGroups: [{ tags: ["scope:project"], match: "all_strict" }] })
        .pipe(Effect.provideService(MemoryStore.MemoryStore, store))
    )
    expect(rows.map((result) => result.key)).toEqual(["kept"])
  })

  it("recalls only accepted rows and installs itself as the recall service", async () => {
    const rows = await withMemory(
      Effect.gen(function*() {
        yield* note("flow-one", "runbook", "durable recovery")
        yield* note("flow-one", "draft", "durable recovery draft", { status: "pending" })
        yield* note("flow-one", "refused", "durable recovery refused", { status: "rejected" })
        const recall = yield* Recall.Recall
        return yield* recall.recall({ banks: ["flow-one"], query: "durable" })
      }).pipe(Effect.provide(Fts.layer))
    )

    expect(rows).toEqual([
      { bank: "flow-one", key: "runbook", text: "durable recovery", score: expect.any(Number), updatedAtMs: 0 }
    ])
    expect(rows[0]!.score).toBeGreaterThan(0)
  })

  it("returns the same rows as MemoryStore for a query containing a quote", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        yield* store.putNote({
          namespace: "bank",
          id: "quoted",
          text: "durable quoted recovery",
          tags: [],
          provenance: {}
        })
        yield* store.enableFts("flow")
        const input = { banks: ["bank"], query: "durable\"" }
        const direct = yield* store.searchFts({ namespace: "bank", query: input.query, limit: 20 })
        const recalled = yield* Fts.recall(input)
        return { direct, recalled }
      }).pipe(Effect.provide(TestMemory.layer))
    )
    expect(result.recalled.map((row) => row.key)).toEqual(result.direct.map((row) => row.key))
  })
})
