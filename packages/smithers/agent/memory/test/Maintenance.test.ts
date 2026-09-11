import { Deferred, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import * as Maintenance from "../src/Maintenance.ts"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

const namespace = { kind: "flow", id: "maintenance" } as const

const run = <A, E>(effect: Effect.Effect<A, E, MemoryStore.MemoryStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestMemory.layer), Effect.provide(TestClock.layer())))

const runWithDatabase = <A, E>(
  effect: Effect.Effect<A, E, MemoryStore.MemoryStore | SqlClient.SqlClient>
) => Effect.runPromise(effect.pipe(Effect.provide(TestMemory.layerWithDatabase), Effect.provide(TestClock.layer())))

const append = (store: MemoryStore.Service, threadId: string, count: number) =>
  Effect.forEach(
    Array.from({ length: count }, (_, index) => index),
    (index) =>
      store.appendMessage({
        threadId,
        id: `${threadId}-message-${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        text: `text-${index}`,
        at: index
      }),
    { discard: true }
  )

describe("Maintenance", () => {
  it("collects expired facts and their search projections in one finite TTL pass", async () => {
    const result = await runWithDatabase(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* store.enableFts("flow")
      yield* store.putFact({
        namespace,
        key: "temporary",
        value: "value",
        ttlMs: 5,
        provenance: {}
      })
      yield* store.putFact({ namespace, key: "permanent", value: "value", provenance: {} })
      yield* sql`INSERT INTO memory_vectors (
        record_kind, record_id, namespace_kind, namespace_id,
        embedding_model, content_digest, dimensions, vector_bytes, updated_at_ms
      ) VALUES ('fact', 'temporary', 'flow', 'maintenance', 'test', 'digest', 1, ${new Uint8Array(4)}, 0)`
      yield* TestClock.adjust("5 millis")
      const collected = yield* Maintenance.ttlGc
      const facts = yield* store.listFacts({ namespace })
      const factRows = yield* sql<{ readonly count: number }>`SELECT count(*) AS count
        FROM memory_facts WHERE namespace_kind = 'flow' AND namespace_id = 'maintenance' AND fact_key = 'temporary'`
      const ftsRows = yield* sql<{ readonly count: number }>`SELECT count(*) AS count
        FROM memory_fts_flow WHERE namespace_id = 'maintenance' AND record_kind = 'fact' AND record_id = 'temporary'`
      const vectorRows = yield* sql<{ readonly count: number }>`SELECT count(*) AS count
        FROM memory_vectors WHERE namespace_kind = 'flow' AND namespace_id = 'maintenance'
          AND record_kind = 'fact' AND record_id = 'temporary'`
      return {
        collected,
        facts,
        projectionCounts: [factRows[0]?.count, ftsRows[0]?.count, vectorRows[0]?.count]
      }
    }))

    expect(result.collected).toEqual({ deletedFacts: 1 })
    expect(result.facts.map((fact) => fact.key)).toEqual(["permanent"])
    expect(result.projectionCounts).toEqual([0, 0, 0])
  })

  it("collects FTS and vector projections across namespace kinds", async () => {
    const result = await runWithDatabase(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      const agentNamespace = { kind: "agent", id: "maintenance-agent" } as const
      yield* store.enableFts("flow")
      yield* store.enableFts("agent")
      yield* store.putFact({ namespace, key: "shared", value: "flow value", ttlMs: 1, provenance: {} })
      yield* store.putFact({ namespace: agentNamespace, key: "shared", value: "agent value", ttlMs: 1, provenance: {} })
      for (const [kind, id] of [["flow", "maintenance"], ["agent", "maintenance-agent"]] as const) {
        for (const model of ["model-a", "model-b"]) {
          yield* sql`INSERT INTO memory_vectors (
            record_kind, record_id, namespace_kind, namespace_id,
            embedding_model, content_digest, dimensions, vector_bytes, updated_at_ms
          ) VALUES ('fact', 'shared', ${kind}, ${id}, ${model}, 'digest', 1, ${new Uint8Array(4)}, 0)`
        }
      }
      yield* TestClock.adjust("1 millis")
      const collected = yield* Maintenance.ttlGc
      const flowFts = yield* sql<{ readonly count: number }>`SELECT count(*) AS count FROM memory_fts_flow
        WHERE record_kind = 'fact' AND record_id = 'shared' AND namespace_id = 'maintenance'`
      const agentFts = yield* sql<{ readonly count: number }>`SELECT count(*) AS count FROM memory_fts_agent
        WHERE record_kind = 'fact' AND record_id = 'shared' AND namespace_id = 'maintenance-agent'`
      const vectors = yield* sql<{ readonly count: number }>`SELECT count(*) AS count FROM memory_vectors
        WHERE record_kind = 'fact' AND record_id = 'shared'`
      return { collected, projectionCounts: [flowFts[0]?.count, agentFts[0]?.count, vectors[0]?.count] }
    }))

    expect(result.collected).toEqual({ deletedFacts: 2 })
    expect(result.projectionCounts).toEqual([0, 0, 0])
  })

  // Expired facts of one namespace are deleted with one statement per table.
  // Live facts in the same namespace, and their projections, stay in place.
  it("collects many expired facts of one namespace and keeps its live ones", async () => {
    const result = await runWithDatabase(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* store.enableFts("flow")
      for (const key of ["stale-a", "stale-b", "stale-c"]) {
        yield* store.putFact({ namespace, key, value: `${key} value`, ttlMs: 1, provenance: {} })
        yield* sql`INSERT INTO memory_vectors (
          record_kind, record_id, namespace_kind, namespace_id,
          embedding_model, content_digest, dimensions, vector_bytes, updated_at_ms
        ) VALUES ('fact', ${key}, 'flow', 'maintenance', 'model', 'digest', 1, ${new Uint8Array(4)}, 0)`
      }
      yield* store.putFact({ namespace, key: "fresh", value: "fresh value", ttlMs: 1_000, provenance: {} })
      yield* store.putFact({ namespace, key: "forever", value: "forever value", provenance: {} })
      yield* TestClock.adjust("1 millis")
      const collected = yield* Maintenance.ttlGc
      const facts = yield* store.listFacts({ namespace })
      const fts = yield* sql<{ readonly record_id: string }>`SELECT record_id FROM memory_fts_flow
        WHERE record_kind = 'fact' AND namespace_id = 'maintenance' ORDER BY record_id`
      const vectors = yield* sql<{ readonly count: number }>`SELECT count(*) AS count FROM memory_vectors
        WHERE namespace_kind = 'flow' AND namespace_id = 'maintenance'`
      return { collected, facts: facts.map((fact) => fact.key), fts: fts.map((row) => row.record_id), vectors }
    }))

    expect(result.collected).toEqual({ deletedFacts: 3 })
    expect(result.facts).toEqual(["forever", "fresh"])
    expect(result.fts).toEqual(["forever", "fresh"])
    expect(result.vectors).toEqual([{ count: 0 }])
  })

  it("deletes oldest history until the approximate token budget is met", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.appendMessage({ threadId: "thread", id: "one", role: "user", text: "1111", at: 1 })
      yield* store.appendMessage({ threadId: "thread", id: "two", role: "assistant", text: "2222", at: 2 })
      yield* store.appendMessage({ threadId: "thread", id: "three", role: "user", text: "3333", at: 3 })
      const limited = yield* Maintenance.limitHistory({ maxTokens: 8, charsPerToken: 1 })
      const messages = yield* store.listMessages({ threadId: "thread" })
      return { limited, messages }
    }))

    expect(result.limited).toEqual({ deletedMessages: 1 })
    expect(result.messages.map((message) => message.id)).toEqual(["two", "three"])
  })

  // Both maintenance passes read history 256 messages at a time, so a thread
  // shorter than one page never proves the cursor advances.
  it("walks a thread longer than one message page", async () => {
    const total = 300
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* append(store, "paged", total)
      const withinBudget = yield* Maintenance.limitHistory({ maxTokens: 1_000_000 })
      const compacted = yield* Maintenance.compact({
        summarizer: { summarize: ({ messages }) => Effect.succeed(`summarized ${messages.length}`) },
        makeSummaryId: () => "paged-summary"
      })
      const remaining = yield* store.listMessages({ threadId: "paged" })
      return { withinBudget, compacted, remaining }
    }))

    expect(result.withinBudget).toEqual({ deletedMessages: 0 })
    expect(result.compacted.compactedThreads).toBe(1)
    expect(result.remaining[0]?.text).toBe(`summarized ${result.compacted.deletedMessages}`)
    expect(result.remaining).toHaveLength(total - result.compacted.deletedMessages + 1)
  })

  it("writes the summary before deleting old messages in one transaction", async () => {
    const summarized: Array<ReadonlyArray<string>> = []
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* append(store, "thread", 5)
      const compacted = yield* Maintenance.compact({
        summarizer: {
          summarize: ({ messages }) =>
            Effect.sync(() => {
              summarized.push(messages.map((message) => message.id))
              return "summary text"
            })
        },
        makeSummaryId: () => "summary-fixed"
      })
      const messages = yield* store.listMessages({ threadId: "thread" })
      return { compacted, messages }
    }))

    expect(summarized).toEqual([["thread-message-0", "thread-message-1", "thread-message-2"]])
    expect(result.compacted).toEqual({ compactedThreads: 1, deletedMessages: 3 })
    expect(result.messages).toEqual([
      { threadId: "thread", id: "summary-fixed", role: "system", text: "summary text", at: 0 },
      { threadId: "thread", id: "thread-message-3", role: "assistant", text: "text-3", at: 3 },
      { threadId: "thread", id: "thread-message-4", role: "user", text: "text-4", at: 4 }
    ])
  })

  it("rejects a stale summary after a thread reset reuses source ids", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* append(store, "thread", 3)
      const started = yield* Deferred.make<void>()
      const resume = yield* Deferred.make<void>()
      const fiber = yield* Effect.result(Maintenance.compact({
        threadId: "thread",
        keepRecent: 1,
        summarizer: {
          summarize: ({ rendered }) =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(resume)),
              Effect.as(rendered)
            )
        }
      })).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(started)
      yield* store.deleteThread({ threadId: "thread" })
      yield* store.appendMessage({
        threadId: "thread",
        id: "thread-message-0",
        role: "user",
        text: "NEW INFORMATION NEVER SUMMARIZED",
        at: 100
      })
      const before = yield* store.listMessages({ threadId: "thread" })
      yield* Deferred.succeed(resume, undefined)
      const compacted = yield* Fiber.join(fiber)
      return { before, compacted, after: yield* store.listMessages({ threadId: "thread" }) }
    }))

    expect(result.compacted).toMatchObject({ _tag: "Failure", failure: { code: "compaction_conflict" } })
    expect(result.after).toEqual(result.before)
  })

  it("preserves messages appended while the summarizer is suspended", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* append(store, "thread", 3)
      const started = yield* Deferred.make<void>()
      const resume = yield* Deferred.make<void>()
      let frozen = false
      const fiber = yield* Maintenance.compact({
        threadId: "thread",
        keepRecent: 1,
        makeSummaryId: () => "summary-fixed",
        summarizer: {
          summarize: ({ messages }) =>
            Effect.sync(() => {
              frozen = Object.isFrozen(messages) && messages.every(Object.isFrozen)
            }).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(resume)),
              Effect.as("summary")
            )
        }
      }).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(started)
      const appended = { threadId: "thread", id: "new", role: "user", text: "new information", at: 100 }
      yield* store.appendMessage(appended)
      yield* Deferred.succeed(resume, undefined)
      const compacted = yield* Fiber.join(fiber)
      return { frozen, compacted, appended, messages: yield* store.listMessages({ threadId: "thread" }) }
    }))

    expect(result.frozen).toBe(true)
    expect(result.compacted).toEqual({ compactedThreads: 1, deletedMessages: 2 })
    expect(result.messages.map((message) => message.id)).toEqual(["summary-fixed", "thread-message-2", "new"])
    expect(result.messages.at(-1)).toEqual(result.appended)
  })

  it("rolls back interruption after inserting the summary and deleting the first chunk", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* append(store, "thread", 903)
        const before = JSON.stringify(yield* store.listMessages({ threadId: "thread" }))
        const started = yield* Deferred.make<ReadonlyArray<{ readonly id: string }>>()
        let deletions = 0
        const pausedSql = new Proxy(sql, {
          apply(target, thisArg, argumentsList) {
            const statement = Array.isArray(argumentsList[0]) ? argumentsList[0].join(" ") : ""
            if (statement.includes("DELETE FROM memory_messages") && ++deletions === 2) {
              return {
                raw: sql<{ readonly id: string }>`SELECT id FROM memory_messages ORDER BY at_ms, id`.pipe(
                  Effect.flatMap((rows) => Deferred.succeed(started, rows)),
                  Effect.andThen(Effect.never)
                )
              }
            }
            return Reflect.apply(target, thisArg, argumentsList)
          }
        })
        const pausedStore = yield* MemoryStore.make.pipe(Effect.provideService(SqlClient.SqlClient, pausedSql))
        const options = {
          threadId: "thread",
          summarizer: { summarize: () => Effect.succeed("s") },
          makeSummaryId: () => "summary-fixed"
        }
        const fiber = yield* Maintenance.compact(options).pipe(
          Effect.provideService(MemoryStore.MemoryStore, pausedStore),
          Effect.forkChild({ startImmediately: true })
        )
        const inside = yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        const afterFailure = yield* store.listMessages({ threadId: "thread" })
        const retried = yield* Maintenance.compact(options)
        return { before, inside, afterFailure, retried }
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(result.inside.map((row) => row.id)).toEqual([
      "summary-fixed",
      "thread-message-900",
      "thread-message-901",
      "thread-message-902"
    ])
    expect(JSON.stringify(result.afterFailure)).toBe(result.before)
    expect(result.afterFailure.some((message) => message.id === "summary-fixed")).toBe(false)
    expect(result.retried).toEqual({ compactedThreads: 1, deletedMessages: 901 })
  })

  it.each([0, 900])("rolls back summary and deletion chunks when source %i fails to delete", async (failAt) => {
    const result = await runWithDatabase(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* append(store, "thread", 903)
      const before = JSON.stringify(yield* store.listMessages({ threadId: "thread" }))
      yield* sql.unsafe(`CREATE TRIGGER fail_compaction BEFORE DELETE ON memory_messages
        WHEN OLD.id = 'thread-message-${failAt}'
          AND EXISTS (SELECT 1 FROM memory_messages WHERE id = 'summary-fixed')
        BEGIN SELECT RAISE(ABORT, 'injected compaction delete failure'); END`)
      const options = {
        threadId: "thread",
        summarizer: { summarize: () => Effect.succeed("summary text") },
        makeSummaryId: () => "summary-fixed"
      }
      const failure = yield* Effect.flip(Maintenance.compact(options))
      const afterFailure = yield* store.listMessages({ threadId: "thread" })
      yield* sql`DROP TRIGGER fail_compaction`
      const retried = yield* Maintenance.compact(options)
      return { before, failure, afterFailure, retried, afterRetry: yield* store.listMessages({ threadId: "thread" }) }
    }))

    expect(result.failure.code).toBe("store")
    expect(JSON.stringify(result.afterFailure)).toBe(result.before)
    expect(result.afterFailure.some((message) => message.id === "summary-fixed")).toBe(false)
    expect(result.retried).toEqual({ compactedThreads: 1, deletedMessages: 901 })
    expect(result.afterRetry.map((message) => message.id)).toEqual([
      "summary-fixed",
      "thread-message-901",
      "thread-message-902"
    ])
  })

  it("keeps source messages when the summarizer or summary write fails", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* append(store, "summarizer-failure", 4)
      const summarizerExit = yield* Effect.exit(
        Maintenance.compact({
          threadId: "summarizer-failure",
          summarizer: { summarize: () => Effect.fail("summary unavailable") }
        })
      )
      const afterSummarizerFailure = yield* store.listMessages({ threadId: "summarizer-failure" })

      yield* append(store, "write-failure", 4)
      yield* store.appendMessage({
        threadId: "write-failure",
        id: "summary-conflict",
        role: "system",
        text: "existing",
        at: 99
      })
      const writeExit = yield* Effect.exit(
        Maintenance.compact({
          threadId: "write-failure",
          summarizer: { summarize: () => Effect.succeed("summary") },
          makeSummaryId: () => "summary-conflict"
        })
      )
      const afterWriteFailure = yield* store.listMessages({ threadId: "write-failure" })
      return { summarizerExit, afterSummarizerFailure, writeExit, afterWriteFailure }
    }))

    expect(Exit.isFailure(result.summarizerExit)).toBe(true)
    expect(result.afterSummarizerFailure.map((message) => message.id)).toEqual([
      "summarizer-failure-message-0",
      "summarizer-failure-message-1",
      "summarizer-failure-message-2",
      "summarizer-failure-message-3"
    ])
    expect(Exit.isFailure(result.writeExit)).toBe(true)
    expect(result.afterWriteFailure.map((message) => message.id)).toEqual([
      "write-failure-message-0",
      "write-failure-message-1",
      "write-failure-message-2",
      "write-failure-message-3",
      "summary-conflict"
    ])
  })

  it("cancels compaction through fiber interruption without deleting history", async () => {
    const messages = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* append(store, "thread", 4)
      const started = yield* Deferred.make<void>()
      const fiber = yield* Maintenance.compact({
        threadId: "thread",
        summarizer: {
          summarize: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
        }
      }).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      return yield* store.listMessages({ threadId: "thread" })
    }))

    expect(messages.map((message) => message.id)).toEqual([
      "thread-message-0",
      "thread-message-1",
      "thread-message-2",
      "thread-message-3"
    ])
  })

  it("rejects a token budget or a character ratio that cannot bound history", async () => {
    const failures = await run(Effect.gen(function*() {
      return [
        yield* Effect.flip(Maintenance.limitHistory({ maxTokens: -1 })),
        yield* Effect.flip(Maintenance.limitHistory({ maxTokens: Number.NaN })),
        yield* Effect.flip(Maintenance.limitHistory({ maxTokens: Number.POSITIVE_INFINITY })),
        yield* Effect.flip(Maintenance.limitHistory({ maxTokens: 1, charsPerToken: 0 })),
        yield* Effect.flip(Maintenance.limitHistory({ maxTokens: 1, charsPerToken: -1 })),
        yield* Effect.flip(Maintenance.limitHistory({ maxTokens: 1, charsPerToken: Number.POSITIVE_INFINITY }))
      ]
    }))

    expect(failures.map((error) => [error.code, error.path])).toEqual([
      ["invalid_argument", ["maxTokens"]],
      ["invalid_argument", ["maxTokens"]],
      ["invalid_argument", ["maxTokens"]],
      ["invalid_argument", ["charsPerToken"]],
      ["invalid_argument", ["charsPerToken"]],
      ["invalid_argument", ["charsPerToken"]]
    ])
  })

  it("empties every thread at a zero token budget and keeps everything under the default ratio", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const empty = yield* Maintenance.limitHistory({ maxTokens: 0 })
      yield* append(store, "one", 2)
      yield* append(store, "two", 1)
      const generous = yield* Maintenance.limitHistory({ maxTokens: 1_000 })
      const kept = yield* store.listMessages({ threadId: "one" })
      const cleared = yield* Maintenance.limitHistory({ maxTokens: 0, charsPerToken: 1 })
      const remaining = yield* Effect.all([
        store.countMessages({ threadId: "one" }),
        store.countMessages({ threadId: "two" })
      ])
      return { empty, generous, kept, cleared, remaining }
    }))

    expect(result.empty).toEqual({ deletedMessages: 0 })
    expect(result.generous).toEqual({ deletedMessages: 0 })
    expect(result.kept.map((message) => message.id)).toEqual(["one-message-0", "one-message-1"])
    expect(result.cleared).toEqual({ deletedMessages: 3 })
    expect(result.remaining).toEqual([0, 0])
  })

  it("rejects a negative or fractional keepRecent", async () => {
    const failures = await run(Effect.gen(function*() {
      const summarizer = { summarize: () => Effect.succeed("summary") }
      return [
        yield* Effect.flip(Maintenance.compact({ summarizer, keepRecent: -1 })),
        yield* Effect.flip(Maintenance.compact({ summarizer, keepRecent: 1.5 }))
      ]
    }))

    expect(failures.map((error) => [error.code, error.path])).toEqual([
      ["invalid_argument", ["keepRecent"]],
      ["invalid_argument", ["keepRecent"]]
    ])
  })

  it("compacts nothing when there is no thread, no surplus, or only a system message", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const emptyStore = yield* Maintenance.compact({ summarizer: { summarize: () => Effect.succeed("s") } })
      yield* append(store, "short", 2)
      const atKeepRecent = yield* Maintenance.compact({
        threadId: "short",
        summarizer: { summarize: () => Effect.succeed("s") }
      })
      yield* store.appendMessage({ threadId: "system", id: "system-0", role: "system", text: "boot", at: 0 })
      yield* store.appendMessage({ threadId: "system", id: "system-1", role: "user", text: "one", at: 1 })
      yield* store.appendMessage({ threadId: "system", id: "system-2", role: "assistant", text: "two", at: 2 })
      const systemOnly = yield* Maintenance.compact({
        threadId: "system",
        summarizer: { summarize: () => Effect.succeed("s") }
      })
      const untouched = yield* store.listMessages({ threadId: "system" })
      return { emptyStore, atKeepRecent, systemOnly, untouched }
    }))

    expect(result.emptyStore).toEqual({ compactedThreads: 0, deletedMessages: 0 })
    expect(result.atKeepRecent).toEqual({ compactedThreads: 0, deletedMessages: 0 })
    expect(result.systemOnly).toEqual({ compactedThreads: 0, deletedMessages: 0 })
    expect(result.untouched.map((message) => message.id)).toEqual(["system-0", "system-1", "system-2"])
  })

  it("compacts a single non-system message and replaces every message when keepRecent is zero", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* append(store, "single", 3)
      const single = yield* Maintenance.compact({
        threadId: "single",
        summarizer: { summarize: () => Effect.succeed("older context") }
      })
      const afterSingle = yield* store.listMessages({ threadId: "single" })
      yield* append(store, "all", 2)
      const all = yield* Maintenance.compact({
        threadId: "all",
        keepRecent: 0,
        summarizer: { summarize: ({ messages }) => Effect.succeed(`summary of ${messages.length}`) }
      })
      const afterAll = yield* store.listMessages({ threadId: "all" })
      return { single, afterSingle, all, afterAll }
    }))

    expect(result.single).toEqual({ compactedThreads: 1, deletedMessages: 1 })
    expect(result.afterSingle.map((message) => [message.role, message.text])).toEqual([
      ["system", "older context"],
      ["assistant", "text-1"],
      ["user", "text-2"]
    ])
    expect(result.afterSingle[0]?.id).toMatch(/^summary-[0-9a-f]{64}$/)
    expect(result.all).toEqual({ compactedThreads: 1, deletedMessages: 2 })
    expect(result.afterAll.map((message) => [message.role, message.text])).toEqual([
      ["system", "summary of 2"]
    ])
  })

  it("renders every summarized message as role and text for the injected summarizer", async () => {
    const rendered: Array<string> = []
    await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* append(store, "rendered", 4)
      yield* Maintenance.compact({
        threadId: "rendered",
        summarizer: {
          summarize: (input) =>
            Effect.sync(() => {
              rendered.push(input.rendered)
              return `${input.threadId} summary`
            })
        },
        makeSummaryId: (threadId, messages) => `${threadId}-${messages.length}`
      })
    }))

    expect(rendered).toEqual(["user: text-0\nassistant: text-1"])
  })
})
