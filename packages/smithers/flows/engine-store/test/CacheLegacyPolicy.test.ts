import { describe, expect, it } from "@effect/vitest"
import { Journal } from "@smthrs/journal"
import { AttemptStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/sql/SqlClient"
import * as Admission from "../src/internal/CacheAdmission.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { activate, boundary, descriptor, dispatch, evidence, jj } from "./CachePolicyFixtures.ts"
import { sha256, withCrypto } from "./Sha256.ts"

describe("legacy quarantine flags", () => {
  for (
    const invalid of [
      { boundaryQuarantined: false },
      { readSetVerified: false },
      { boundaryQuarantined: "true", readSetVerified: true },
      { boundary: { ...evidence, wholeTreeWritesVerified: false } },
      { boundary: { ...evidence, hermeticReadsVerified: false } }
    ]
  ) {
    it.effect(`preserves malformed legacy proof flags ${JSON.stringify(invalid)}`, () =>
      withCrypto(
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const cache = yield* CacheStore.CacheStore
          const attempts = yield* AttemptStore.AttemptStore
          const journal = yield* Journal.Journal
          const keyDigest = sha256("malformed-flags")
          const meta = { tier: "sealed", boundary: evidence, readSetVerified: true, ...invalid }
          yield* activate("legacy")
          yield* sql`INSERT INTO flows_attempts
        (run_id, step_key_digest, attempt, state, started_at_ms, finished_at_ms, outcome_json, meta_json)
        VALUES ('legacy', ${keyDigest}, 1, 'succeeded', 1, 2, '"durable"', ${JSON.stringify(meta)})`
          yield* sql`INSERT INTO flows_step_cache
        (key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq)
        VALUES (${keyDigest}, '"durable"', ${JSON.stringify(meta)}, 2, 'legacy', 0)`
          const id = { runId: "legacy", stepKeyDigest: keyDigest, attempt: 1 }
          const before = yield* attempts.get(id)
          expect(
            yield* dispatch("legacy", "malformed-flags", () => Effect.die("must never repeat")).pipe(
              Effect.provide(boundary(() => {
                throw new Error("must not replay")
              }))
            )
          ).toBe("durable")
          expect(yield* attempts.get(id)).toEqual(before)
          expect(Option.getOrThrow(yield* cache.get(keyDigest)).meta).toEqual(meta)
          const page = yield* journal.entries({ runId: "legacy" as never, limit: 50 })
          expect(
            page.entries.filter((entry) => entry.eventType === "flows.engine.cache-provenance").map((entry) =>
              entry.payload
            )
          ).toEqual([
            { keyDigest, action: "replay_failed", reason: "invalid-meta", recordedRunId: "legacy", recordedEventSeq: 0 }
          ])
        }).pipe(Effect.provide(Layer.mergeAll(TestStores.layerAt(":memory:"), jj)), Effect.scoped)
      ))
  }
  for (const quarantined of [false, true]) {
    for (const recordedReads of [false, true]) {
      for (const hasBoundary of [false, true]) {
        for (const writes of [false, true]) {
          for (const reads of [false, true]) {
            const label = JSON.stringify({ quarantined, recordedReads, hasBoundary, writes, reads })
            it.effect(label, () =>
              withCrypto(
                Effect.gen(function*() {
                  const meta = {
                    tier: "sealed" as const,
                    ...(quarantined ? { boundaryQuarantined: true as const } : {}),
                    ...(recordedReads ? { readSetVerified: true as const } : {}),
                    ...(hasBoundary ?
                      {
                        boundary: {
                          declaredOutputs: evidence.declaredOutputs,
                          diffIdentity: evidence.diffIdentity,
                          ...(writes ? { wholeTreeWritesVerified: true as const } : {}),
                          ...(reads ? { hermeticReadsVerified: true as const } : {})
                        }
                      } :
                      {})
                  }
                  // Independent truth table: quarantine always forbids shared
                  // reuse; current measurements can replace absent old read proof.
                  const reusable = !quarantined && hasBoundary && writes && reads
                  const publishable = reusable && recordedReads
                  expect(Admission.candidate(meta)._tag === "CandidateEvidence").toBe(reusable)
                  expect(
                    Admission.completion({ _tag: "Eligible", metadata: descriptor }, meta, false)._tag ===
                      "PublishCompletion"
                  ).toBe(publishable)
                  const contradictory = quarantined && (hasBoundary || recordedReads) || recordedReads && !hasBoundary
                  if (contradictory) {
                    expect(Admission.candidate(meta)).toEqual({ _tag: "Refused", reason: "contradictory-evidence" })
                  }

                  const sql = yield* SqlClient.SqlClient
                  const attempts = yield* AttemptStore.AttemptStore
                  const cache = yield* CacheStore.CacheStore
                  const journal = yield* Journal.Journal
                  const key = "legacy-flags"
                  const keyDigest = sha256(key)
                  yield* activate("legacy")
                  // These are actual legacy SQL rows, bypassing current metadata
                  // construction. No classifier result is copied into the fixture.
                  yield* sql`INSERT INTO flows_attempts
                (run_id, step_key_digest, attempt, state, started_at_ms, finished_at_ms, outcome_json, meta_json)
                VALUES ('legacy', ${keyDigest}, 1, 'succeeded', 1, 2, '"durable"', ${JSON.stringify(meta)})`
                  yield* sql`INSERT INTO flows_step_cache
                (key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq)
                VALUES (${keyDigest}, '"durable"', ${JSON.stringify(meta)}, 2, 'legacy', 0)`
                  const id = { runId: "legacy", stepKeyDigest: keyDigest, attempt: 1 }
                  const before = yield* attempts.get(id)
                  let replays = 0
                  expect(
                    yield* dispatch("legacy", key, () => Effect.die("must never repeat")).pipe(
                      Effect.provide(boundary(() => {
                        replays++
                      }))
                    )
                  ).toBe("durable")
                  expect(yield* attempts.get(id)).toEqual(before)
                  expect(Option.getOrThrow(yield* cache.get(keyDigest)).meta).toEqual(meta)
                  // The run's own durably succeeded attempt restores its missing
                  // outputs whenever its recorded evidence is neither quarantined
                  // nor contradictory; the write and read proofs gate shared reuse
                  // and publication above, not the replay of what this run already
                  // recorded. Without evidence there is nothing to restore.
                  expect(replays).toBe(!quarantined && hasBoundary ? 1 : 0)
                  if (!reusable) {
                    const page = yield* journal.entries({ runId: "legacy" as never, limit: 50 })
                    expect(page.entries.some((entry) =>
                      entry.eventType === "flows.engine.cache-provenance" &&
                      (entry.payload as { action?: string }).action === "replay_failed"
                    )).toBe(true)
                    expect(page.entries.some((entry) =>
                      entry.eventType === "flows.engine.cache-provenance" &&
                      (entry.payload as { action?: string }).action === undefined
                    )).toBe(false)
                  }
                }).pipe(Effect.provide(Layer.mergeAll(TestStores.layerAt(":memory:"), jj)), Effect.scoped)
              ))
          }
        }
      }
    }
  }
})
