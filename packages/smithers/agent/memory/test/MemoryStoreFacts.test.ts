import * as DurableWriter from "@smthrs/database/DurableWriter"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as TestMemory from "../src/test/TestMemory.ts"
import { namespace, other, run, runWithDatabase } from "./fixtures/MemoryStoreHarness.ts"

describe("MemoryStore facts", () => {
  it("upserts facts last-write-wins and restarts TTL from the last update", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putFact({
        namespace,
        key: "session:state",
        value: { version: 1 },
        ttlMs: 10,
        provenance: { runId: "run-1" }
      })
      yield* TestClock.adjust("6 millis")
      yield* store.putFact({
        namespace,
        key: "session:state",
        value: { version: 2 },
        ttlMs: 10,
        provenance: { runId: "run-2" }
      })
      yield* store.putFact({
        namespace,
        key: "other",
        value: "ignored by prefix",
        provenance: {}
      })
      yield* TestClock.adjust("5 millis")
      const current = yield* store.getFact({ namespace, key: "session:state" })
      const listed = yield* store.listFacts({ namespace, prefix: "session:" })
      yield* TestClock.adjust("5 millis")
      const expired = yield* store.getFact({ namespace, key: "session:state" })
      const afterExpiry = yield* store.listFacts({ namespace, prefix: "session:" })
      return { current, listed, expired, afterExpiry }
    }))

    expect(result.current).toMatchObject({ value: { version: 2 }, provenance: { runId: "run-2" } })
    expect(result.listed.map((fact) => fact.key)).toEqual(["session:state"])
    expect(result.expired).toBeUndefined()
    expect(result.afterExpiry).toEqual([])
  })

  it("persists and indexes one detached snapshot of a stateful fact value", async () => {
    let reads = 0
    const value = {
      get content() {
        reads += 1
        return `snapshot-${reads}`
      }
    }
    const result = await runWithDatabase(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* store.enableFts("flow")
      yield* store.putFact({ namespace, key: "stateful", value, provenance: {} })
      const stored = yield* store.getFact({ namespace, key: "stateful" })
      const indexed = yield* sql<{ readonly text: string }>`SELECT text FROM memory_fts_flow
        WHERE namespace_id = 'project-1' AND record_kind = 'fact' AND record_id = 'stateful'`
      return { stored, indexed: indexed[0]?.text }
    }))

    expect(reads).toBe(1)
    expect(result.stored?.value).toEqual({ content: "snapshot-1" })
    expect(result.indexed).toBe("snapshot-1")
  })

  it("does not re-read a fact value mutated at the write boundary", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const writer = yield* DurableWriter.DurableWriter
        const value = { content: "before" }
        let mutate = false
        const write: DurableWriter.Service["write"] = (effect) =>
          (mutate
            ? Effect.sync(() => {
              value.content = "after"
              mutate = false
            })
            : Effect.void).pipe(Effect.andThen(writer.write(effect)))
        const store = yield* MemoryStore.make.pipe(
          Effect.provideService(DurableWriter.DurableWriter, DurableWriter.DurableWriter.of({ write }))
        )
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* store.enableFts("flow")
        mutate = true
        yield* store.putFact({ namespace, key: "mutated", value, provenance: {} })
        const stored = yield* store.getFact({ namespace, key: "mutated" })
        const indexed = yield* sql<{ readonly text: string }>`SELECT text FROM memory_fts_flow
          WHERE namespace_id = 'project-1' AND record_kind = 'fact' AND record_id = 'mutated'`
        return { live: value.content, stored, indexed: indexed[0]?.text }
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(result.live).toBe("after")
    expect(result.stored?.value).toEqual({ content: "before" })
    expect(result.indexed).toBe("before")
  })

  it("round-trips facts through JSON serialization rules", async () => {
    const values = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const sparse = new Array<unknown>(3)
      sparse[1] = "middle"
      yield* store.putFact({ namespace, key: "nan", value: Number.NaN, provenance: {} })
      yield* store.putFact({ namespace, key: "infinity", value: Number.POSITIVE_INFINITY, provenance: {} })
      yield* store.putFact({ namespace, key: "undefined", value: { kept: true, dropped: undefined }, provenance: {} })
      yield* store.putFact({ namespace, key: "sparse", value: sparse, provenance: {} })
      const facts = yield* Effect.forEach(
        ["nan", "infinity", "undefined", "sparse"],
        (key) => store.getFact({ namespace, key })
      )
      return facts.map((fact) => fact?.value)
    }))

    expect(values).toEqual([null, null, { kept: true }, [null, "middle", null]])
  })

  it("prefers validated first-class fact tags and falls back for legacy rows", async () => {
    const rows = await runWithDatabase(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* store.putFact({
        namespace,
        key: "current",
        value: { content: "current", tags: ["scope:legacy-value"] },
        tags: ["scope:first-class"],
        provenance: {}
      })
      yield* sql`INSERT INTO memory_facts (
        namespace_kind, namespace_id, fact_key, value_json, tags_json, ttl_ms,
        provenance_json, created_at_ms, updated_at_ms
      ) VALUES (
        'flow', 'project-1', 'legacy', '{"content":"legacy","tags":["scope:legacy"]}', NULL, NULL,
        '{}', 0, 0
      )`
      return yield* store.searchRows({ namespace })
    }))

    expect(rows.find((row) => row.key === "current")?.tags).toEqual(["scope:first-class"])
    expect(rows.find((row) => row.key === "legacy")?.tags).toEqual(["scope:legacy"])
  })

  it("reads, isolates, expires, and deletes facts at their boundaries", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const missing = yield* store.getFact({ namespace, key: "absent" })
      const notDeleted = yield* store.deleteFact({ namespace, key: "absent" })
      const emptyNamespace = yield* store.listFacts({ namespace })
      yield* store.putFact({ namespace, key: "instant", value: "gone", ttlMs: 0, provenance: {} })
      const immediatelyExpired = yield* store.getFact({ namespace, key: "instant" })
      yield* store.putFact({ namespace, key: "alpha", value: "a", provenance: {} })
      yield* store.putFact({ namespace, key: "beta", value: "b", provenance: {} })
      yield* store.putFact({ namespace: other, key: "alpha", value: "isolated", provenance: {} })
      const emptyPrefix = yield* store.listFacts({ namespace, prefix: "" })
      const unmatchedPrefix = yield* store.listFacts({ namespace, prefix: "zzz" })
      const isolated = yield* store.getFact({ namespace: other, key: "alpha" })
      const all = yield* store.listAllFacts
      const deleted = yield* store.deleteFact({ namespace, key: "alpha" })
      const afterDelete = yield* store.listFacts({ namespace })
      return {
        missing,
        notDeleted,
        emptyNamespace,
        immediatelyExpired,
        emptyPrefix,
        unmatchedPrefix,
        isolated,
        all,
        deleted,
        afterDelete
      }
    }))

    expect(result.missing).toBeUndefined()
    expect(result.notDeleted).toBe(false)
    expect(result.emptyNamespace).toEqual([])
    expect(result.immediatelyExpired).toBeUndefined()
    expect(result.emptyPrefix.map((fact) => fact.key)).toEqual(["alpha", "beta"])
    expect(result.unmatchedPrefix).toEqual([])
    expect(result.isolated?.value).toBe("isolated")
    expect(result.all.map((fact) => [fact.namespace.id, fact.key])).toEqual([
      ["project-1", "alpha"],
      ["project-1", "beta"],
      ["project-2", "alpha"]
    ])
    expect(result.deleted).toBe(true)
    expect(result.afterDelete.map((fact) => fact.key)).toEqual(["beta"])
  })

  it("ends the expiry sweep on its first empty chunk", async () => {
    const deleted = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putFact({ namespace, key: "permanent", value: "v", provenance: {} })
      return yield* store.deleteExpiredFacts
    }))

    expect(deleted).toBe(0)
  })
})
