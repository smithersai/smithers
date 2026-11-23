import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer } from "effect"
import * as EffectDigest from "effect/crypto/Digest"
import * as SecureRandom from "effect/crypto/SecureRandom"
import * as Hex from "effect/encoding/Hex"
import * as SqlClient from "effect/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as Maintenance from "../src/Maintenance.ts"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as Migrations from "../src/Migrations.ts"
import { run } from "./fixtures/MemoryStoreHarness.ts"

// Issue #4712: a note id and a thread id used to be global, so one person's
// `prefs` blocked another's and a bare id read, changed or deleted whichever
// namespace held it. These tests hold two people to the same ids.
const alice = { kind: "user", id: "alice" } as const
const bob = { kind: "user", id: "bob" } as const

const note = (namespace: MemoryStore.NamespaceInput, text: string, id = "prefs"): MemoryStore.PutNoteInput => ({
  namespace,
  id,
  text,
  tags: [],
  provenance: {}
})

const message = (namespace: MemoryStore.NamespaceInput, id: string, text: string, at: number) => ({
  namespace,
  threadId: "chat",
  id,
  role: "user",
  text,
  at
})

describe("namespace isolation of notes and threads", () => {
  it("lets Alice and Bob both own note id prefs", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putNote(note(alice, "alice likes tabs"))
      yield* store.putNote(note(bob, "bob likes spaces"))
      return {
        alice: yield* store.getNote({ namespace: alice, id: "prefs" }),
        bob: yield* store.getNote({ namespace: bob, id: "prefs" }),
        aliceList: yield* store.listNotes({ namespace: alice }),
        bobList: yield* store.listNotes({ namespace: bob }),
        // A retry in one namespace is still compared against that namespace's row only.
        aliceRetry: yield* store.putNote(note(alice, "alice likes tabs")),
        bobConflict: yield* Effect.flip(store.putNote(note(bob, "alice likes tabs")))
      }
    }))

    expect(result.alice).toMatchObject({ namespace: alice, id: "prefs", text: "alice likes tabs" })
    expect(result.bob).toMatchObject({ namespace: bob, id: "prefs", text: "bob likes spaces" })
    expect(result.aliceList.map((row) => row.text)).toEqual(["alice likes tabs"])
    expect(result.bobList.map((row) => row.text)).toEqual(["bob likes spaces"])
    expect(result.aliceRetry.text).toBe("alice likes tabs")
    expect(result.bobConflict).toMatchObject({
      code: "supersede_conflict",
      message: "note id \"prefs\" already exists with different creation data"
    })
  })

  it("never reads, restatuses or supersedes a note through another namespace", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putNote(note(alice, "alice likes tabs"))
      const read = yield* store.getNote({ namespace: bob, id: "prefs" })
      const status = yield* Effect.flip(store.setNoteStatus({ namespace: bob, id: "prefs", status: "rejected" }))
      // Bob supersedes his own `prefs`; Alice's note with the same id stays in her recall.
      yield* store.putNote(note(bob, "bob likes spaces"))
      yield* store.putNote({ ...note(bob, "bob likes two spaces", "prefs-2"), supersedes: ["prefs"] })
      yield* store.putNote(note(bob, "bob likes four spaces", "prefs-3"))
      yield* store.supersede({ namespace: bob, supersederId: "prefs-3", targetId: "prefs-2" })
      yield* store.setNoteStatus({ namespace: bob, id: "prefs-3", status: "rejected" })
      return {
        read,
        status,
        alice: yield* store.listNotes({ namespace: alice }),
        bob: yield* store.listNotes({ namespace: bob }),
        bobRejected: yield* store.listNotes({ namespace: bob, status: "rejected", includeSuperseded: true })
      }
    }))

    expect(result.read).toBeUndefined()
    expect(result.status).toMatchObject({ code: "not_found", message: "memory note \"prefs\" was not found" })
    expect(result.alice.map((row) => [row.id, row.status, row.text])).toEqual([
      ["prefs", "accepted", "alice likes tabs"]
    ])
    // `prefs-3` is rejected, so its edge hides nothing and `prefs-2` is current.
    expect(result.bob.map((row) => row.id)).toEqual(["prefs-2"])
    expect(result.bobRejected.map((row) => row.id)).toEqual(["prefs-3"])
  })

  it("keeps the same thread id apart in two namespaces", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const aliceThread = yield* store.createThread({ namespace: alice, id: "chat", title: "Alice" })
      const bobThread = yield* store.createThread({ namespace: bob, id: "chat", title: "Bob" })
      yield* store.appendMessage(message(alice, "m1", "alice one", 1))
      yield* store.appendMessage(message(alice, "m2", "alice two", 2))
      yield* store.appendMessage(message(bob, "m1", "bob one", 1))
      return {
        aliceThread,
        bobThread,
        fetched: [
          yield* store.getThread({ namespace: alice, threadId: "chat" }),
          yield* store.getThread({ namespace: bob, threadId: "chat" })
        ],
        messages: [
          yield* store.listMessages({ namespace: alice, threadId: "chat" }),
          yield* store.listMessages({ namespace: bob, threadId: "chat" })
        ],
        counts: [
          yield* store.countMessages({ namespace: alice, threadId: "chat" }),
          yield* store.countMessages({ namespace: bob, threadId: "chat" })
        ],
        stats: [
          yield* store.messageStats({ namespace: alice, threadId: "chat" }),
          yield* store.messageStats({ namespace: bob, threadId: "chat" })
        ],
        refs: yield* store.listThreadRefs
      }
    }))

    // Each append advanced only its own thread: Alice's last message is at 2, Bob's at 1.
    expect(result.fetched).toEqual([{ ...result.aliceThread, updatedAtMs: 2 }, { ...result.bobThread, updatedAtMs: 1 }])
    expect(result.fetched.map((thread) => [thread?.namespace, thread?.title])).toEqual([[alice, "Alice"], [bob, "Bob"]])
    expect(result.messages.map((rows) => rows.map((row) => row.text))).toEqual([["alice one", "alice two"], [
      "bob one"
    ]])
    expect(result.counts).toEqual([2, 1])
    expect(result.stats.map((stats) => stats.bytes)).toEqual([18, 7])
    expect(result.refs).toEqual([{ namespace: alice, threadId: "chat" }, { namespace: bob, threadId: "chat" }])
  })

  it("never writes, deletes or compacts a thread through another namespace", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.appendMessage(message(alice, "m1", "alice one", 1))
      yield* store.appendMessage(message(alice, "m2", "alice two", 2))
      const sources = yield* store.listMessages({ namespace: alice, threadId: "chat" })
      const deletedMessages = yield* store.deleteMessages({ namespace: bob, threadId: "chat", ids: ["m1", "m2"] })
      const compaction = yield* Effect.flip(store.compactMessages({
        namespace: bob,
        threadId: "chat",
        summary: { threadId: "chat", id: "summary", role: "system", text: "gone", at: 1 },
        sourceMessages: sources
      }))
      const deletedThread = yield* store.deleteThread({ namespace: bob, threadId: "chat" })
      // Bob's append makes his own thread; it does not land in Alice's.
      yield* store.appendMessage(message(bob, "m1", "bob one", 5))
      const limited = yield* Maintenance.limitHistory({ maxTokens: 3, charsPerToken: 4 })
      const afterLimit = [
        yield* store.listMessages({ namespace: alice, threadId: "chat" }),
        yield* store.listMessages({ namespace: bob, threadId: "chat" })
      ]
      const compacted = yield* Maintenance.compact({
        summarizer: { summarize: ({ messages }) => Effect.succeed(`summary of ${messages.length}`) },
        thread: { namespace: bob, threadId: "chat" },
        keepRecent: 0
      })
      const bobGone = yield* store.deleteThread({ namespace: bob, threadId: "chat" })
      return {
        deletedMessages,
        compaction,
        deletedThread,
        limited,
        afterLimit,
        compacted,
        bobGone,
        alice: yield* store.listMessages({ namespace: alice, threadId: "chat" }),
        aliceThread: yield* store.getThread({ namespace: alice, threadId: "chat" }),
        bobThread: yield* store.getThread({ namespace: bob, threadId: "chat" })
      }
    }))

    expect(result.deletedMessages).toBe(0)
    expect(result.compaction).toMatchObject({ code: "compaction_conflict" })
    expect(result.deletedThread).toBe(false)
    // Twelve characters fit each thread: Alice loses her oldest message, Bob keeps his.
    expect(result.limited).toEqual({ deletedMessages: 1 })
    expect(result.afterLimit.map((rows) => rows.map((row) => row.text))).toEqual([["alice two"], ["bob one"]])
    expect(result.compacted).toEqual({ compactedThreads: 1, deletedMessages: 1 })
    expect(result.bobGone).toBe(true)
    expect(result.alice.map((row) => row.text)).toEqual(["alice two"])
    expect(result.aliceThread?.namespace).toEqual(alice)
    expect(result.bobThread).toBeUndefined()
  })

  it("resolves a bank name to the same namespace as its structured form", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.appendMessage(message("user-alice", "m1", "alice one", 1))
      yield* store.appendMessage(message(alice, "m2", "alice two", 2))
      const sources = yield* store.listMessages({ namespace: alice, threadId: "chat" })
      const removed = yield* store.compactMessages({
        namespace: "user-alice",
        threadId: "chat",
        summary: { threadId: "chat", id: "summary", role: "system", text: "alice summary", at: 1 },
        sourceMessages: sources
      })
      return { removed, messages: yield* store.listMessages({ namespace: "user-alice", threadId: "chat" }) }
    }))

    expect(result.removed).toBe(2)
    expect(result.messages.map((row) => row.text)).toEqual(["alice summary"])
  })
})

