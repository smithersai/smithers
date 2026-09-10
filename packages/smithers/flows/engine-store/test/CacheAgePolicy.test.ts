import { describe, expect, it } from "@effect/vitest"
import { Action } from "@smthrs/flow"
import * as CacheEnvironment from "@smthrs/flow/CacheEnvironment"
import { Journal, JournalEvent } from "@smthrs/journal"
import { AttemptStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { activate, boundary, descriptor, dispatch, jj, owner } from "./CachePolicyFixtures.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const action = Action.make({
  name: "cache-policy/age",
  success: Schema.String,
  error: Schema.Never,
  tier: "sealed",
  execute: Effect.succeed("unused")
})
const policy = (ttlMs?: number) => ttlMs === undefined ? action : CacheEnvironment.withCache(action, { ttlMs })
const at = (millis: number) =>
  Effect.provideService(
    Clock.Clock,
    {
      currentTimeMillisUnsafe: () => millis,
      currentTimeMillis: Effect.succeed(millis),
      currentTimeNanosUnsafe: () => BigInt(millis) * 1_000_000n,
      currentTimeNanos: Effect.succeed(BigInt(millis) * 1_000_000n),
      monotonicTimeNanosUnsafe: () => BigInt(millis) * 1_000_000n,
      monotonicTimeNanos: Effect.succeed(BigInt(millis) * 1_000_000n),
      sleep: () => Effect.void
    } satisfies Clock.Clock
  )
const lineage = (runId: string) => `smithers-journal-lineage/v1:${JSON.stringify([runId])}`

