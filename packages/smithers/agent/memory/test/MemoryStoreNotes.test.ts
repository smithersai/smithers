import { Effect } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as MemoryStore from "../src/MemoryStore.ts"
import type * as Namespace from "../src/Namespace.ts"
import * as TestMemory from "../src/test/TestMemory.ts"
import { namespace, other, run, runWithDatabase } from "./fixtures/MemoryStoreHarness.ts"

describe("MemoryStore notes", () => {
  it("keeps notes immutable and hides targets only for accepted superseders", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putNote({
        namespace,
        id: "old",
        text: "old guidance",
        tags: ["scope:project"],
        provenance: { runId: "run-1" }
      })
      const duplicate = yield* Effect.flip(store.putNote({
        namespace,
        id: "old",
        text: "attempted mutation",
        tags: ["scope:secret"],
        provenance: { runId: "run-2" }
      }))
      yield* store.putNote({
        namespace,
        id: "replacement",
        text: "new guidance",
        tags: ["scope:project"],
        provenance: { runId: "run-3" },
        status: "pending",
        supersedes: ["old"]
      })
      const pending = yield* store.listNotes({ namespace })
      yield* store.setNoteStatus({ id: "replacement", status: "accepted" })
      const accepted = yield* store.listNotes({ namespace })
      yield* store.setNoteStatus({ id: "replacement", status: "rejected" })
      const rejected = yield* store.listNotes({ namespace })
      const audit = yield* store.listNotes({ namespace, status: "any", includeSuperseded: true })
      return { duplicate, pending, accepted, rejected, audit }
    }))

    expect(result.duplicate).toMatchObject({
      code: "supersede_conflict",
      message: expect.stringContaining("different creation data")
    })
    expect(result.pending.map((note) => note.id)).toEqual(["old"])
    expect(result.accepted.map((note) => note.id)).toEqual(["replacement"])
    expect(result.rejected.map((note) => note.id)).toEqual(["old"])
    expect(result.audit.map((note) => [note.id, note.text])).toEqual([
      ["old", "old guidance"],
      ["replacement", "new guidance"]
    ])
  })

  it("rejects note id collisions and supersession edges across namespaces", async () => {
    const failures = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putNote({ namespace, id: "shared", text: "one", tags: [], provenance: {} })
      const collision = yield* Effect.flip(
        store.putNote({ namespace: other, id: "shared", text: "one", tags: [], provenance: {} })
      )
      yield* store.putNote({ namespace: other, id: "other", text: "two", tags: [], provenance: {} })
      const edge = yield* Effect.flip(store.supersede({ supersederId: "shared", targetId: "other" }))
      return { collision, edge }
    }))

    expect(failures.collision).toMatchObject({
      code: "supersede_conflict",
      message: expect.stringContaining("different creation data")
    })
    expect(failures.edge).toMatchObject({
      code: "supersede_conflict",
      message: expect.stringContaining("share a namespace")
    })
  })

  it("writes standalone supersession edges idempotently and rejects invalid edges", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putNote({
        namespace,
        id: "target",
        text: "target",
        tags: [],
        provenance: {}
      })
      yield* store.putNote({
        namespace,
        id: "superseder",
        text: "superseder",
        tags: [],
        provenance: {}
      })
      yield* store.supersede({ supersederId: "superseder", targetId: "target" })
      yield* store.supersede({ supersederId: "superseder", targetId: "target" })
      const visible = yield* store.listNotes({ namespace })
      const invalid = yield* Effect.flip(store.supersede({ supersederId: "missing", targetId: "target" }))
      return { visible, invalid }
    }))

    expect(result.visible.map((note) => note.id)).toEqual(["superseder"])
    expect(result.invalid.code).toBe("supersede_conflict")
  })

  it("rolls back an accompanying note when its supersession edge is invalid", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const failure = yield* Effect.flip(
        store.putNote({
          namespace,
          id: "must-roll-back",
          text: "not durable",
          tags: [],
          provenance: {},
          supersedes: ["missing"]
        })
      )
      const notes = yield* store.listNotes({ namespace, status: "any", includeSuperseded: true })
      return { failure, notes }
    }))

    expect(result.failure.code).toBe("supersede_conflict")
    expect(result.notes).toEqual([])
  })

  it("treats the normalized supersession set as immutable creation data", async () => {
    const result = await runWithDatabase(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* store.putNote({ namespace, id: "target-a", text: "a", tags: [], provenance: {} })
      yield* store.putNote({ namespace, id: "target-b", text: "b", tags: [], provenance: {} })
      const note = (id: string, supersedes: ReadonlyArray<string>) => ({
        namespace,
        id,
        text: "replacement",
        tags: [] as const,
        provenance: {},
        supersedes
      })

      yield* store.putNote(note("normalized", ["target-a", "target-b"]))
      yield* store.putNote(note("normalized", ["target-b", "target-a"]))
      yield* store.putNote(note("normalized", ["target-a", "target-a", "target-b"]))

      yield* store.putNote(note("added", ["target-a"]))
      const added = yield* Effect.flip(store.putNote(note("added", ["target-a", "target-b"])))
      yield* store.putNote(note("removed", ["target-a", "target-b"]))
      const removed = yield* Effect.flip(store.putNote(note("removed", ["target-a"])))
      yield* store.putNote(note("missing", []))
      const missing = yield* Effect.flip(store.putNote(note("missing", ["missing-target"])))
      const edges = yield* sql<{ readonly count: number }>`SELECT count(*) AS count
        FROM memory_note_supersedes WHERE superseder_id = 'normalized'`
      return { failures: [added, removed, missing], normalizedEdges: edges[0]?.count }
    }))

    expect(result.failures.map((failure) => failure.code)).toEqual([
      "supersede_conflict",
      "supersede_conflict",
      "supersede_conflict"
    ])
    expect(result.normalizedEdges).toBe(2)
  })

  it("accepts a creation retry after the note status changes", async () => {
    const retried = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const input = {
        namespace,
        id: "status-retry",
        text: "reviewed",
        tags: [] as const,
        provenance: { runId: "run" },
        status: "pending" as const
      }
      yield* store.putNote(input)
      yield* store.setNoteStatus({ id: input.id, status: "accepted" })
      return yield* store.putNote(input)
    }))

    expect(retried.status).toBe("accepted")
  })

  it("accepts equivalent note provenance with a different key order", async () => {
    const retried = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putNote({
        namespace,
        id: "provenance-retry",
        text: "same",
        tags: [],
        provenance: { runId: "run", nodeId: "node" }
      })
      return yield* store.putNote({
        namespace,
        id: "provenance-retry",
        text: "same",
        tags: [],
        provenance: { nodeId: "node", runId: "run" }
      })
    }))

    expect(retried.provenance).toEqual({ runId: "run", nodeId: "node" })
  })

  it("fails typed when an inserted note cannot be read back", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const opaqueSql = new Proxy(sql, {
          apply(target, thisArg, argumentsList) {
            const statement = Array.isArray(argumentsList[0]) ? argumentsList[0].join(" ") : ""
            return statement.includes("INSERT INTO memory_notes")
              ? { raw: Effect.succeed({ changes: 1 }) }
              : Reflect.apply(target, thisArg, argumentsList)
          }
        })
        const store = yield* MemoryStore.make.pipe(Effect.provideService(SqlClient.SqlClient, opaqueSql))
        return yield* Effect.flip(store.putNote({ namespace, id: "ghost", text: "t", tags: [], provenance: {} }))
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect([failure.code, failure.message]).toEqual([
      "store",
      "inserted note could not be read back"
    ])
  })

  it("rejects self-supersession and reports missing notes", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const onInsert = yield* Effect.flip(
        store.putNote({ namespace, id: "self", text: "t", tags: [], provenance: {}, supersedes: ["self"] })
      )
      const onEdge = yield* Effect.flip(store.supersede({ supersederId: "same", targetId: "same" }))
      const absent = yield* store.getNote({ id: "absent" })
      const unknownStatus = yield* Effect.flip(store.setNoteStatus({ id: "absent", status: "accepted" }))
      return { onInsert, onEdge, absent, unknownStatus }
    }))

    expect([result.onInsert.code, result.onInsert.message]).toEqual([
      "supersede_conflict",
      "a note cannot supersede itself"
    ])
    expect([result.onEdge.code, result.onEdge.message]).toEqual([
      "supersede_conflict",
      "a note cannot supersede itself"
    ])
    expect(result.absent).toBeUndefined()
    expect([result.unknownStatus.code, result.unknownStatus.message]).toEqual([
      "not_found",
      "memory note \"absent\" was not found"
    ])
  })

  it("selects notes by a status list, a single tag group, and a group list", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putNote({ namespace, id: "accepted", text: "a", tags: ["scope:project"], provenance: {} })
      yield* store.putNote({
        namespace,
        id: "pending",
        text: "p",
        tags: ["scope:project", "branch:main"],
        provenance: {},
        status: "pending"
      })
      yield* store.putNote({ namespace, id: "rejected", text: "r", tags: [], provenance: {}, status: "rejected" })
      const byDefault = yield* store.listNotes({ namespace })
      const byList = yield* store.listNotes({ namespace, status: ["pending", "rejected"] })
      const byGroup = yield* store.listNotes({
        namespace,
        status: "any",
        tagGroups: [{ tags: ["branch:main"], match: "all_strict" }]
      })
      const byGroups = yield* store.listNotes({
        namespace,
        status: "any",
        tagGroups: [
          { tags: ["scope:project"], match: "all_strict" },
          { not: { tags: ["branch:main"], match: "any_strict" } }
        ]
      })
      const byBank = yield* store.listNotes({ namespace: "project-1" })
      return { byDefault, byList, byGroup, byGroups, byBank }
    }))

    expect(result.byDefault.map((note) => note.id)).toEqual(["accepted"])
    expect(result.byList.map((note) => note.id)).toEqual(["pending", "rejected"])
    expect(result.byGroup.map((note) => note.id)).toEqual(["pending"])
    expect(result.byGroups.map((note) => note.id)).toEqual(["accepted"])
    expect(result.byBank.map((note) => note.id)).toEqual(["accepted"])
  })

  it("counts the limit against notes that survive supersession", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putNote({ namespace, id: "a-old", text: "old", tags: [], provenance: {} })
      yield* store.putNote({ namespace, id: "b-new", text: "new", tags: [], provenance: {}, supersedes: ["a-old"] })
      return {
        limited: yield* store.listNotes({ namespace, limit: 1 }),
        unlimited: yield* store.listNotes({ namespace })
      }
    }))

    expect(result.limited.map((note) => note.id)).toEqual(["b-new"])
    expect(result.limited).toEqual(result.unlimited)
  })

  it("answers a zero limit without reading, and honours a note id prefix", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putFact({ namespace, key: "keep", value: "v", provenance: {} })
      yield* store.putNote({ namespace, id: "keep-me", text: "t", tags: [], provenance: {} })
      yield* store.putNote({ namespace, id: "drop-me", text: "t", tags: [], provenance: {} })
      yield* store.appendMessage({ threadId: "thread", id: "m-0", role: "user", text: "a", at: 0 })
      return {
        facts: yield* store.listFacts({ namespace, limit: 0 }),
        notes: yield* store.listNotes({ namespace, limit: 0 }),
        messages: yield* store.listMessages({ threadId: "thread", limit: 0 }),
        prefixed: yield* store.listNotes({ namespace, prefix: "keep-" }),
        // An empty namespace ends the tag-filtered page walk on its first page.
        emptyPage: yield* store.listNotes({
          namespace: other,
          tagGroups: [{ tags: ["scope:project"] }],
          limit: 2
        })
      }
    }))

    expect(result.facts).toEqual([])
    expect(result.notes).toEqual([])
    expect(result.messages).toEqual([])
    expect(result.prefixed.map((note) => note.id)).toEqual(["keep-me"])
    expect(result.emptyPage).toEqual([])
  })

  it.each(
    [
      ["notes ascending", "insert"],
      ["notes descending", "insert"],
      ["facts descending", "insert"],
      ["notes ascending", "delete"],
      ["notes descending", "delete"],
      ["facts descending", "delete"]
    ] as const
  )("continues %s without duplicates or skips after a concurrent %s", async (mode, mutation) => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const original = yield* MemoryStore.MemoryStore
        const facts = mode === "facts descending"
        for (let index = 0; index < 260; index++) {
          const id = `row-${String(index).padStart(3, "0")}`
          const tags: Namespace.Tags = [
            index === 127 || index === 128 || index === 259 ? "scope:project" : "scope:other"
          ]
          if (facts) yield* original.putFact({ namespace, key: id, value: "v", tags, provenance: {} })
          else yield* original.putNote({ namespace, id, text: "v", tags, provenance: {} })
        }
        let pages = 0
        const statements: Array<string> = []
        const interleaved = new Proxy(sql, {
          apply(target, thisArg, argumentsList) {
            const statement = Array.isArray(argumentsList[0]) ? argumentsList[0].join(" ") : ""
            const query = Reflect.apply(target, thisArg, argumentsList)
            if (
              !statement.includes(facts ? "FROM memory_facts" : "FROM memory_notes notes") ||
              !statement.includes("LIMIT")
            ) return query
            statements.push(statement)
            return query.pipe(Effect.tap(() =>
              Effect.gen(function*() {
                pages += 1
                if (pages !== 1) return
                if (mutation === "delete") {
                  if (facts) yield* sql`DELETE FROM memory_facts WHERE fact_key = 'row-000'`
                  else yield* sql`DELETE FROM memory_notes WHERE id = 'row-000'`
                } else if (facts) {
                  yield* original.putFact({
                    namespace,
                    key: "row--new",
                    value: "v",
                    tags: ["scope:other"],
                    provenance: {}
                  })
                } else {
                  yield* original.putNote({
                    namespace,
                    id: "row--new",
                    text: "v",
                    tags: ["scope:other"],
                    provenance: {}
                  })
                }
              })
            ))
          }
        })
        const store = yield* MemoryStore.make.pipe(Effect.provideService(SqlClient.SqlClient, interleaved))
        const input: MemoryStore.ListNotesInput = {
          namespace,
          limit: 4,
          tagGroups: [{ tags: ["scope:project"], match: "any_strict" as const }]
        }
        const rows = mode === "notes ascending" ? yield* store.listNotes(input) : yield* store.searchRows(input)
        return { ids: rows.map((row) => row.id), statements, pages }
      }).pipe(Effect.provide(TestMemory.layerWithDatabase), Effect.provide(TestClock.layer()))
    )
    expect(result.ids).toEqual(["row-127", "row-128", "row-259"])
    expect(result.pages).toBe(3)
    expect(result.statements.every((statement) => !statement.includes("OFFSET"))).toBe(true)
  })
})
