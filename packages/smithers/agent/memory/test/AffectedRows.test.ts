import { DurableWriter } from "@smthrs/database"
import { Effect } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as MemoryStore from "../src/MemoryStore.ts"
import { namespace, runWithDatabase } from "./fixtures/MemoryStoreHarness.ts"

// Faults change only the result metadata of real statements, so rollback is
// checked after the database has actually performed the mutation.
const transformRaw = (sql: SqlClient.SqlClient, transform: (raw: unknown) => unknown): SqlClient.SqlClient =>
  new Proxy(sql, {
    apply(target, thisArg, argumentsList) {
      const query = Reflect.apply(target, thisArg, argumentsList)
      return new Proxy(query, {
        get(queryTarget, property, receiver) {
          return property === "raw"
            ? queryTarget.raw.pipe(Effect.map(transform))
            : Reflect.get(queryTarget, property, receiver)
        }
      })
    }
  })

const source = { threadId: "thread", id: "source", role: "user", text: "original", at: 1 }
const summary = { threadId: "thread", id: "summary", role: "system", text: "summary", at: 2 }
const note = { namespace, id: "note", text: "note", tags: [], provenance: {} } as const
const fact = { namespace, key: "fact", value: "value", provenance: {} }

const mutations: ReadonlyArray<{
  readonly name: string
  readonly run: (store: MemoryStore.Service) => Effect.Effect<unknown, unknown>
}> = [
  { name: "createThread", run: (store) => store.createThread({ namespace, id: "new-thread" }) },
  { name: "deleteThread", run: (store) => store.deleteThread({ threadId: source.threadId }) },
  { name: "appendMessage", run: (store) => store.appendMessage({ ...source, id: "new-message" }) },
  { name: "putNote", run: (store) => store.putNote({ ...note, id: "new-note", supersedes: [note.id] }) },
  { name: "setNoteStatus", run: (store) => store.setNoteStatus({ id: note.id, status: "rejected" }) },
  { name: "deleteFact", run: (store) => store.deleteFact(fact) },
  { name: "deleteMessages", run: (store) => store.deleteMessages({ threadId: source.threadId, ids: [source.id] }) },
  {
    name: "compactMessages",
    run: (store) => store.compactMessages({ threadId: source.threadId, sourceMessages: [source], summary })
  },
  { name: "deleteExpiredFacts", run: (store) => store.deleteExpiredFacts }
]

describe("memory affected-row results", () => {
  it.each(mutations)("rejects an unsupported $name count and preserves committed rows", async ({ run }) => {
    const result = await runWithDatabase(Effect.gen(function*() {
      const authoritative = yield* MemoryStore.MemoryStore
      yield* authoritative.enableFts("flow")
      yield* authoritative.putFact(fact)
      yield* authoritative.putFact({ ...fact, key: "expired", ttlMs: 0 })
      yield* authoritative.putNote(note)
      yield* authoritative.appendMessage(source)
      const sql = yield* SqlClient.SqlClient
      const snapshot = () =>
        Effect.all([
          sql`SELECT * FROM memory_facts ORDER BY fact_key`,
          sql`SELECT * FROM memory_notes ORDER BY id`,
          sql`SELECT * FROM memory_threads ORDER BY thread_id`,
          sql`SELECT * FROM memory_messages ORDER BY thread_id, id`,
          sql`SELECT * FROM memory_note_supersedes ORDER BY superseder_id, target_id`,
          sql`SELECT record_id, record_kind, namespace_id, record_key, text
            FROM memory_fts_flow ORDER BY record_kind, record_id`
        ])
      const before = yield* snapshot()
      const store = yield* MemoryStore.make.pipe(
        Effect.provideService(SqlClient.SqlClient, transformRaw(sql, () => []))
      )
      const failure = yield* Effect.flip(run(store))
      return { failure, before, after: yield* snapshot() }
    }))

    expect(result.failure).toMatchObject({ code: "store", cause: { code: "unsupported" } })
    expect((result.failure as { cause: unknown }).cause).toBeInstanceOf(DurableWriter.DatabaseError)
    expect(result.after).toEqual(result.before)
  })

  it.each(["changes", "rowCount"])("uses safe bigint %s counts for writes, retries and deletes", async (field) => {
    const result = await runWithDatabase(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const countedSql = transformRaw(sql, (raw) => {
        const result = raw as { readonly changes?: number; readonly rowCount?: number }
        return { [field]: BigInt(result.changes ?? result.rowCount!) }
      })
      const store = yield* MemoryStore.make.pipe(Effect.provideService(SqlClient.SqlClient, countedSql))
      yield* store.createThread({ namespace, id: source.threadId })
      yield* store.createThread({ namespace, id: source.threadId })
      yield* store.appendMessage(source)
      yield* store.appendMessage(source)
      yield* store.putNote(note)
      yield* store.putNote(note)
      yield* store.putNote({ ...note, id: "new-note", text: "replacement", supersedes: [note.id] })
      yield* store.setNoteStatus({ id: "new-note", status: "rejected" })
      const rejected = yield* store.getNote({ id: "new-note" })
      yield* store.putFact(fact)
      const deletedFact = yield* store.deleteFact(fact)
      const missingFact = yield* store.deleteFact(fact)
      yield* store.putFact({ ...fact, ttlMs: 0 })
      const expired = yield* store.deleteExpiredFacts
      const compacted = yield* store.compactMessages({ threadId: source.threadId, sourceMessages: [source], summary })
      const deletedMessages = yield* store.deleteMessages({ threadId: source.threadId, ids: [summary.id] })
      const deletedThread = yield* store.deleteThread({ threadId: source.threadId })
      const missingThread = yield* store.deleteThread({ threadId: source.threadId })
      return {
        rejected: rejected?.status,
        deletedFact,
        missingFact,
        expired,
        compacted,
        deletedMessages,
        deletedThread,
        missingThread
      }
    }))

    expect(result).toEqual({
      rejected: "rejected",
      deletedFact: true,
      missingFact: false,
      expired: 1,
      compacted: 1,
      deletedMessages: 1,
      deletedThread: true,
      missingThread: false
    })
  })
})
