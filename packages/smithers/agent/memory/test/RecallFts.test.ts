import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as MemoryError from "../src/MemoryError.ts"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as Recall from "../src/Recall.ts"
import * as Fts from "../src/RecallFts.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

const ftsRow = (overrides: Partial<MemoryStore.FtsRow>): MemoryStore.FtsRow => ({
  id: "id",
  kind: "note",
  bank: "bank",
  namespace: { kind: "flow", id: "bank" },
  key: "key",
  text: "text",
  tags: [],
  updatedAtMs: 0,
  rank: -1,
  score: 1,
  ...overrides
})

const storeOf = (
  searchFts: (input: MemoryStore.SearchFtsInput) => Effect.Effect<ReadonlyArray<MemoryStore.FtsRow>>
) => MemoryStore.MemoryStore.of({ searchFts } as unknown as MemoryStore.Service)

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
    const result = await Effect.runPromise(
      Fts.recall({ banks: ["zeta", "alpha"], query: "alpha" }).pipe(
        Effect.provideService(
          MemoryStore.MemoryStore,
          storeOf(() => Effect.succeed([ftsRow({ key: "same", updatedAtMs: 5 })]))
        )
      )
    )
    expect(result.map(({ bank }) => bank)).toEqual(["alpha", "zeta"])
  })

  it("leaves store query escaping to the authoritative store", async () => {
    const queries: Array<string> = []
    const store = storeOf((input) => {
      queries.push(input.query)
      return Effect.succeed([])
    })

    await Effect.runPromise(
      Fts.recall({ banks: ["bank"], query: "one OR two" }).pipe(
        Effect.provideService(MemoryStore.MemoryStore, store)
      )
    )

    expect(queries).toEqual(["one OR two"])
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
    const error = new MemoryError.MemoryError({ code: "fts_not_enabled", message: "enable first" })
    const store = MemoryStore.MemoryStore.of({
      searchFts: () => Effect.fail(error)
    } as unknown as MemoryStore.Service)
    const exit = await Effect.runPromiseExit(
      Fts.recall({ banks: ["bank"], query: "term" }).pipe(
        Effect.provideService(MemoryStore.MemoryStore, store)
      )
    )
    expect(exit).toMatchObject({ _tag: "Failure" })
  })

  it("returns no rows, and never reads the store, for a blank query or an empty bank list", async () => {
    const store = storeOf(() => Effect.die("searchFts must not be called"))
    const blankQuery = await Effect.runPromise(
      Fts.recall({ banks: ["bank"], query: "   " }).pipe(Effect.provideService(MemoryStore.MemoryStore, store))
    )
    const noBanks = await Effect.runPromise(
      Fts.recall({ banks: [], query: "durable" }).pipe(Effect.provideService(MemoryStore.MemoryStore, store))
    )
    expect([blankQuery, noBanks]).toEqual([[], []])
  })

  it.each(
    [
      ["duplicate", ["bank", "bank"]],
      ["aliased", ["bank", "flow-bank"]]
    ] as const
  )("scans one resolved namespace and returns one row for %s banks", async (_label, banks) => {
    let scans = 0
    const result = await Effect.runPromise(
      Fts.recall({ banks: [...banks], query: "durable" }).pipe(
        Effect.provideService(
          MemoryStore.MemoryStore,
          storeOf(() =>
            Effect.sync(() => {
              scans += 1
              return [ftsRow({ key: "one", text: "durable" })]
            })
          )
        )
      )
    )
    expect(scans).toBe(1)
    expect(result.map((row) => row.key)).toEqual(["one"])
  })

  it("merges banks, drops non-accepted and mismatched rows, and orders by score, recency, then key", async () => {
    const store = storeOf((input) =>
      Effect.succeed(
        typeof input.namespace !== "string" && input.namespace.id === "one"
          ? [
            ftsRow({ key: "high", score: 2, updatedAtMs: 1, tags: ["scope:project"] }),
            ftsRow({ key: "rejected", score: 9, status: "rejected", tags: ["scope:project"] }),
            ftsRow({ key: "untagged", score: 5, tags: [] })
          ]
          : [
            ftsRow({ key: "tie-b", score: 1, updatedAtMs: 3, tags: ["scope:project"], status: "accepted" }),
            ftsRow({ key: "tie-a", score: 1, updatedAtMs: 3, tags: ["scope:project"], status: "accepted" }),
            ftsRow({ key: "older", score: 1, updatedAtMs: 1, tags: ["scope:project"], status: "accepted" })
          ]
      )
    )
    const rows = await Effect.runPromise(
      Fts.recall({
        banks: ["flow-one", "flow-two"],
        query: "durable",
        tagGroups: [{ tags: ["scope:project"], match: "all_strict" }]
      }).pipe(Effect.provideService(MemoryStore.MemoryStore, store))
    )

    expect(rows.map((row) => [row.bank, row.key])).toEqual([
      ["flow-one", "high"],
      ["flow-two", "tie-a"],
      ["flow-two", "tie-b"],
      ["flow-two", "older"]
    ])
  })

  it("scales the store limit with the token budget and caps the rows it returns", async () => {
    const limits: Array<number | undefined> = []
    const store = storeOf((input) => {
      limits.push(input.limit)
      return Effect.succeed([ftsRow({ key: "a", score: 3 }), ftsRow({ key: "b", score: 2 })])
    })
    const budgeted = await Effect.runPromise(
      Fts.recall({ banks: ["bank"], query: "durable", maxTokens: 256 }).pipe(
        Effect.provideService(MemoryStore.MemoryStore, store)
      )
    )
    const defaulted = await Effect.runPromise(
      Fts.recall({ banks: ["bank"], query: "durable" }).pipe(
        Effect.provideService(MemoryStore.MemoryStore, store)
      )
    )

    expect(limits).toEqual([5, 40])
    expect(budgeted.map((row) => row.key)).toEqual(["a"])
    expect(defaulted.map((row) => row.key)).toEqual(["a", "b"])
  })

  it("asks the store only for accepted rows and installs itself as the recall service", async () => {
    const statuses: Array<MemoryStore.StatusFilter | undefined> = []
    const store = storeOf((input) => {
      statuses.push(input.status)
      return Effect.succeed([ftsRow({ key: "runbook", text: "durable recovery" })])
    })
    const rows = await Effect.runPromise(
      Effect.service(Recall.Recall).pipe(
        Effect.flatMap((recall) => recall.recall({ banks: ["flow-one"], query: "durable" })),
        Effect.provide(Fts.layer),
        Effect.provideService(MemoryStore.MemoryStore, store)
      )
    )

    expect(statuses).toEqual(["accepted"])
    expect(rows).toEqual([
      { bank: "flow-one", key: "runbook", text: "durable recovery", score: 1, updatedAtMs: 0 }
    ])
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
