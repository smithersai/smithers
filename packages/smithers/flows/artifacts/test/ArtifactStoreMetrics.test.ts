/**
 * The artifact counters: successful puts and gets land in the registry the
 * caller provided; typed failures deliberately do not.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as Metric from "effect/Metric"
import * as ArtifactStore from "../src/ArtifactStore.vibe"
import * as ArtifactStoreMetrics from "../src/ArtifactStoreMetrics.vibe"
import * as CombinedArtifacts from "../src/CombinedArtifacts.vibe"
import * as RemoteArtifacts from "../src/RemoteArtifacts.vibe"
import { bytes, sha256, withCrypto } from "./Crypto.ts"

const count = (metric: Metric.Metric<number, Metric.CounterState<number>>) =>
  Effect.map(Metric.value(metric), (state) => state.count)

describe("ArtifactStoreMetrics", () => {
  it.effect("counts successful puts and gets through the provided registry", () =>
    Effect.gen(function*() {
      const artifacts = ArtifactStore.makeMemory()
      yield* withCrypto(
        Effect.gen(function*() {
          const digest = yield* artifacts.put(bytes("a counted artifact"))
          yield* artifacts.put(bytes("a counted artifact"))
          yield* artifacts.get(digest)
          // A miss fails with its typed error and is deliberately not counted.
          yield* Effect.flip(artifacts.get("0".repeat(64)))

          expect(yield* count(ArtifactStoreMetrics.puts)).toBe(2)
          expect(yield* count(ArtifactStoreMetrics.gets)).toBe(1)
        }).pipe(Effect.provideService(Metric.MetricRegistry, new Map()))
      )
    }))

  it.effect("counts local traffic only, so a shared-tier read is invisible", () =>
    Effect.gen(function*() {
      // What the counters mean through a two-tier stack, pinned because the
      // module documents it and nothing else could catch the claim drifting:
      // `RemoteArtifacts` updates no metric, so a read the shared tier serves
      // moves no get, and its write-back is indistinguishable from a producer's
      // put.
      const payload = "a two-tier artifact"
      const digest = sha256(bytes(payload))
      const client = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(payload)))
      )
      yield* withCrypto(
        Effect.gen(function*() {
          const remote = yield* RemoteArtifacts.make({ endpoint: "https://cache.example.com" }).pipe(
            Effect.provideService(HttpClient.HttpClient, client)
          )
          const combined = yield* CombinedArtifacts.make({ local: ArtifactStore.makeMemory(), remote })
          const before = {
            puts: yield* count(ArtifactStoreMetrics.puts),
            gets: yield* count(ArtifactStoreMetrics.gets)
          }

          // Served by the shared tier: the local miss is uncounted, the remote
          // read is uncounted, and only the write-back moves a counter.
          yield* combined.get(digest)
          expect((yield* count(ArtifactStoreMetrics.gets)) - before.gets).toBe(0)
          expect((yield* count(ArtifactStoreMetrics.puts)) - before.puts).toBe(1)

          // Served locally the second time, which is the one a get counts.
          yield* combined.get(digest)
          expect((yield* count(ArtifactStoreMetrics.gets)) - before.gets).toBe(1)
        }).pipe(Effect.provideService(Metric.MetricRegistry, new Map()))
      )
    }))
})
