import * as DurableWriter from "@smthrs/database/DurableWriter"
import { Effect, Layer, Option } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as SqlError from "effect/unstable/sql/SqlError"
import { describe, expect, expectTypeOf, it } from "vitest"
import { MemoryError } from "../src/MemoryError.ts"
import * as MemoryStore from "../src/MemoryStore.ts"
import type * as Namespace from "../src/Namespace.ts"
import { literalFtsQuery } from "../src/RecallFts.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

const namespace = { kind: "flow", id: "project-1" } as const
const other = { kind: "flow", id: "project-2" } as const

const run = <A, E>(effect: Effect.Effect<A, E, MemoryStore.MemoryStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestMemory.layer), Effect.provide(TestClock.layer())))

const runWithDatabase = <A, E>(
  effect: Effect.Effect<A, E, MemoryStore.MemoryStore | SqlClient.SqlClient>
) => Effect.runPromise(effect.pipe(Effect.provide(TestMemory.layerWithDatabase)))

// Every message down a failure's cause chain, through SqlError reasons too.
const causeMessages = (cause: unknown): ReadonlyArray<string> => {
  const messages: Array<string> = []
  const seen = new Set<unknown>()
  let current = cause
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current)
    const record = current as { message?: unknown; cause?: unknown; reason?: unknown }
    if (typeof record.message === "string") messages.push(record.message)
    current = SqlError.isSqlError(current) ? current.reason.cause : (record.cause ?? record.reason)
  }
  return messages
}

