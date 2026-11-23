import * as Effect from "effect/Effect"
import { describe, test } from "vitest"
import * as Embedding from "../src/Embedding.ts"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as RecallKeyword from "../src/RecallKeyword.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

const sampleTexts = Array.from(
  { length: 20 },
  (_, i) => `Durable workflow checkpoint ${i}: sqlite journal compaction and incremental cache keys`
)

const memoryRows: ReadonlyArray<RecallKeyword.Row> = Array.from({ length: 200 }, (_, i) => ({
  key: `fact/architecture/item-${i}`,
  text: i % 4 === 0
    ? `Incremental cache keys use content hashes and durable sqlite journal snapshots (${i})`
    : `Standard workspace configuration entry for module ${i} with default retention`,
  tags: ["architecture", i % 2 === 0 ? "cache" : "runtime"],
  status: "accepted",
  updatedAtMs: 1_700_000_000_000 + i * 1_000
}))

const queryText = "durable sqlite journal incremental cache keys"

describe("memory hot paths", () => {
  test("Embedding.inProcessVector", async ({ bench }) => {
    await bench("embed 20 documents with in-process vector", () => {
      for (const text of sampleTexts) {
        Embedding.inProcessVector(text)
      }
    }).run({ time: 120, warmupTime: 30 })
  })

  test("RecallKeyword.normalizeQueryTerms + scoreRow", async ({ bench }) => {
    await bench("normalize query and score 200 memory rows", () => {
      const terms = RecallKeyword.normalizeQueryTerms(queryText)
      for (const row of memoryRows) {
        RecallKeyword.scoreRow(terms, row)
      }
    }).run({ time: 120, warmupTime: 30 })
  })

  test("MemoryStore putFact + recall on SQLite", async ({ bench }) => {
    const program = Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const ns = { kind: "flow", id: "bench-bank" } as const
      for (let i = 0; i < 15; i++) {
        yield* store.putFact({
          namespace: ns,
          key: `fact-${i}`,
          value: { summary: `Durable cache entry ${i}`, count: i },
          tags: ["scope:workspace"],
          provenance: { runId: "bench-run-1" }
        })
      }
      return yield* store.listFacts({ namespace: ns, limit: 20 })
    }).pipe(Effect.provide(TestMemory.layerWithDatabase))

    await bench("write 15 facts + listFacts in SQLite MemoryStore", async () => {
      await Effect.runPromise(program)
    }).run({ iterations: 15, warmupIterations: 3, time: 0, warmupTime: 0 })
  })
})
