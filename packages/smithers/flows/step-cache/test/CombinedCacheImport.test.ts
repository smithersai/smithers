import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Option from "effect/Option"
import * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import * as CacheStore from "../src/CacheStore.ts"
import * as CombinedCacheStore from "../src/CombinedCacheStore.ts"
import * as Migrations from "../src/Migrations.ts"
import * as RemoteCacheStore from "../src/RemoteCacheStore.ts"

const entry: CacheStore.CacheEntry = {
  keyDigest: "imported-result",
  result: { forged: true },
  meta: { source: "shared" },
  createdAtMs: 0,
  recordedRunId: "local-run",
  recordedEventSeq: 5
}

const remoteFor = (candidate: CacheStore.CacheEntry, requests: Array<string>) =>
  Effect.gen(function*() {
    const server = yield* Effect.acquireRelease(
      Effect.callback<Server>((resume) => {
        const server = createServer((request, response) => {
          requests.push(request.method!)
          response.writeHead(200, { "content-type": "application/json" })
          response.end(JSON.stringify(candidate))
        })
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)))
      }),
      (server) =>
        Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void))
        })
    )
    return yield* RemoteCacheStore.make({
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    }).pipe(Effect.provide(FetchHttpClient.layer))
  })

const withSqlStore = <A, E>(effect: Effect.Effect<A, E, CacheStore.CacheStore | SqlClient.SqlClient>) =>
  effect.pipe(
    Effect.provide(CacheStore.layer),
    Effect.provide(Migrations.layer),
    Effect.provide(TestDatabase.layer)
  )