const testCrypto = Layer.succeed(EffectDigest.Digest)(EffectDigest.Digest.of({
  digest: (_algorithm, data) => Effect.succeed(data),
  digestHex(algorithm, data) {
    return Effect.map(this.digest(algorithm, data), Hex.encode)
  }
})).pipe(Layer.merge(SecureRandom.layerWebCrypto))

describe("namespace key migration", () => {
  // A database written while ids were global: Alice holds note `prefs` and
  // thread `chat`. Migrating keeps every row in the namespace it was written
  // to and frees the same ids for Bob.
  it("moves existing notes, edges, threads and messages under their namespace", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* DatabaseMigrations.run([{
          ...Migrations.set,
          migrations: Object.fromEntries(Object.entries(Migrations.set.migrations).slice(0, 4))
        }])
        for (
          const [id, kind, owner, status, at] of [
            ["prefs", "user", "alice", "accepted", 1],
            ["prefs-2", "user", "alice", "accepted", 2],
            ["draft", "flow", "build", "pending", 3]
          ] as const
        ) {
          yield* sql`INSERT INTO memory_notes (
              id, namespace_kind, namespace_id, text, tags_json, provenance_json, status, created_at_ms,
              status_at_ms, accepted_todo
            ) VALUES (
              ${id}, ${kind}, ${owner}, ${`${owner} ${id}`}, '["scope:project"]', '{"runId":"legacy"}', ${status},
              ${at}, ${id === "prefs-2" ? 9 : null}, ${id === "prefs-2" ? "T7" : null}
            )`
        }
        yield* sql`INSERT INTO memory_note_supersedes (superseder_id, target_id, created_at_ms)
          VALUES ('prefs-2', 'prefs', 4)`
        yield* sql`INSERT INTO memory_threads (
            thread_id, namespace_kind, namespace_id, title, metadata_json, created_at_ms, updated_at_ms
          ) VALUES ('chat', 'user', 'alice', 'Alice', '{"pinned":true}', 1, 3)`
        yield* sql`INSERT INTO memory_threads (
            thread_id, namespace_kind, namespace_id, created_at_ms, updated_at_ms
          ) VALUES ('implicit', 'global', 'history', 2, 2)`
        for (const [thread, id, at] of [["chat", "m1", 1], ["chat", "m2", 3], ["implicit", "m1", 2]] as const) {
          yield* sql`INSERT INTO memory_messages (id, thread_id, role, text, at_ms)
            VALUES (${id}, ${thread}, 'user', ${`${thread} ${id}`}, ${at})`
        }

        const store = yield* MemoryStore.make
        const edges = yield* sql`SELECT namespace_kind, namespace_id, superseder_id, target_id, created_at_ms
          FROM memory_note_supersedes`
        const before = {
          alice: yield* store.listNotes({ namespace: alice, status: "any", includeSuperseded: true }),
          current: yield* store.listNotes({ namespace: alice }),
          draft: yield* store.getNote({ namespace: { kind: "flow", id: "build" }, id: "draft" }),
          threads: yield* store.listThreads(),
          chat: yield* store.listMessages({ namespace: alice, threadId: "chat" }),
          implicit: yield* store.listMessages({ namespace: { kind: "global", id: "history" }, threadId: "implicit" })
        }
        yield* store.putNote(note(bob, "bob likes spaces"))
        yield* store.appendMessage(message(bob, "m1", "bob one", 5))
        return {
          edges: edges.map((edge) => ({ ...edge, created_at_ms: Number(edge["created_at_ms"]) })),
          before,
          bobNote: yield* store.getNote({ namespace: bob, id: "prefs" }),
          bobChat: yield* store.listMessages({ namespace: bob, threadId: "chat" }),
          aliceChat: yield* store.listMessages({ namespace: alice, threadId: "chat" }),
          second: yield* Migrations.run
        }
      }).pipe(Effect.provide(TestDatabase.layer), Effect.provide(testCrypto))
    )

    expect(result.edges).toEqual([
      { namespace_kind: "user", namespace_id: "alice", superseder_id: "prefs-2", target_id: "prefs", created_at_ms: 4 }
    ])
    expect(result.before.alice).toEqual([
      {
        namespace: alice,
        id: "prefs",
        text: "alice prefs",
        tags: ["scope:project"],
        provenance: { runId: "legacy" },
        status: "accepted",
        createdAtMs: 1
      },
      {
        namespace: alice,
        id: "prefs-2",
        text: "alice prefs-2",
        tags: ["scope:project"],
        provenance: { runId: "legacy" },
        status: "accepted",
        createdAtMs: 2,
        statusAtMs: 9,
        acceptedTodo: "T7"
      }
    ])
    expect(result.before.current.map((row) => row.id)).toEqual(["prefs-2"])
    expect(result.before.draft).toMatchObject({ id: "draft", status: "pending", text: "build draft" })
    expect(result.before.threads).toEqual([
      { id: "chat", namespace: alice, title: "Alice", metadata: { pinned: true }, createdAtMs: 1, updatedAtMs: 3 },
      { id: "implicit", namespace: { kind: "global", id: "history" }, createdAtMs: 2, updatedAtMs: 2 }
    ])
    expect(result.before.chat).toEqual([
      { threadId: "chat", id: "m1", role: "user", text: "chat m1", at: 1 },
      { threadId: "chat", id: "m2", role: "user", text: "chat m2", at: 3 }
    ])
    expect(result.before.implicit).toEqual([{
      threadId: "implicit",
      id: "m1",
      role: "user",
      text: "implicit m1",
      at: 2
    }])
    expect(result.bobNote).toMatchObject({ namespace: bob, id: "prefs", text: "bob likes spaces" })
    expect(result.bobChat.map((row) => row.text)).toEqual(["bob one"])
    expect(result.aliceChat.map((row) => row.text)).toEqual(["chat m1", "chat m2"])
    expect(result.second).toEqual([])
  })
})
