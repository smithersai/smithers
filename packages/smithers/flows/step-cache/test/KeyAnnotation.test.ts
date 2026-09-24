/**
 * A key digest is copied into span attributes only after it passes the
 * cache-key contract, so a malformed key read from a durable row never
 * reaches the trace exporter.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Tracer from "effect/Tracer"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as CacheStore from "../src/CacheStore.ts"
import * as CombinedCacheStore from "../src/CombinedCacheStore.ts"
import * as Migrations from "../src/Migrations.ts"
import * as RemoteCacheStore from "../src/RemoteCacheStore.ts"

const badKey = "bad key\u0000" + "x".repeat(300)

const recordingTracer = () => {
  const spans: Array<Tracer.NativeSpan> = []
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options)
      spans.push(span)
      return span
    }
  })
  return { spans, tracer }
}

const noKeyAnnotated = (spans: ReadonlyArray<Tracer.NativeSpan>) =>
  spans.flatMap((span) => [...span.attributes.values()]).filter((value) => value === badKey)

const remoteStore = RemoteCacheStore.make({ endpoint: "https://cache.example.com" }).pipe(
  Effect.provideService(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })))
    )
  )
)

const sqlStore = Effect.gen(function*() {
  return yield* CacheStore.CacheStore
}).pipe(
  Effect.provide(CacheStore.layer),
  Effect.provide(Migrations.layer),
  Effect.provide(TestDatabase.layer)
)

const emptyTier: CacheStore.Service = {
  get: () => Effect.succeed(Option.none()),
  put: () => Effect.succeed({ _tag: "Inserted" } as const),
  evict: () => Effect.succeed(false),
  sweepExpired: () => Effect.succeed(0)
} as unknown as CacheStore.Service

const tiers: ReadonlyArray<readonly [string, Effect.Effect<CacheStore.Service, unknown>]> = [
  ["sql", sqlStore],
  ["remote", remoteStore],
  ["combined", Effect.succeed(CombinedCacheStore.make({ local: emptyTier, remote: emptyTier }))]
]

describe("key annotation", () => {
  for (const [name, acquire] of tiers) {
    it.effect(`${name} refuses a malformed key before annotating the span`, () =>
      Effect.gen(function*() {
        const store = yield* acquire
        const { spans, tracer } = recordingTracer()
        const lookup = yield* Effect.exit(store.get(badKey).pipe(Effect.provideService(Tracer.Tracer, tracer)))
        const eviction = yield* Effect.exit(store.evict(badKey).pipe(Effect.provideService(Tracer.Tracer, tracer)))
        expect(Exit.isFailure(lookup)).toBe(true)
        expect(Exit.isFailure(eviction)).toBe(true)
        expect(spans.length).toBeGreaterThan(0)
        expect(noKeyAnnotated(spans)).toEqual([])
      }))
  }
})