describe("shared imports and local event history", () => {
  it.effect.each(["inline", "deferred"] as const)(
    "cannot reserve a local event's provenance during %s publication",
    (publication) =>
      withSqlStore(Effect.scoped(Effect.gen(function*() {
        const local = yield* CacheStore.CacheStore
        const sql = yield* SqlClient.SqlClient
        const requests: Array<string> = []
        const remote = yield* remoteFor(entry, requests)
        const combined = CombinedCacheStore.make({ local, remote, publication })
        const recordedBy = { runId: entry.recordedRunId, eventSeq: entry.recordedEventSeq }

        expect(Option.getOrThrow(yield* combined.get(entry.keyDigest))).toEqual(entry)
        expect(Option.getOrThrow(yield* combined.get(entry.keyDigest))).toEqual(entry)
        expect(requests).toEqual(["GET"])
        expect(yield* local.evict(entry.keyDigest)).toBe(true)

        const actual = { ...entry, result: { local: true }, meta: {}, createdAtMs: 1 }
        expect(yield* local.put(actual)).toEqual({ _tag: "Inserted" })
        expect(Option.getOrThrow(yield* local.get(entry.keyDigest, { recordedBy }))).toEqual(actual)
        expect(yield* local.evict(entry.keyDigest)).toBe(true)
        expect(Option.getOrThrow(yield* local.get(entry.keyDigest, { recordedBy }))).toEqual(actual)
        expect(yield* sql`SELECT result_json FROM flows_step_cache_recorded`).toEqual([
          { result_json: "{\"local\":true}" }
        ])
      })))
  )

  it.effect("keeps shared provenance in the head without manufacturing recorded evidence", () =>
    withSqlStore(Effect.scoped(Effect.gen(function*() {
      const local = yield* CacheStore.CacheStore
      const sql = yield* SqlClient.SqlClient
      const remote = yield* remoteFor(entry, [])
      const combined = CombinedCacheStore.make({ local, remote })
      const recordedBy = { runId: entry.recordedRunId, eventSeq: entry.recordedEventSeq }

      expect(Option.getOrThrow(yield* combined.get(entry.keyDigest))).toEqual(entry)
      expect(Option.getOrThrow(yield* local.get(entry.keyDigest, { recordedBy }))).toEqual(entry)
      expect(yield* sql`SELECT * FROM flows_step_cache_recorded`).toEqual([])
      expect(yield* combined.evict(entry.keyDigest, { ifRecordedBy: recordedBy })).toBe(true)
      expect(yield* local.get(entry.keyDigest, { recordedBy })).toEqual(Option.none())
    }))))

  it.effect("preserves an existing local event when a shared head claims its provenance", () =>
    withSqlStore(Effect.scoped(Effect.gen(function*() {
      const local = yield* CacheStore.CacheStore
      const actual = { ...entry, result: { local: true } }
      yield* local.put(actual)
      yield* local.evict(entry.keyDigest)
      const remote = yield* remoteFor(entry, [])
      const combined = CombinedCacheStore.make({ local, remote })

      expect(Option.getOrThrow(yield* combined.get(entry.keyDigest))).toEqual(entry)
      expect(Option.getOrThrow(yield* local.get(entry.keyDigest))).toEqual(entry)
      expect(Option.getOrThrow(
        yield* local.get(entry.keyDigest, {
          recordedBy: { runId: entry.recordedRunId, eventSeq: entry.recordedEventSeq }
        })
      )).toEqual(actual)
    }))))
  it.effect("serves shared hits without calling put on a custom tier lacking head-only imports", () =>
    Effect.scoped(Effect.gen(function*() {
      const local = CacheStore.makeNoop({ get: () => Effect.succeed(Option.none()) })
      const requests: Array<string> = []
      const remote = yield* remoteFor(entry, requests)
      const combined = CombinedCacheStore.make({ local, remote })

      expect(combined.importHead).toBeUndefined()
      expect(Option.getOrThrow(yield* combined.get(entry.keyDigest))).toEqual(entry)
      expect(Option.getOrThrow(yield* combined.get(entry.keyDigest))).toEqual(entry)
      expect(requests).toEqual(["GET", "GET"])
    })))

  it.effect("imports only the head through a nested composition and arbitrates canonical results", () =>
    withSqlStore(Effect.gen(function*() {
      const local = yield* CacheStore.CacheStore
      const sql = yield* SqlClient.SqlClient
      const combined = CombinedCacheStore.make({ local, remote: CacheStore.makeNoop() })
      const nested = CombinedCacheStore.make({ local: combined, remote: CacheStore.makeNoop() })
      const first = { ...entry, result: { a: 1, b: 2 } }
      expect(yield* nested.importHead!(first)).toEqual({ _tag: "Inserted" })
      expect(
        yield* nested.importHead!({
          ...entry,
          result: { b: 2, a: 1 },
          meta: { changed: true },
          createdAtMs: 2,
          recordedRunId: "different-run",
          recordedEventSeq: 9
        })
      ).toEqual({ _tag: "ExistingSame" })
      expect(yield* nested.importHead!(entry)).toEqual({ _tag: "Conflict" })
      expect(Option.getOrThrow(yield* local.get(entry.keyDigest))).toEqual(first)
      expect(yield* sql`SELECT * FROM flows_step_cache_recorded`).toEqual([])
      const invalid = yield* Effect.flip(nested.importHead!({ ...entry, keyDigest: "../invalid" }))
      expect(invalid.code).toBe("invalid_cache")
    })))

  it.effect.each(
    [
      { localMode: "head-only", age: "unbounded" },
      { localMode: "head-only", age: "fresh" },
      { localMode: "head-only", age: "expired" },
      { localMode: "custom", age: "unbounded" },
      { localMode: "custom", age: "fresh" },
      { localMode: "custom", age: "expired" }
    ] as const
  )(
    "rechecks concurrent local event evidence: %j",
    ({ localMode, age }) =>
      withSqlStore(Effect.scoped(Effect.gen(function*() {
        const local = yield* CacheStore.CacheStore
        const remote = yield* remoteFor(entry, [])
        const entered = yield* Deferred.make<void>()
        const resume = yield* Deferred.make<void>()
        const pause = <A, E>(effect: Effect.Effect<A, E>) =>
          Effect.gen(function*() {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(resume)
            return yield* effect
          })
        const combined = CombinedCacheStore.make({
          local: {
            ...local,
            importHead: localMode === "head-only" ? (candidate) => pause(local.importHead!(candidate)) : undefined
          },
          remote: localMode === "head-only" ? remote : {
            ...remote,
            get: (key, options) => remote.get(key, options).pipe(Effect.flatMap((hit) => pause(Effect.succeed(hit))))
          }
        })
        const recordedBy = { runId: entry.recordedRunId, eventSeq: entry.recordedEventSeq }
        const options = { recordedBy, ...(age === "unbounded" ? {} : { maxAgeMs: 1000 }) }
        const lookup = yield* Effect.forkChild(combined.get(entry.keyDigest, options), { startImmediately: true })
        yield* Deferred.await(entered)
        const actual = { ...entry, result: { local: true } }
        expect(yield* local.put(actual)).toEqual({ _tag: "Inserted" })
        yield* local.evict(entry.keyDigest)
        if (age === "expired") yield* TestClock.adjust("5 seconds")
        yield* Deferred.succeed(resume, undefined)

        expect(yield* Fiber.join(lookup)).toEqual(age === "expired" ? Option.none() : Option.some(actual))
        expect(Option.getOrThrow(yield* local.get(entry.keyDigest, { recordedBy }))).toEqual(actual)
      })))
  )
})
