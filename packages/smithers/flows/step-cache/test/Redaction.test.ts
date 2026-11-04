/**
 * Executable state must survive the durable round trip verbatim: journal
 * payloads are redacted, but the stores that hold resumable state are not.
 * Split out of `@smthrs/journal`'s redaction suite when the stores moved into
 * their own packages — see https://smithers.sh/concepts/journal.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer, Option } from "effect"
import type * as SqlClient from "effect/sql/SqlClient"
import { TestClock } from "effect/testing"
import * as CacheStore from "../src/CacheStore.vibe"
import * as Migrations from "../src/Migrations.vibe"

describe("cached step result redaction", () => {
  // Executable state must round-trip verbatim: a field whose name merely ends
  // in `token`/`secret` is ordinary flow data, and a non-string value replaced
  // by a placeholder string breaks schema decode on resume (issue #72).
  const executable = {
    pageToken: "page-2",
    clientSecret: { rotationMs: 900, scopes: ["read"] },
    retries: 3
  }

  const storeLayers = CacheStore.layer.pipe(
    Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer))
  )

  const withStores = <A, E>(
    body: Effect.Effect<A, E, CacheStore.CacheStore | DurableWriter | SqlClient.SqlClient>
  ) => body.pipe(Effect.provide(storeLayers), Effect.provide(TestClock.layer()))

  it.effect("round-trips a cached step result verbatim", () =>
    Effect.gen(function*() {
      const entry = yield* withStores(Effect.gen(function*() {
        const store = yield* CacheStore.CacheStore
        yield* store.put({
          keyDigest: "digest-cache",
          result: executable,
          meta: executable,
          createdAtMs: 1,
          recordedRunId: "run-cache",
          recordedEventSeq: 0
        })
        return yield* store.get("digest-cache")
      }))

      expect(Option.getOrThrow(entry)).toMatchObject({ result: executable, meta: executable })
    }))
})