describe("immutable age policy and validated fork replay", () => {
  it.effect("refreshes a prior absence after the same executor consumes a TTL verdict and loses the head", () =>
    withCrypto(
      Effect.gen(function*() {
        let bodies = 0
        const body = () => Effect.sync(() => (bodies++, "recorded"))
        yield* activate("producer")
        yield* dispatch("producer", "later-ttl", body).pipe(at(100))
        yield* activate("consumer")
        const execute = ActionPersistence.make({ runId: "consumer", owner, sourceId: "cache-policy", execute: body })
        const input = { key: "later-ttl", tier: "sealed" as const, attempt: 1, metadata: descriptor }
        expect(yield* execute({ ...input, action: policy() }).pipe(at(200))).toBe("recorded")
        expect(yield* execute({ ...input, action: policy(1000) }).pipe(at(300))).toBe("recorded")
        const cache = yield* CacheStore.CacheStore
        yield* cache.evict(sha256(input.key))
        const result = yield* execute({ ...input, action: policy() }).pipe(at(400), Effect.result)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure).toMatchObject({
            code: "idempotency_conflict",
            message: expect.stringContaining("ttlMs cannot be removed"),
            cause: expect.anything()
          })
        }
        expect(bodies).toBe(1)
      }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jj, boundary())), Effect.scoped)
    ))

  for (const evicted of [false, true]) {
    it(`refuses TTL removal after reopening the database (evicted head: ${evicted})`, async () => {
      const root = mkdtempSync(join(tmpdir(), "cache-age-resume-"))
      const db = join(root, "engine.sqlite")
      let bodies = 0
      const body = () => Effect.sync(() => (bodies++, "recorded"))
      try {
        await Effect.runPromise(withCrypto(
          Effect.gen(function*() {
            yield* activate("producer")
            yield* dispatch("producer", "resume-ttl", body, policy(1000)).pipe(at(100))
            yield* activate("consumer")
            yield* dispatch("consumer", "resume-ttl", body, policy(1000)).pipe(at(200))
            if (evicted) {
              const cache = yield* CacheStore.CacheStore
              yield* cache.evict(sha256("resume-ttl"))
            }
          }).pipe(Effect.provide(Layer.mergeAll(TestStores.layerAt(db), jj, boundary())), Effect.scoped)
        ))
        await Effect.runPromise(withCrypto(
          Effect.gen(function*() {
            const result = yield* dispatch("consumer", "resume-ttl", body, policy()).pipe(at(300), Effect.result)
            expect(Result.isFailure(result)).toBe(true)
            if (Result.isFailure(result)) {
              expect(result.failure).toMatchObject({
                code: "idempotency_conflict",
                message: expect.stringContaining("ttlMs cannot be removed"),
                cause: expect.anything()
              })
            }
          }).pipe(Effect.provide(Layer.mergeAll(TestStores.layerAt(db), jj, boundary())), Effect.scoped)
        ))
        expect(bodies).toBe(1)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }

  it.effect("preserves a copied-history read failure without serving or expiring the row", () =>
    withCrypto(
      Effect.gen(function*() {
        let bodies = 0
        const body = () => Effect.sync(() => (bodies++, "recorded"))
        yield* activate("producer")
        yield* dispatch("producer", "history-read", body, policy(1000)).pipe(at(100))
        yield* activate("parent")
        yield* dispatch("parent", "history-read", body, policy(1000)).pipe(at(1099))
        yield* activate("child", "parent")
        const journal = yield* Journal.Journal
        const cache = yield* CacheStore.CacheStore
        const parent = yield* journal.entries({ runId: JournalEvent.RunId.make("parent"), limit: 50 })
        const ttl = parent.entries.find((entry) => (entry.payload as { action?: string }).action === "ttl")!
        yield* journal.emitDurable({ ...ttl, runId: JournalEvent.RunId.make("child") }, owner)
        const before = yield* cache.get(sha256("history-read"))
        const cause = new Error("injected history storage failure")
        const failure = new Journal.JournalError({ code: "read_failed", message: "history unavailable", cause })
        let reads = 0
        const result = yield* dispatch("child", "history-read", body, policy(1000)).pipe(
          at(2000),
          Effect.provideService(Journal.Journal, {
            ...journal,
            entries: (options) => ++reads === 1 ? journal.entries(options) : Effect.fail(failure)
          }),
          Effect.result
        )
        expect(result).toEqual(Result.fail(failure))
        expect(reads).toBe(2)
        expect(bodies).toBe(1)
        expect(yield* cache.get(sha256("history-read"))).toEqual(before)
      }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jj, boundary())), Effect.scoped)
    ))

  for (const field of ["sourceId", "sourceSeq"] as const) {
    it.effect(`refuses a copied ${field} mismatch before emitting a new age decision`, () =>
      withCrypto(
        Effect.gen(function*() {
          let bodies = 0
          const body = () =>
            Effect.sync(() => {
              bodies++
              return "recorded"
            })
          yield* activate("producer")
          yield* dispatch("producer", "producer-fields", body, policy(1000)).pipe(at(100))
          yield* activate("parent")
          yield* dispatch("parent", "producer-fields", body, policy(1000)).pipe(at(1099))
          yield* activate("child", "parent")
          const journal = yield* Journal.Journal
          const parent = yield* journal.entries({ runId: JournalEvent.RunId.make("parent"), limit: 50 })
          const ttl = parent.entries.find((entry) => (entry.payload as { action?: string }).action === "ttl")!
          yield* journal.emitDurable({
            runId: JournalEvent.RunId.make("child"),
            sourceId: field === "sourceId" ? JournalEvent.SourceId.make("altered-producer") : ttl.sourceId,
            sourceSeq: field === "sourceSeq" ? JournalEvent.SourceSeq.make(99) : ttl.sourceSeq,
            eventType: ttl.eventType,
            payload: ttl.payload,
            meta: ttl.meta
          }, owner)
          const result = yield* dispatch("child", "producer-fields", body, policy(1000)).pipe(at(2000), Effect.result)
          expect(Result.isFailure(result)).toBe(true)
          if (Result.isFailure(result)) {
            expect(result.failure).toMatchObject({
              code: "idempotency_conflict",
              message: expect.stringContaining("producer identity changed"),
              cause: expect.anything()
            })
          }
          const removed = yield* dispatch("child", "producer-fields", body, policy()).pipe(at(2000), Effect.result)
          expect(Result.isFailure(removed)).toBe(true)
          const page = yield* journal.entries({ runId: JournalEvent.RunId.make("child"), limit: 50 })
          expect(page.entries.map((entry) => (entry.payload as { action?: string }).action)).toEqual([
            "ttl",
            "replay_failed"
          ])
          expect(bodies).toBe(1)
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jj, boundary())), Effect.scoped)
      ))
  }
  for (const age of [999, 1000, 1001]) {
    for (const resumed of [0, 999, 1000, 1001, 2000]) {
      it.effect(`refuses TTL removal after age ${age} when the clock moves to ${resumed}`, () =>
        withCrypto(
          Effect.gen(function*() {
            const cache = yield* CacheStore.CacheStore
            const journal = yield* Journal.Journal
            const attempts = yield* AttemptStore.AttemptStore
            const key = "remove-ttl"
            let executions = 0
            const body = () =>
              Effect.sync(() => {
                executions++
                return "result"
              })
            yield* activate("producer")
            yield* dispatch("producer", key, body, policy(1000)).pipe(at(100))
            yield* activate("consumer")
            yield* dispatch("consumer", key, body, policy(1000)).pipe(at(100 + age))
            const before = yield* cache.get(sha256(key))
            const attemptId = { runId: "consumer", stepKeyDigest: sha256(key), attempt: 1 }
            const attemptBefore = yield* attempts.get(attemptId)
            const count = age <= 1000 ? 1 : 2
            expect(executions).toBe(count)
            const result = yield* dispatch("consumer", key, body, policy()).pipe(at(100 + resumed), Effect.result)
            expect(Result.isFailure(result)).toBe(true)
            if (Result.isFailure(result)) {
              expect(result.failure).toMatchObject({
                code: "idempotency_conflict",
                message: expect.stringContaining("ttlMs cannot be removed"),
                cause: expect.anything()
              })
            }
            expect(executions).toBe(count)
            expect(yield* attempts.get(attemptId)).toEqual(attemptBefore)
            expect(yield* cache.get(sha256(key))).toEqual(before)
            const page = yield* journal.entries({ runId: "consumer" as never, limit: 50 })
            const decisions = page.entries.filter((entry) => (entry.payload as { action?: string }).action === "ttl")
            expect(decisions.map((entry) => (entry.payload as { verdict: string }).verdict)).toEqual([
              age <= 1000 ? "admitted" : "expired"
            ])
          }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), jj, boundary())), Effect.scoped)
        ))
    }
  }

  for (const clock of [0, 999, 1000, 1001, 2000]) {
    it(`reopens a parent then copies its real journal prefix and reuses the age verdict at ${clock}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "cache-age-fork-"))
      const db = join(root, "engine.sqlite")
      let bodies = 0
      const body = () =>
        Effect.sync(() => {
          bodies++
          return "parent-result"
        })
      try {
        await Effect.runPromise(withCrypto(
          Effect.gen(function*() {
            yield* activate("producer")
            yield* dispatch("producer", "fork-age", body, policy(1000)).pipe(at(100))
            yield* activate("parent")
            expect(yield* dispatch("parent", "fork-age", body, policy(1000)).pipe(at(1100))).toBe("parent-result")
          }).pipe(Effect.provide(Layer.mergeAll(TestStores.layerAt(db), jj, boundary())), Effect.scoped)
        ))
        expect(bodies).toBe(1)
        await Effect.runPromise(withCrypto(
          Effect.gen(function*() {
            yield* activate("child", "parent")
            const sql = yield* SqlClient.SqlClient
            const journal = yield* Journal.Journal
            const parent = yield* journal.entries({ runId: "parent" as never, limit: 50 })
            const cutoff = parent.entries.at(-1)!.seq
            // Exact current time-travel copy columns, through a fresh connection.
            yield* sql`INSERT INTO flows_journal_events
            (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
            SELECT 'child', seq, 'fork:child:' || event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json
            FROM flows_journal_events WHERE run_id = 'parent' AND seq <= ${cutoff}`
            yield* journal.emitDurable({
              runId: "child" as never,
              sourceId: "flows/time-travel/fork" as never,
              sourceSeq: (cutoff + 1) as never,
              eventType: "flows.time-travel.fork-created",
              payload: { parentRunId: "parent", childRunId: "child", forkJournalOffset: cutoff },
              meta: { lineageId: lineage("parent") }
            }, owner)
            const before = yield* journal.entries({ runId: "child" as never, limit: 50 })
            expect(yield* dispatch("child", "fork-age", body, policy(1000)).pipe(at(100 + clock))).toBe("parent-result")
            expect(yield* dispatch("child", "fork-age", body, policy(1000)).pipe(at(9000))).toBe("parent-result")
            const after = yield* journal.entries({ runId: "child" as never, limit: 50 })
            expect(after).toEqual(before)
            const attempts = yield* AttemptStore.AttemptStore
            expect(
              Option.isNone(yield* attempts.get({ runId: "child", stepKeyDigest: sha256("fork-age"), attempt: 1 }))
            ).toBe(true)
          }).pipe(Effect.provide(Layer.mergeAll(TestStores.layerAt(db), jj, boundary())), Effect.scoped)
        ))
        expect(bodies).toBe(1)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
})