describe("MemoryStore", () => {
  it("exposes only the plural tag-group input", () => {
    expectTypeOf<MemoryStore.ListNotesInput>().not.toHaveProperty("tagGroup")
  })

  it("applies the authoritative and projection schemas idempotently", async () => {
    const tables = await Effect.runPromise(
      Effect.gen(function*() {
        yield* MemoryStore.MemoryStore
        yield* MemoryStore.make
        yield* MemoryStore.make
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const rows = yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'table' AND name LIKE 'memory_%'
          ORDER BY name
        `
        return rows.map((row) => row.name)
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(tables).toEqual([
      "memory_facts",
      "memory_fts_kinds",
      "memory_messages",
      "memory_note_supersedes",
      "memory_notes",
      "memory_threads",
      "memory_vectors"
    ])
  })

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

  it("accepts validated bank strings uniformly across namespace-bearing operations", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putFact({ namespace: "agent-team", key: "fact", value: "value", provenance: {} })
      const fact = yield* store.getFact({ namespace: "agent-team", key: "fact" })
      const facts = yield* store.listFacts({ namespace: "agent-team" })
      const thread = yield* store.createThread({ id: "thread-bank", namespace: "agent-team" })
      const threads = yield* store.listThreads({ namespace: "agent-team" })
      const note = yield* store.putNote({
        namespace: "agent-team",
        id: "note-bank",
        text: "note",
        tags: [],
        provenance: {}
      })
      const deleted = yield* store.deleteFact({ namespace: "agent-team", key: "fact" })
      return { fact, facts, thread, threads, note, deleted }
    }))

    expect(result.fact?.namespace).toEqual({ kind: "agent", id: "team" })
    expect(result.facts).toHaveLength(1)
    expect(result.thread.namespace).toEqual({ kind: "agent", id: "team" })
    expect(result.threads.map((thread) => thread.id)).toEqual(["thread-bank"])
    expect(result.note.namespace).toEqual({ kind: "agent", id: "team" })
    expect(result.deleted).toBe(true)
  })

  it("paginates messages by the stable at-and-id cursor", async () => {
    const pages = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      for (
        const message of [
          { threadId: "paged", id: "a", role: "user", text: "a", at: 1 },
          { threadId: "paged", id: "b", role: "user", text: "b", at: 2 },
          { threadId: "paged", id: "c", role: "user", text: "c", at: 2 }
        ]
      ) yield* store.appendMessage(message)
      const first = yield* store.listMessages({ threadId: "paged", limit: 2 })
      const last = first.at(-1)!
      const second = yield* store.listMessages({
        threadId: "paged",
        limit: 2,
        cursor: { at: last.at, id: last.id }
      })
      return { first, second }
    }))

    expect(pages.first.map((message) => message.id)).toEqual(["a", "b"])
    expect(pages.second.map((message) => message.id)).toEqual(["c"])
  })

  it("appends ordered history and accepts an exact same-payload retry", async () => {
    const messages = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.appendMessage({ threadId: "thread-1", id: "b", role: "assistant", text: "second", at: 2 })
      yield* store.appendMessage({ threadId: "thread-1", id: "a", role: "user", text: "first", at: 1 })
      yield* store.appendMessage({ threadId: "thread-1", id: "a", role: "user", text: "first", at: 1 })
      return yield* store.listMessages({ threadId: "thread-1" })
    }))

    expect(messages).toEqual([
      { threadId: "thread-1", id: "a", role: "user", text: "first", at: 1 },
      { threadId: "thread-1", id: "b", role: "assistant", text: "second", at: 2 }
    ])
  })

  it("scopes message ids to their thread", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const first = { threadId: "thread-1", id: "shared", role: "user", text: "first", at: 1 } as const
      const second = { threadId: "thread-2", id: "shared", role: "assistant", text: "second", at: 2 } as const
      yield* store.appendMessage(first)
      yield* store.appendMessage(second)
      return yield* Effect.all([
        store.listMessages({ threadId: first.threadId }),
        store.listMessages({ threadId: second.threadId })
      ])
    }))

    expect(result).toEqual([
      [{ threadId: "thread-1", id: "shared", role: "user", text: "first", at: 1 }],
      [{ threadId: "thread-2", id: "shared", role: "assistant", text: "second", at: 2 }]
    ])
  })

  it("rejects same-thread message retries whose immutable fields differ", async () => {
    const failures = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const original = { threadId: "thread", id: "message", role: "user", text: "original", at: 1 } as const
      yield* store.appendMessage(original)
      return [
        yield* Effect.flip(store.appendMessage({ ...original, role: "assistant" })),
        yield* Effect.flip(store.appendMessage({ ...original, text: "changed" })),
        yield* Effect.flip(store.appendMessage({ ...original, at: 2 }))
      ]
    }))

    expect(failures.map((failure) => [failure.code, failure.path])).toEqual([
      ["idempotency_conflict", ["role"]],
      ["idempotency_conflict", ["text"]],
      ["idempotency_conflict", ["at"]]
    ])
  })

  it("supports the complete fact, thread, note, and message contract", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putFact({ namespace, key: "delete-me", value: "value", provenance: {} })
      const allFacts = yield* store.listAllFacts
      const deletedFact = yield* store.deleteFact({ namespace, key: "delete-me" })
      const thread = yield* store.createThread({
        id: "thread-crud",
        namespace,
        title: "Review",
        metadata: { branch: "main" }
      })
      yield* store.appendMessage({
        threadId: thread.id,
        id: "message-1",
        role: "user",
        text: "hello",
        at: 1
      })
      const count = yield* store.countMessages({ threadId: thread.id })
      const fetched = yield* store.getThread({ threadId: thread.id })
      const threads = yield* store.listThreads({ namespace })
      yield* store.putNote({
        namespace,
        id: "get-note",
        text: "note",
        tags: [],
        provenance: {}
      })
      const note = yield* store.getNote({ id: "get-note" })
      const deletedThread = yield* store.deleteThread({ threadId: thread.id })
      const missing = yield* store.getThread({ threadId: thread.id })
      return {
        allFacts,
        deletedFact,
        count,
        fetched,
        threads,
        note,
        deletedThread,
        missing
      }
    }))

    expect(result.allFacts.map((fact) => fact.key)).toEqual(["delete-me"])
    expect(result.deletedFact).toBe(true)
    expect(result.count).toBe(1)
    expect(result.fetched).toMatchObject({ title: "Review", metadata: { branch: "main" } })
    expect(result.threads.map((thread) => thread.id)).toEqual(["thread-crud"])
    expect(result.note).toMatchObject({ id: "get-note", text: "note" })
    expect(result.deletedThread).toBe(true)
    expect(result.missing).toBeUndefined()
  })

  it("keeps equal record ids authoritative across namespaces without implicit vectors", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* store.putFact({
          namespace: { kind: "flow", id: "one" },
          key: "shared",
          value: "first",
          provenance: {}
        })
        yield* store.putFact({
          namespace: { kind: "flow", id: "two" },
          key: "shared",
          value: "second",
          provenance: {}
        })
        const rows = yield* sql<{ readonly namespace_id: string }>`
          SELECT namespace_id FROM memory_vectors
          WHERE record_kind = 'fact' AND record_id = 'shared'
          ORDER BY namespace_id
        `
        const facts = yield* Effect.all([
          store.getFact({ namespace: { kind: "flow", id: "one" }, key: "shared" }),
          store.getFact({ namespace: { kind: "flow", id: "two" }, key: "shared" })
        ])
        return { rows, facts }
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(result.rows).toEqual([])
    expect(result.facts.map((fact) => fact?.value)).toEqual(["first", "second"])
  })

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

  it("filters authoritative raw rows by tags, status, and supersession", async () => {
    const rows = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putFact({
        namespace,
        key: "fact-1",
        value: { content: "fact text", tags: ["scope:project"] },
        provenance: {}
      })
      yield* store.putNote({
        namespace,
        id: "note-1",
        text: "note text",
        tags: ["scope:project", "branch:main"],
        provenance: {}
      })
      yield* store.putNote({
        namespace,
        id: "pending",
        text: "not authoritative",
        tags: ["scope:project"],
        provenance: {},
        status: "pending"
      })
      return yield* store.searchRows({
        namespace,
        tagGroups: [
          { tags: ["scope:project"], match: "all_strict" },
          { not: { tags: ["scope:secret"], match: "any_strict" } }
        ]
      })
    }))

    expect(rows.map((row) => [row.kind, row.key, row.text])).toEqual([
      ["fact", "fact-1", "fact text"],
      ["note", "note-1", "note text"]
    ])
    expect(rows.every((row) => row.bank === "flow-project-1")).toBe(true)
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

  it("fails loudly before FTS enablement, then backfills and updates the per-kind index", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putFact({
        namespace,
        key: "runbook",
        value: { content: "durable checkout recovery", tags: ["scope:project"] },
        provenance: {}
      })
      yield* store.putNote({
        namespace,
        id: "note-fts",
        text: "durable release checklist",
        tags: ["scope:project"],
        provenance: {}
      })
      const disabled = yield* Effect.flip(store.searchFts({ namespace, query: "durable", limit: 10 }))
      yield* store.enableFts("flow")
      const backfilled = yield* store.searchFts({ namespace, query: "durable", limit: 10 })
      yield* store.putFact({
        namespace,
        key: "runbook",
        value: { content: "fresh recovery procedure", tags: ["scope:project"] },
        provenance: {}
      })
      const stale = yield* store.searchFts({ namespace, query: "checkout", limit: 10 })
      const fresh = yield* store.searchFts({ namespace, query: "fresh recovery", limit: 10 })
      const compiled = yield* store.searchFts({
        namespace,
        query: literalFtsQuery("fresh recovery"),
        limit: 10
      })
      return { disabled, backfilled, stale, fresh, compiled }
    }))

    expect(result.disabled.code).toBe("fts_not_enabled")
    expect(result.backfilled.map((row) => row.key).sort()).toEqual(["note-fts", "runbook"])
    expect(result.stale).toEqual([])
    expect(result.fresh.map((row) => row.key)).toEqual(["runbook"])
    expect(result.compiled.map((row) => row.key)).toEqual(["runbook"])
    expect(result.fresh[0]?.rank).toEqual(expect.any(Number))
  })

  it("indexes backfilled facts with the same text and query semantics as live writes", async () => {
    const vectors = [
      { value: "rootstringtoken", queries: [["rootstringtoken", true]] as const },
      {
        value: {
          content: "contenttoken",
          tags: ["scope:tagonlytoken"],
          hiddenkeytoken: "ignored"
        },
        queries: [["contenttoken", true], ["tagonlytoken", false], ["hiddenkeytoken", false]] as const
      },
      {
        value: { indexedkeytoken: "objectvaluetoken" },
        queries: [["objectvaluetoken", true], ["indexedkeytoken", true]] as const
      },
      { value: ["arraytoken"], queries: [["arraytoken", true]] as const },
      { value: "Unicode café 東京", queries: [["café", true], ["東京", true]] as const }
    ] as const
    const result = await runWithDatabase(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      for (const [index, vector] of vectors.entries()) {
        yield* store.putFact({ namespace, key: `before-${index}`, value: vector.value, provenance: {} })
      }
      yield* store.enableFts("flow")
      for (const [index, vector] of vectors.entries()) {
        yield* store.putFact({ namespace, key: `after-${index}`, value: vector.value, provenance: {} })
      }
      const rows = yield* sql<{ readonly record_id: string; readonly text: string }>`
        SELECT record_id, text FROM memory_fts_flow
        WHERE namespace_id = 'project-1' AND record_kind = 'fact'
        ORDER BY record_id
      `
      const matches: Array<readonly [string, boolean, ReadonlyArray<string>]> = []
      for (const vector of vectors) {
        for (const [query, expectedMatch] of vector.queries) {
          const found = yield* store.searchFts({ namespace, query, limit: 20 })
          matches.push([query, expectedMatch, found.map((row) => row.id).sort()])
        }
      }
      return { rows, matches }
    }))

    const textById = new Map(result.rows.map((row) => [row.record_id, row.text]))
    for (const index of vectors.keys()) {
      expect(textById.get(`before-${index}`)).toBe(textById.get(`after-${index}`))
    }
    for (const [query, expectedMatch, ids] of result.matches) {
      const index = vectors.findIndex((vector) => vector.queries.some(([term]) => term === query))
      expect(ids).toEqual(expectedMatch ? [`after-${index}`, `before-${index}`] : [])
    }
  })

  it("validates namespaces, identifiers, tags, and times before touching the database", async () => {
    const failures = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const overCap = Array.from({ length: 17 }, (_, index) => `scope:${index}`) as unknown as Namespace.Tags
      return [
        yield* Effect.flip(
          store.putFact({ namespace: { kind: "flow", id: "" }, key: "k", value: 1, provenance: {} })
        ),
        yield* Effect.flip(store.putFact({ namespace, key: "", value: 1, provenance: {} })),
        yield* Effect.flip(store.putFact({ namespace, key: "k", value: 1, ttlMs: -1, provenance: {} })),
        yield* Effect.flip(store.putFact({ namespace, key: "k", value: 1, ttlMs: 1.5, provenance: {} })),
        yield* Effect.flip(
          store.putNote({
            namespace,
            id: "n",
            text: "t",
            tags: ["vendor:x"] as unknown as Namespace.Tags,
            provenance: {}
          })
        ),
        yield* Effect.flip(store.putNote({ namespace, id: "n", text: "t", tags: overCap, provenance: {} })),
        yield* Effect.flip(store.putNote({ namespace, id: "", text: "t", tags: [], provenance: {} })),
        yield* Effect.flip(store.createThread({ namespace, id: "" })),
        yield* Effect.flip(store.appendMessage({ threadId: "", id: "m", role: "user", text: "x", at: 0 })),
        yield* Effect.flip(store.appendMessage({ threadId: "t", id: "", role: "user", text: "x", at: 0 })),
        yield* Effect.flip(store.appendMessage({ threadId: "t", id: "m", role: "", text: "x", at: 0 })),
        yield* Effect.flip(store.appendMessage({ threadId: "t", id: "m", role: "user", text: "x", at: -1 })),
        yield* Effect.flip(store.getFact({ namespace, key: "" })),
        yield* Effect.flip(store.deleteFact({ namespace, key: "" })),
        yield* Effect.flip(store.getThread({ threadId: "" })),
        yield* Effect.flip(store.deleteThread({ threadId: "" })),
        yield* Effect.flip(store.listMessages({ threadId: "" })),
        yield* Effect.flip(store.countMessages({ threadId: "" })),
        yield* Effect.flip(store.deleteMessages({ threadId: "", ids: ["a"] })),
        yield* Effect.flip(store.getNote({ id: "" })),
        yield* Effect.flip(store.setNoteStatus({ id: "", status: "accepted" })),
        yield* Effect.flip(store.supersede({ supersederId: "", targetId: "t" })),
        yield* Effect.flip(store.supersede({ supersederId: "s", targetId: "" }))
      ]
    }))

    expect(failures.map((error) => [error.code, error.path])).toEqual([
      ["invalid_namespace", undefined],
      ["invalid_argument", ["key"]],
      ["invalid_argument", ["ttlMs"]],
      ["invalid_argument", ["ttlMs"]],
      ["invalid_tag", undefined],
      ["invalid_tag", undefined],
      ["invalid_argument", ["id"]],
      ["invalid_argument", ["id"]],
      ["invalid_argument", ["threadId"]],
      ["invalid_argument", ["id"]],
      ["invalid_argument", ["role"]],
      ["invalid_argument", ["at"]],
      ["invalid_argument", ["key"]],
      ["invalid_argument", ["key"]],
      ["invalid_argument", ["threadId"]],
      ["invalid_argument", ["threadId"]],
      ["invalid_argument", ["threadId"]],
      ["invalid_argument", ["threadId"]],
      ["invalid_argument", ["threadId"]],
      ["invalid_argument", ["id"]],
      ["invalid_argument", ["id"]],
      ["invalid_argument", ["supersederId"]],
      ["invalid_argument", ["targetId"]]
    ])
    expect(failures.every((error) => error.cause === undefined)).toBe(true)
  })

  it("refuses a value, provenance, or metadata JSON cannot represent", async () => {
    const failures = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const unserializable = { runId: 1n as unknown as string }
      return [
        yield* Effect.flip(store.putFact({ namespace, key: "absent", value: undefined, provenance: {} })),
        yield* Effect.flip(store.putFact({ namespace, key: "big", value: 1n, provenance: {} })),
        yield* Effect.flip(store.putFact({ namespace, key: "k", value: 1, provenance: unserializable })),
        yield* Effect.flip(store.putNote({ namespace, id: "n", text: "t", tags: [], provenance: unserializable })),
        yield* Effect.flip(store.createThread({ namespace, metadata: 1n }))
      ]
    }))

    expect(failures.map((error) => [error.code, error.path, error.cause])).toEqual([
      ["invalid_argument", ["value"], undefined],
      ["invalid_argument", ["value"], undefined],
      ["invalid_argument", ["provenance"], undefined],
      ["invalid_argument", ["provenance"], undefined],
      ["invalid_argument", ["metadata"], undefined]
    ])
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

  it("creates a thread with a generated id and omits absent optional columns", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const bare = yield* store.createThread({ namespace })
      const fetched = yield* store.getThread({ threadId: bare.id })
      const duplicate = yield* Effect.flip(store.createThread({ id: bare.id, namespace: other, title: "ignored" }))
      const all = yield* store.listThreads()
      const scoped = yield* store.listThreads({ namespace: other })
      const ids = yield* store.listThreadIds
      const missing = yield* store.deleteThread({ threadId: "absent" })
      return { bare, fetched, duplicate, all, scoped, ids, missing }
    }))

    expect(result.bare.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.bare).not.toHaveProperty("title")
    expect(result.bare).not.toHaveProperty("metadata")
    expect(result.fetched).toEqual(result.bare)
    // A replaying caller must be able to tell "this thread already landed" from
    // "the database is broken", so the conflict carries its own code and path
    // rather than the generic backend failure.
    expect(result.duplicate).toMatchObject({
      code: "idempotency_conflict",
      path: ["threadId"],
      message: expect.stringContaining("different creation data")
    })
    expect(result.all).toEqual([result.bare])
    expect(result.scoped).toEqual([])
    expect(result.ids).toEqual([result.bare.id])
    expect(result.missing).toBe(false)
  })

  it("rolls back a generated thread when its transactional read back fails", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        let inserted = false
        const failingSql = new Proxy(sql, {
          apply(target, thisArg, argumentsList) {
            const statement = Array.isArray(argumentsList[0]) ? argumentsList[0].join(" ") : ""
            if (statement.includes("INSERT INTO memory_threads")) {
              inserted = true
            } else if (inserted && statement.includes("FROM memory_threads WHERE thread_id")) {
              return Effect.fail(new Error("injected thread read failure"))
            }
            return Reflect.apply(target, thisArg, argumentsList)
          }
        })
        const failingStore = yield* MemoryStore.make.pipe(
          Effect.provideService(SqlClient.SqlClient, failingSql)
        )
        const failure = yield* Effect.flip(failingStore.createThread({ namespace }))
        const store = yield* MemoryStore.MemoryStore
        const retried = yield* store.createThread({ namespace })
        const threads = yield* store.listThreads({ namespace })
        return { failure, retried, threads }
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(result.failure.code).toBe("store")
    expect(result.threads).toEqual([result.retried])
  })

  // A driver that reports neither `changes` nor `rowsAffected` reads as "no row
  // written", which sends createThread down its read-back branch with nothing
  // to read. It must fail typed rather than return a half-built thread.
  it("fails typed when the driver reports no write and the row is absent", async () => {
    const failures = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        // Neither a scalar nor an object without a row count tells the store a
        // row landed; both must take the read-back branch.
        const answers = [Effect.succeed("opaque driver answer"), Effect.succeed({ ok: true })]
        const opaqueSql = new Proxy(sql, {
          apply(target, thisArg, argumentsList) {
            const statement = Array.isArray(argumentsList[0]) ? argumentsList[0].join(" ") : ""
            return statement.includes("INSERT INTO memory_threads")
              ? { raw: answers.shift() ?? Effect.succeed({}) }
              : Reflect.apply(target, thisArg, argumentsList)
          }
        })
        const store = yield* MemoryStore.make.pipe(Effect.provideService(SqlClient.SqlClient, opaqueSql))
        return [
          yield* Effect.flip(store.createThread({ id: "opaque-scalar", namespace })),
          yield* Effect.flip(store.createThread({ id: "opaque-object", namespace }))
        ]
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(failures.map((failure) => [failure.code, failure.message])).toEqual([
      ["store", "created memory thread could not be read back"],
      ["store", "created memory thread could not be read back"]
    ])
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

  it("summarizes a non-Error failure cause without leaking an unbounded value", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const failingSql = new Proxy(sql, {
          apply(target, thisArg, argumentsList) {
            const statement = Array.isArray(argumentsList[0]) ? argumentsList[0].join(" ") : ""
            return statement.includes("FROM memory_notes")
              ? Effect.fail("x".repeat(2_000))
              : Reflect.apply(target, thisArg, argumentsList)
          }
        })
        const store = yield* MemoryStore.make.pipe(Effect.provideService(SqlClient.SqlClient, failingSql))
        return yield* Effect.flip(store.listNotes({ namespace }))
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(failure.code).toBe("store")
    expect(failure.cause).toBe("x".repeat(1_024))
  })

  it("keeps an Error cause whole so its SQL code survives", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const driverError = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
        const failingSql = new Proxy(sql, {
          apply(target, thisArg, argumentsList) {
            const statement = Array.isArray(argumentsList[0]) ? argumentsList[0].join(" ") : ""
            return statement.includes("FROM memory_notes")
              ? Effect.fail(driverError)
              : Reflect.apply(target, thisArg, argumentsList)
          }
        })
        const store = yield* MemoryStore.make.pipe(Effect.provideService(SqlClient.SqlClient, failingSql))
        return { driverError, failure: yield* Effect.flip(store.listNotes({ namespace })) }
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(failure.failure.code).toBe("store")
    expect(failure.failure.cause).toBe(failure.driverError)
  })

  // DurableWriter's contract: the outermost write classifies retry by walking
  // the cause chain, even after a nested store wrapped the failure in a domain
  // error. A memory write nested in a host transaction must replay on a
  // transient busy failure exactly like a plain nested write does.
  it("replays a host write that nests a memory write over one transient busy failure", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const real = yield* DurableWriter.DurableWriter
        let attempts = 0
        const busy = () =>
          new SqlError.SqlError({
            reason: new SqlError.LockTimeoutError({
              cause: Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" })
            })
          })
        const injected = DurableWriter.DurableWriter.of({
          write: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            real.write(Effect.suspend(() => {
              attempts += 1
              return attempts === 1 ? (Effect.fail(busy()) as unknown as Effect.Effect<A, E, R>) : effect
            }))
        })
        const store = yield* MemoryStore.make.pipe(Effect.provideService(DurableWriter.DurableWriter, injected))

        attempts = 0
        const control = yield* Effect.exit(real.write(injected.write(sql`SELECT 1`)))
        const controlAttempts = attempts

        attempts = 0
        const nested = yield* Effect.exit(
          real.write(store.putFact({ namespace, key: "nested", value: "v", provenance: {} }))
        )
        const stored = yield* store.getFact({ namespace, key: "nested" })
        return {
          control: [control._tag, controlAttempts],
          nested: [nested._tag, attempts],
          stored: stored?.value
        }
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(result.control).toEqual(["Success", 2])
    expect(result.nested).toEqual(["Success", 2])
    expect(result.stored).toBe("v")
  })

  it("accepts equivalent thread metadata with a different key order", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const first = yield* store.createThread({
        id: "metadata-retry",
        namespace,
        metadata: { alpha: 1, nested: { left: true, right: false } }
      })
      const retried = yield* store.createThread({
        id: "metadata-retry",
        namespace,
        metadata: { nested: { right: false, left: true }, alpha: 1 }
      })
      return { first, retried, threads: yield* store.listThreads({ namespace }) }
    }))

    expect(result.retried).toEqual(result.first)
    expect(result.threads).toEqual([result.first])
  })

  it("answers a thread's message count and text-size bounds in one read", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const empty = yield* store.messageStats({ threadId: "absent" })
      yield* store.appendMessage({ threadId: "thread", id: "ascii", role: "user", text: "abc", at: 0 })
      const ascii = yield* store.messageStats({ threadId: "thread" })
      yield* store.appendMessage({ threadId: "thread", id: "emoji", role: "user", text: "é😀", at: 1 })
      yield* store.appendMessage({ threadId: "other", id: "other", role: "user", text: "zzzz", at: 0 })
      const mixed = yield* store.messageStats({ threadId: "thread" })
      const invalid = yield* Effect.flip(store.messageStats({ threadId: "" }))
      return { empty, ascii, mixed, invalid }
    }))

    expect(result.empty).toEqual({ messages: 0, codePoints: 0, bytes: 0 })
    expect(result.ascii).toEqual({ messages: 1, codePoints: 3, bytes: 3 })
    // "é😀" is 2 code points, 3 JavaScript code units, and 6 UTF-8 bytes.
    expect(result.mixed).toEqual({ messages: 2, codePoints: 5, bytes: 9 })
    expect([result.invalid.code, result.invalid.path]).toEqual(["invalid_argument", ["threadId"]])
  })

  it("counts, de-duplicates, chunks, and compacts messages at their boundaries", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const emptyCount = yield* store.countMessages({ threadId: "absent" })
      const noIds = yield* store.deleteMessages({ threadId: "thread", ids: [] })
      yield* store.appendMessage({ threadId: "thread", id: "m-0", role: "user", text: "a", at: 0 })
      yield* store.appendMessage({ threadId: "thread", id: "m-899", role: "user", text: "b", at: 1 })
      yield* store.appendMessage({ threadId: "thread", id: "m-900", role: "user", text: "c", at: 2 })
      const duplicates = yield* store.deleteMessages({ threadId: "thread", ids: ["m-0", "m-0"] })
      const chunked = yield* store.deleteMessages({
        threadId: "thread",
        ids: Array.from({ length: 901 }, (_, index) => `m-${index}`)
      })
      const mismatched = yield* Effect.flip(store.compactMessages({
        threadId: "thread",
        summary: { threadId: "other", id: "summary", role: "system", text: "s", at: 0 },
        sourceMessages: []
      }))
      const summaryOnly = yield* store.compactMessages({
        threadId: "thread",
        summary: { threadId: "thread", id: "summary", role: "system", text: "s", at: 0 },
        sourceMessages: [{ threadId: "thread", id: "summary", role: "system", text: "s", at: 0 }]
      })
      const unknownThread = yield* Effect.flip(store.compactMessages({
        threadId: "ghost",
        summary: { threadId: "ghost", id: "ghost-summary", role: "system", text: "s", at: 0 },
        sourceMessages: [{ threadId: "ghost", id: "ghost-message", role: "user", text: "s", at: 0 }]
      }))
      const remaining = yield* store.countMessages({ threadId: "thread" })
      return { emptyCount, noIds, duplicates, chunked, mismatched, summaryOnly, unknownThread, remaining }
    }))

    expect(result.emptyCount).toBe(0)
    expect(result.noIds).toBe(0)
    expect(result.duplicates).toBe(1)
    expect(result.chunked).toBe(2)
    expect([result.mismatched.code, result.mismatched.path]).toEqual([
      "invalid_argument",
      ["summary", "threadId"]
    ])
    expect(result.summaryOnly).toBe(0)
    expect([result.unknownThread.code, result.unknownThread.message]).toEqual([
      "compaction_conflict",
      "source message \"ghost-message\" changed or disappeared before compaction"
    ])
    expect(result.remaining).toBe(0)
  })

  it.each([
    ["id", ""],
    ["role", ""],
    ["at", -5],
    ["at", Number.MAX_SAFE_INTEGER + 1],
    ["at", Number.NaN]
  ])("validates compaction summary %s=%s before writing", async (field, value) => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const source = { threadId: "thread", id: "source", role: "user", text: "original", at: 1 }
      yield* store.appendMessage(source)
      const outcome = yield* Effect.result(store.compactMessages({
        threadId: "thread",
        summary: { threadId: "thread", id: "summary", role: "system", text: "s", at: 0, [field]: value },
        sourceMessages: [source]
      }))
      return { outcome, source, messages: yield* store.listMessages({ threadId: "thread" }) }
    }))

    expect(result.outcome).toMatchObject({
      _tag: "Failure",
      failure: { code: "invalid_argument", path: ["summary", field] }
    })
    expect(result.messages).toEqual([result.source])
  })

  it.each(["role", "text", "at", "missing"] as const)(
    "rejects changed source %s without touching history",
    async (field) => {
      const result = await run(Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const source = { threadId: "thread", id: "source", role: "user", text: "original", at: 1 }
        yield* store.appendMessage(source)
        yield* store.deleteMessages({ threadId: "thread", ids: [source.id] })
        if (field !== "missing") {
          yield* store.appendMessage({ ...source, [field]: field === "at" ? 2 : "changed" })
        }
        const before = yield* store.listMessages({ threadId: "thread" })
        const failure = yield* Effect.flip(store.compactMessages({
          threadId: "thread",
          summary: { threadId: "thread", id: "summary", role: "system", text: "stale", at: 0 },
          sourceMessages: [source]
        }))
        return { before, failure, after: yield* store.listMessages({ threadId: "thread" }) }
      }))

      expect(result.failure).toMatchObject({ code: "compaction_conflict", path: ["sourceMessages"] })
      expect(result.after).toEqual(result.before)
    }
  )

  it("captures compaction input before its Effect runs and de-duplicates sources", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const source = { threadId: "thread", id: "source", role: "user", text: "original", at: 1 }
      yield* store.appendMessage(source)
      const input = {
        threadId: "thread",
        summary: { threadId: "thread", id: "summary", role: "system", text: "s", at: 1 },
        sourceMessages: [source, source]
      }
      const compact = store.compactMessages(input)
      input.threadId = "other"
      input.summary.text = "mutated"
      source.text = "mutated"
      input.sourceMessages.length = 0
      const deleted = yield* compact
      return { deleted, messages: yield* store.listMessages({ threadId: "thread" }) }
    }))

    expect(result.deleted).toBe(1)
    expect(result.messages).toEqual([{ threadId: "thread", id: "summary", role: "system", text: "s", at: 1 }])
  })

  it("rejects empty thread ids and sources belonging to another thread", async () => {
    const failures = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const summary = { threadId: "thread", id: "summary", role: "system", text: "s", at: 0 }
      return [
        yield* Effect.flip(store.compactMessages({ threadId: "", summary, sourceMessages: [] })),
        yield* Effect.flip(store.compactMessages({
          threadId: "thread",
          summary,
          sourceMessages: [{ threadId: "other", id: "source", role: "user", text: "s", at: 0 }]
        }))
      ]
    }))

    expect(failures.map(({ code, path }) => ({ code, path }))).toEqual([
      { code: "invalid_argument", path: ["threadId"] },
      { code: "invalid_argument", path: ["sourceMessages"] }
    ])
  })

  it("rejects an identical retry of a committed compaction", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.appendMessage({ threadId: "thread", id: "source", role: "user", text: "original", at: 1 })
      const input = {
        threadId: "thread",
        summary: { threadId: "thread", id: "summary", role: "system", text: "s", at: 1 },
        sourceMessages: yield* store.listMessages({ threadId: "thread" })
      }
      const deleted = yield* store.compactMessages(input)
      const failure = yield* Effect.flip(store.compactMessages(input))
      return { deleted, failure, summary: input.summary, messages: yield* store.listMessages({ threadId: "thread" }) }
    }))

    expect(result.deleted).toBe(1)
    expect(result.failure).toMatchObject({ code: "idempotency_conflict", path: ["summary", "id"] })
    expect(result.messages).toEqual([result.summary])
  })

  // A durable caller replaying a compaction after a crash has to tell "this
  // summary already exists" from "the database is broken".
  // Both used to answer `code: "store"`.
  it("names an already-written summary as an idempotency conflict", async () => {
    const conflict = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.appendMessage({ threadId: "thread", id: "m-0", role: "user", text: "a", at: 0 })
      yield* store.appendMessage({ threadId: "thread", id: "summary", role: "system", text: "s", at: 1 })
      return yield* Effect.flip(store.compactMessages({
        threadId: "thread",
        summary: { threadId: "thread", id: "summary", role: "system", text: "s", at: 1 },
        sourceMessages: [{ threadId: "thread", id: "m-0", role: "user", text: "a", at: 0 }]
      }))
    }))

    expect([conflict.code, conflict.path]).toEqual(["idempotency_conflict", ["summary", "id"]])
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

  it("resolves a bank name to a namespace and rejects an empty bank", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putNote({
        namespace: { kind: "agent", id: "fleet" },
        id: "agent-note",
        text: "a",
        tags: [],
        provenance: {}
      })
      yield* store.putNote({ namespace: { kind: "flow", id: "flow-" }, id: "odd", text: "o", tags: [], provenance: {} })
      yield* store.putNote({
        namespace: { kind: "flow", id: "plain" },
        id: "plain-note",
        text: "p",
        tags: [],
        provenance: {}
      })
      const prefixed = yield* store.searchRows({ namespace: "agent-fleet" })
      const boundary = yield* store.searchRows({ namespace: "flow-" })
      const unprefixed = yield* store.searchRows({ namespace: "plain" })
      const structured = yield* store.searchRows({ namespace: { kind: "agent", id: "fleet" } })
      const empty = yield* Effect.flip(store.searchRows({ namespace: "" }))
      return { prefixed, boundary, unprefixed, structured, empty }
    }))

    expect(result.prefixed.map((row) => [row.bank, row.key])).toEqual([["agent-fleet", "agent-note"]])
    expect(result.boundary.map((row) => [row.bank, row.key])).toEqual([["flow-", "odd"]])
    expect(result.unprefixed.map((row) => [row.bank, row.key])).toEqual([["plain", "plain-note"]])
    expect(result.structured.map((row) => row.bank)).toEqual(["agent-fleet"])
    expect([result.empty.code, result.empty.message]).toEqual(["invalid_namespace", "memory bank must not be empty"])
  })

  it("orders, tags, and limits authoritative raw rows", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putFact({ namespace, key: "plain", value: "a bare string", provenance: {} })
      yield* store.putFact({
        namespace,
        key: "tagged",
        value: { content: "structured", tags: ["scope:project", 7] },
        provenance: {}
      })
      const all = yield* store.searchRows({ namespace })
      const none = yield* store.searchRows({ namespace, limit: 0 })
      const one = yield* store.searchRows({ namespace, limit: 1 })
      const generous = yield* store.searchRows({ namespace, limit: 99 })
      const single = yield* store.searchRows({
        namespace,
        tagGroups: [{ tags: ["scope:project"], match: "all_strict" }]
      })
      const negative = yield* Effect.flip(store.searchRows({ namespace, limit: -1 }))
      const fractional = yield* Effect.flip(store.searchRows({ namespace, limit: 1.5 }))
      return { all, none, one, generous, single, negative, fractional }
    }))

    expect(result.all.map((row) => [row.key, row.text, row.tags])).toEqual([
      ["plain", "a bare string", []],
      ["tagged", "structured", ["scope:project"]]
    ])
    expect(result.none).toEqual([])
    expect(result.one.map((row) => row.key)).toEqual(["plain"])
    expect(result.generous).toHaveLength(2)
    expect(result.single.map((row) => row.key)).toEqual(["tagged"])
    expect([result.negative, result.fractional].map((error) => [error.code, error.path])).toEqual([
      ["invalid_argument", ["limit"]],
      ["invalid_argument", ["limit"]]
    ])
  })

  it("matches the previous full-sort semantics at the exact limit and limit plus one", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      for (let index = 0; index < 5; index++) {
        yield* store.putFact({ namespace, key: `fact-${index}`, value: `value-${index}`, provenance: {} })
        yield* TestClock.adjust("1 millis")
      }
      const all = yield* store.searchRows({ namespace })
      const exact = yield* store.searchRows({ namespace, limit: 3 })
      yield* store.putFact({ namespace, key: "fact-plus-one", value: "newest", provenance: {} })
      const after = yield* store.searchRows({ namespace })
      const limitedAfter = yield* store.searchRows({ namespace, limit: 3 })
      return { all, exact, after, limitedAfter }
    }))

    expect(result.exact).toEqual(result.all.slice(0, 3))
    expect(result.limitedAfter).toEqual(result.after.slice(0, 3))
    expect(result.exact).toHaveLength(3)
    expect(result.limitedAfter).toHaveLength(3)
  })

  // `limit` names how many rows the caller GETS, not how many the query looks
  // at. A LIMIT applied before the status, supersession and tag filters silently
  // under-fills, and the shortfall is invisible: the caller sees a short list,
  // not an error.
  it("counts the limit against rows that pass every filter, not the rows SQL touched", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      // Oldest first, so an unfiltered `limit: 1` takes the pending note and a
      // post-filter would then discard it, leaving nothing.
      yield* store.putNote({ namespace, id: "a-pending", text: "p", tags: [], provenance: {}, status: "pending" })
      yield* store.putNote({ namespace, id: "b-accepted", text: "a", tags: [], provenance: {} })
      yield* store.putNote({ namespace, id: "c-rejected", text: "r", tags: [], provenance: {}, status: "rejected" })
      return {
        accepted: yield* store.listNotes({ namespace, status: "accepted", limit: 1 }),
        acceptedUnlimited: yield* store.listNotes({ namespace, status: "accepted" }),
        selection: yield* store.listNotes({ namespace, status: ["pending", "rejected"], limit: 2 }),
        emptySelection: yield* store.listNotes({ namespace, status: [], limit: 2 }),
        any: yield* store.listNotes({ namespace, status: "any", limit: 3 })
      }
    }))

    expect(result.accepted.map((note) => note.id)).toEqual(["b-accepted"])
    expect(result.accepted).toEqual(result.acceptedUnlimited)
    expect(result.selection.map((note) => note.id)).toEqual(["a-pending", "c-rejected"])
    expect(result.emptySelection).toEqual([])
    expect(result.any.map((note) => note.id)).toEqual(["a-pending", "b-accepted", "c-rejected"])
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

  // 512 was the old overscan window, so a namespace larger than it is the only
  // size at which the earlier "read a wide window and filter it" approximation
  // is distinguishable from an exact answer.
  it("finds tag-filtered rows past the old overscan window", async () => {
    const total = 520
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      for (let index = 0; index < total; index++) {
        const id = `note-${String(index).padStart(4, "0")}`
        // listNotes reads oldest first and searchRows newest first, so a match
        // at each end makes both directions page all the way past the window.
        const wanted = index < 3 || index >= total - 3
        yield* store.putNote({
          namespace,
          id,
          text: `row ${index}`,
          tags: [wanted ? "scope:project" : "scope:other"],
          provenance: {}
        })
        yield* TestClock.adjust("1 millis")
      }
      const tagGroup = { tags: ["scope:project"], match: "any_strict" } as const
      return {
        ascending: yield* store.listNotes({ namespace, tagGroups: [tagGroup], limit: 6 }),
        descending: yield* store.searchRows({ namespace, tagGroups: [tagGroup], limit: 6 }),
        everything: yield* store.listNotes({ namespace, tagGroups: [tagGroup] })
      }
    }))

    const oldest = ["note-0000", "note-0001", "note-0002"]
    const newest = ["note-0517", "note-0518", "note-0519"]
    expect(result.ascending.map((note) => note.id)).toEqual([...oldest, ...newest])
    expect(result.descending.map((row) => row.id)).toEqual([...newest].reverse().concat([...oldest].reverse()))
    expect(result.everything).toHaveLength(6)
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

  // enableFts is documented as a setup step, so hosts call it on every boot.
  // Once a kind is enabled its projection is maintained row by row; a repeat
  // call must leave that projection alone instead of rebuilding it under the
  // writer. A row written straight into the FTS table survives only if the
  // second call did not DELETE and backfill.
  it("does not rebuild the FTS projection when the kind is already enabled", async () => {
    const result = await runWithDatabase(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* store.putFact({ namespace, key: "runbook", value: { content: "restore the primary" }, provenance: {} })
      yield* store.enableFts("flow")
      yield* sql`INSERT INTO memory_fts_flow (record_id, record_kind, namespace_id, record_key, text)
        VALUES ('marker', 'fact', ${namespace.id}, 'marker', 'sentinel projection')`
      yield* store.enableFts("flow")
      const rows = yield* sql<{ readonly record_id: string }>`SELECT record_id FROM memory_fts_flow ORDER BY record_id`
      return rows.map((row) => row.record_id)
    }))

    expect(result).toEqual(["marker", "runbook"])
  })

  // The backfill derives searchable text in SQL; it must match what the live
  // projection wrote for a string value, a content object, and any other JSON.
  it("backfills FTS text for every value shape the live projection indexes", async () => {
    const result = await runWithDatabase(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const put = (key: string, value: unknown) => store.putFact({ namespace, key, value, provenance: {} })
      yield* put("plain", "restore the primary")
      yield* put("content", { content: "rotate the keys", tags: ["ops"] })
      yield* put("object", { content: 7, note: "reindex the shards" })
      yield* put("number", 42)
      yield* store.enableFts("flow")
      const live = yield* sql<{ readonly record_id: string; readonly text: string }>`
        SELECT record_id, text FROM memory_fts_flow ORDER BY record_id`
      yield* sql`DELETE FROM memory_fts_kinds WHERE namespace_kind = 'flow'`
      yield* store.enableFts("flow")
      const rebuilt = yield* sql<{ readonly record_id: string; readonly text: string }>`
        SELECT record_id, text FROM memory_fts_flow ORDER BY record_id`
      return { live, rebuilt }
    }))

    expect(result.rebuilt).toEqual(result.live)
    expect(result.rebuilt.map((row) => row.text)).toEqual([
      "rotate the keys",
      "42",
      "{\"content\":7,\"note\":\"reindex the shards\"}",
      "restore the primary"
    ])
  })

  it("ends the expiry sweep on its first empty chunk", async () => {
    const deleted = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putFact({ namespace, key: "permanent", value: "v", provenance: {} })
      return yield* store.deleteExpiredFacts
    }))

    expect(deleted).toBe(0)
  })

  it("pages the fact side of a tag-filtered search past the old overscan window", async () => {
    const total = 520
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      for (let index = 0; index < total; index++) {
        yield* store.putFact({
          namespace,
          key: `fact-${String(index).padStart(4, "0")}`,
          value: `row ${index}`,
          tags: [index < 2 ? "scope:project" : "scope:other"],
          provenance: {}
        })
        yield* TestClock.adjust("1 millis")
      }
      const tagGroup = { tags: ["scope:project"], match: "any_strict" } as const
      return {
        limited: yield* store.searchRows({ namespace, tagGroups: [tagGroup], limit: 2 }),
        prefixed: yield* store.searchRows({ namespace, tagGroups: [tagGroup], prefix: "fact-0000", limit: 2 })
      }
    }))

    expect(result.limited.map((row) => row.key)).toEqual(["fact-0001", "fact-0000"])
    expect(result.prefixed.map((row) => row.key)).toEqual(["fact-0000"])
  })

  it("returns no FTS matches for an empty record selection", async () => {
    const rows = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putFact({ namespace, key: "other", value: "needle", provenance: {} })
      yield* store.enableFts("flow")
      return yield* store.searchFts({ namespace, query: "needle", records: [], limit: 1 })
    }))
    expect(rows).toEqual([])
  })

  it("refills FTS pages using exact kind and id selections before the limit", async () => {
    const rows = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      for (let index = 0; index < 520; index++) {
        yield* store.putFact({ namespace, key: `other-${index}`, value: "needle", provenance: {} })
      }
      yield* store.putFact({ namespace, key: "zzzz-note", value: "needle", provenance: {} })
      yield* store.putNote({ namespace, id: "zzzz-note", text: "needle", tags: [], provenance: {} })
      yield* store.putFact({ namespace, key: "zzzz-fact", value: "needle", provenance: {} })
      yield* store.enableFts("flow")
      return yield* store.searchFts({
        namespace,
        query: "needle",
        records: [{ kind: "note", id: "zzzz-note" }, { kind: "fact", id: "zzzz-fact" }],
        limit: 2
      })
    }))
    expect(rows.map(({ kind, id }) => ({ kind, id })).sort((a, b) => a.kind.localeCompare(b.kind))).toEqual([
      { kind: "fact", id: "zzzz-fact" },
      { kind: "note", id: "zzzz-note" }
    ])
  })

  it("reads filtered FTS pages in one transaction with larger rank pages", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const original = yield* MemoryStore.MemoryStore
        for (let index = 0; index < 520; index++) {
          yield* original.putFact({
            namespace,
            key: `row-${index}`,
            value: "needle",
            tags: [index === 519 ? "scope:project" : "scope:other"],
            provenance: {}
          })
        }
        yield* original.enableFts("flow")
        const pages: Array<{ readonly size: number; readonly transaction: boolean }> = []
        const observed = new Proxy(sql, {
          apply(target, thisArg, argumentsList) {
            const statement = Array.isArray(argumentsList[0]) ? argumentsList[0].join(" ") : ""
            const query = Reflect.apply(target, thisArg, argumentsList)
            if (!statement.includes("AS rank")) return query
            return (query as Effect.Effect<ReadonlyArray<unknown>>).pipe(Effect.tap((rows) =>
              Effect.gen(function*() {
                pages.push({
                  size: rows.length,
                  transaction: Option.isSome(yield* Effect.serviceOption(sql.transactionService))
                })
              })
            ))
          }
        })
        const store = yield* MemoryStore.make.pipe(Effect.provideService(SqlClient.SqlClient, observed))
        const rows = yield* store.searchFts({
          namespace,
          query: "needle",
          limit: 2,
          tagGroups: [{ tags: ["scope:project"], match: "any_strict" }]
        })
        return { rows, pages }
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )
    expect(result.rows.map((row) => row.id)).toEqual(["row-519"])
    expect(result.pages).toEqual([{ size: 512, transaction: true }, { size: 8, transaction: true }])
  })

  it.each([
    { records: Array.from({ length: 65 }, () => ({ kind: "fact", id: "a" })) },
    { records: [{ kind: "message", id: "a" }] },
    { records: [{ kind: "fact", id: "" }] }
  ])("validates FTS record identities %#", async ({ records }) => {
    const failure = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.enableFts("flow")
      return yield* Effect.flip(store.searchFts({
        namespace,
        query: "needle",
        records: records as MemoryStore.SearchFtsInput["records"]
      }))
    }))
    expect(failure.code).toBe("invalid_argument")
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

  it("resolves FTS matches by id so an older match is not lost to a recency window", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.enableFts("flow")
      // The only note carrying the query term is the oldest of ten. A lookup
      // built from the newest few rows cannot see it.
      yield* store.putNote({ namespace, id: "note-00", text: "durable wombat procedure", tags: [], provenance: {} })
      for (let index = 1; index < 10; index++) {
        yield* store.putNote({
          namespace,
          id: `note-${String(index).padStart(2, "0")}`,
          text: "durable release checklist",
          tags: [],
          provenance: {}
        })
      }
      yield* store.putFact({
        namespace,
        key: "fact-quokka",
        value: { content: "durable quokka runbook" },
        tags: ["scope:project"],
        provenance: {}
      })
      yield* store.putFact({
        namespace,
        key: "other-quokka",
        value: { content: "durable quokka aside" },
        tags: ["scope:other"],
        provenance: {}
      })
      return {
        oldest: yield* store.searchFts({ namespace, query: "wombat", limit: 1 }),
        tagged: yield* store.searchFts({
          namespace,
          query: "quokka",
          tagGroups: [{ tags: ["scope:project"], match: "any_strict" }],
          limit: 10
        }),
        prefixed: yield* store.searchFts({ namespace, query: "quokka", prefix: "fact-", limit: 10 })
      }
    }))

    expect(result.oldest.map((row) => row.id)).toEqual(["note-00"])
    expect(result.tagged.map((row) => row.id)).toEqual(["fact-quokka"])
    expect(result.prefixed.map((row) => row.id)).toEqual(["fact-quokka"])
  })

  it("bounds the SQL rowset before decoding rows outside the search limit", async () => {
    const rows = await runWithDatabase(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* store.putFact({ namespace, key: "newest", value: "safe", provenance: {} })
      yield* sql`PRAGMA ignore_check_constraints = ON`
      yield* sql`INSERT INTO memory_facts (
        namespace_kind, namespace_id, fact_key, value_json, tags_json, ttl_ms,
        provenance_json, created_at_ms, updated_at_ms
      ) VALUES ('flow', 'project-1', 'outside-limit', '{oops', NULL, NULL, '{}', -1, -1)`
      return yield* store.searchRows({ namespace, limit: 1 })
    }))

    expect(rows.map((row) => row.key)).toEqual(["newest"])
  })

  it("rejects invalid search limits before reading backend tables", async () => {
    const failures = await runWithDatabase(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* sql`DROP TABLE memory_facts`
      const rows = yield* Effect.flip(store.searchRows({ namespace, limit: -1 }))
      yield* sql`DROP TABLE memory_fts_kinds`
      const fts = yield* Effect.flip(store.searchFts({ namespace, query: "query", limit: -1 }))
      return [rows, fts]
    }))

    expect(failures.map((error) => [error.code, error.path])).toEqual([
      ["invalid_argument", ["limit"]],
      ["invalid_argument", ["limit"]]
    ])
  })

  it("enables FTS per namespace kind and applies query, limit, and filter boundaries", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const badKind = yield* Effect.flip(store.enableFts("run" as MemoryStore.EnableFtsInput))
      yield* store.putFact({
        namespace,
        key: "runbook",
        value: { content: "durable checkout recovery", tags: ["scope:project"] },
        provenance: {}
      })
      yield* store.putNote({
        namespace,
        id: "durable-note",
        text: "durable release checklist",
        tags: ["scope:project"],
        provenance: {}
      })
      yield* store.putNote({
        namespace,
        id: "durable-extra",
        text: "durable rollback drill",
        tags: ["scope:project"],
        provenance: {}
      })
      yield* store.putNote({
        namespace,
        id: "durable-pending",
        text: "durable draft",
        tags: ["scope:project"],
        provenance: {},
        status: "pending"
      })
      yield* store.enableFts("flow")
      yield* store.enableFts("flow")
      const blank = yield* store.searchFts({ namespace, query: "   " })
      const surrogate = yield* store.searchFts({ namespace, query: "\uD800durable" })
      const zeroLimit = yield* store.searchFts({ namespace, query: "durable", limit: 0 })
      const negativeLimit = yield* Effect.flip(store.searchFts({ namespace, query: "durable", limit: -1 }))
      const fractionalLimit = yield* Effect.flip(store.searchFts({ namespace, query: "durable", limit: 0.5 }))
      const defaulted = yield* store.searchFts({ namespace, query: "durable" })
      const truncated = yield* store.searchFts({ namespace, query: "durable", limit: 2, status: "any" })
      const filtered = yield* store.searchFts({
        namespace,
        query: "durable",
        limit: 10,
        status: "any",
        includeSuperseded: true,
        tagGroups: [
          { tags: ["scope:project"], match: "all_strict" },
          { not: { tags: ["scope:secret"], match: "any_strict" } }
        ]
      })
      yield* store.deleteFact({ namespace, key: "runbook" })
      const afterDelete = yield* store.searchFts({ namespace, query: "durable", limit: 10 })
      const otherKind = yield* Effect.flip(
        store.searchFts({ namespace: { kind: "agent", id: "fleet" }, query: "durable" })
      )
      return {
        badKind,
        blank,
        surrogate,
        zeroLimit,
        negativeLimit,
        fractionalLimit,
        defaulted,
        truncated,
        filtered,
        afterDelete,
        otherKind
      }
    }))

    expect([result.badKind.code, result.badKind.message]).toEqual([
      "invalid_namespace",
      "FTS namespace kind is invalid"
    ])
    expect(result.blank).toEqual([])
    expect(result.surrogate.map((row) => row.key).sort()).toEqual(["durable-extra", "durable-note", "runbook"])
    expect(result.zeroLimit).toEqual([])
    expect([result.negativeLimit, result.fractionalLimit].map((error) => [error.code, error.path])).toEqual([
      ["invalid_argument", ["limit"]],
      ["invalid_argument", ["limit"]]
    ])
    expect(result.defaulted.map((row) => row.key).sort()).toEqual(["durable-extra", "durable-note", "runbook"])
    expect(result.truncated).toHaveLength(2)
    expect(result.filtered.map((row) => row.key).sort()).toEqual([
      "durable-extra",
      "durable-note",
      "durable-pending",
      "runbook"
    ])
    expect(result.afterDelete.map((row) => row.key).sort()).toEqual(["durable-extra", "durable-note"])
    expect(result.otherKind.code).toBe("fts_not_enabled")
  })

  it("fails every operation on the unavailable store and honours overrides", async () => {
    const noop = MemoryStore.makeNoop()
    const calls: ReadonlyArray<readonly [string, Effect.Effect<unknown, MemoryError>]> = [
      ["putFact", noop.putFact({ namespace, key: "k", value: 1, provenance: {} })],
      ["getFact", noop.getFact({ namespace, key: "k" })],
      ["deleteFact", noop.deleteFact({ namespace, key: "k" })],
      ["listFacts", noop.listFacts({ namespace })],
      ["listAllFacts", noop.listAllFacts],
      ["createThread", noop.createThread({ namespace })],
      ["getThread", noop.getThread({ threadId: "t" })],
      ["listThreads", noop.listThreads()],
      ["deleteThread", noop.deleteThread({ threadId: "t" })],
      ["appendMessage", noop.appendMessage({ threadId: "t", id: "m", role: "user", text: "x", at: 0 })],
      ["listMessages", noop.listMessages({ threadId: "t" })],
      ["countMessages", noop.countMessages({ threadId: "t" })],
      ["messageStats", noop.messageStats({ threadId: "t" })],
      ["putNote", noop.putNote({ namespace, id: "n", text: "t", tags: [], provenance: {} })],
      ["getNote", noop.getNote({ id: "n" })],
      ["setNoteStatus", noop.setNoteStatus({ id: "n", status: "accepted" })],
      ["supersede", noop.supersede({ supersederId: "s", targetId: "t" })],
      ["listNotes", noop.listNotes({ namespace })],
      ["enableFts", noop.enableFts("flow")],
      ["searchFts", noop.searchFts({ namespace, query: "q" })],
      ["searchRows", noop.searchRows({ namespace })],
      ["deleteExpiredFacts", noop.deleteExpiredFacts],
      ["listThreadIds", noop.listThreadIds],
      ["deleteMessages", noop.deleteMessages({ threadId: "t", ids: ["m"] })],
      [
        "compactMessages",
        noop.compactMessages({
          threadId: "t",
          summary: { threadId: "t", id: "s", role: "system", text: "x", at: 0 },
          sourceMessages: [{ threadId: "thread", id: "m", role: "user", text: "a", at: 0 }]
        })
      ]
    ]
    const overridden = MemoryStore.makeNoop({
      getFact: () => Effect.succeed(undefined),
      listThreadIds: Effect.succeed(["kept"])
    })

    const messages = await Effect.runPromise(
      Effect.forEach(calls, ([name, effect]) => Effect.map(Effect.flip(effect), (error) => `${name}: ${error.message}`))
    )
    const kept = await Effect.runPromise(
      Effect.all([overridden.getFact({ namespace, key: "k" }), overridden.listThreadIds])
    )
    const stillUnavailable = await Effect.runPromise(
      Effect.flip(overridden.putFact({ namespace, key: "k", value: 1, provenance: {} }))
    )
    const layered = await Effect.runPromise(
      Effect.service(MemoryStore.MemoryStore).pipe(
        Effect.flatMap((store) => Effect.flip(store.listAllFacts)),
        Effect.provide(MemoryStore.layerNoop())
      )
    )
    const layeredOverride = await Effect.runPromise(
      Effect.service(MemoryStore.MemoryStore).pipe(
        Effect.flatMap((store) => store.listAllFacts),
        Effect.provide(MemoryStore.layerNoop({ listAllFacts: Effect.succeed([]) }))
      )
    )

    expect(messages).toEqual(calls.map(([name]) => `${name}: ${name} is unavailable`))
    expect(kept).toEqual([undefined, ["kept"]])
    expect(stillUnavailable.message).toBe("putFact is unavailable")
    expect(layered.message).toBe("listAllFacts is unavailable")
    expect(layeredOverride).toEqual([])
  })

  it("surfaces a typed store error when an authoritative table is gone", async () => {
    const failure = await runWithDatabase(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* sql`DROP TABLE memory_facts`
      return yield* Effect.flip(store.listFacts({ namespace }))
    }))

    expect([failure.code, failure.message]).toEqual(["store", "could not list memory facts"])
    expect(causeMessages(failure.cause).some((message) => message.includes("no such table: memory_facts"))).toBe(
      true
    )
  })

  it("does not project vectors from authoritative writes by default", async () => {
    const result = await runWithDatabase(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* store.putFact({ namespace, key: "durable", value: "written", provenance: {} })
      yield* store.putNote({ namespace, id: "note", text: "written", tags: [], provenance: {} })
      const stored = yield* store.getFact({ namespace, key: "durable" })
      const rows = yield* sql<{ readonly count: number }>`SELECT count(*) AS count FROM memory_vectors`
      return { stored, count: Number(rows[0]?.count ?? -1) }
    }))

    expect(result.stored?.value).toBe("written")
    expect(result.count).toBe(0)
  })

  it("wraps a forged memory error tag as a genuine store failure", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const forged = { _tag: "flows/memory/MemoryError" }
        const failingSql = new Proxy(sql, {
          apply(target, thisArg, argumentsList) {
            const strings = argumentsList[0]
            if (Array.isArray(strings) && strings.join(" ").includes("FROM memory_facts")) {
              return Effect.fail(forged)
            }
            return Reflect.apply(target, thisArg, argumentsList)
          }
        })
        const store = yield* MemoryStore.make.pipe(
          Effect.provideService(SqlClient.SqlClient, failingSql)
        )
        return yield* Effect.flip(store.listFacts({ namespace }))
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(failure).toBeInstanceOf(MemoryError)
    expect(failure).toMatchObject({ code: "store", message: "could not list memory facts" })
  })

  it("reports a stored row it cannot decode as a typed memory error", async () => {
    const failures = await runWithDatabase(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* sql`INSERT INTO memory_facts (
        namespace_kind, namespace_id, fact_key, value_json, ttl_ms,
        provenance_json, created_at_ms, updated_at_ms
      ) VALUES ('flow', 'scalar', 'k', '1', NULL, '5', 0, 0)`
      const scalarProvenance = yield* Effect.flip(store.listFacts({ namespace: { kind: "flow", id: "scalar" } }))
      yield* sql`INSERT INTO memory_facts (
        namespace_kind, namespace_id, fact_key, value_json, ttl_ms,
        provenance_json, created_at_ms, updated_at_ms
      ) VALUES ('flow', 'null-provenance', 'k', '1', NULL, 'null', 0, 0)`
      const nullProvenance = yield* Effect.flip(
        store.listFacts({ namespace: { kind: "flow", id: "null-provenance" } })
      )
      yield* sql`INSERT INTO memory_notes (
        id, namespace_kind, namespace_id, text, tags_json, provenance_json, status, created_at_ms
      ) VALUES ('bad-tags', 'flow', 'notes', 'text', '["vendor:x"]', '{}', 'accepted', 0)`
      const storedTags = yield* Effect.flip(store.getNote({ id: "bad-tags" }))
      yield* sql`PRAGMA ignore_check_constraints = ON`
      yield* sql`INSERT INTO memory_facts (
        namespace_kind, namespace_id, fact_key, value_json, ttl_ms,
        provenance_json, created_at_ms, updated_at_ms
      ) VALUES ('flow', 'invalid-json', 'k', '{oops', NULL, '{}', 0, 0)`
      const invalidJson = yield* Effect.flip(store.listFacts({ namespace: { kind: "flow", id: "invalid-json" } }))
      yield* sql`INSERT INTO memory_threads (
        thread_id, namespace_kind, namespace_id, title, metadata_json, created_at_ms, updated_at_ms
      ) VALUES ('bad-thread', 'flow', 'threads', NULL, '{oops', 0, 0)`
      const invalidMetadata = yield* Effect.flip(store.getThread({ threadId: "bad-thread" }))
      return [scalarProvenance, nullProvenance, storedTags, invalidJson, invalidMetadata]
    }))

    expect(failures.map((error) => [error.code, error.message])).toEqual([
      ["store", "stored provenance is not an object"],
      ["store", "stored provenance is not an object"],
      ["invalid_tag", "stored tags violate the memory vocabulary"],
      ["store", "could not decode fact value"],
      ["store", "could not decode thread metadata"]
    ])
  })
})
