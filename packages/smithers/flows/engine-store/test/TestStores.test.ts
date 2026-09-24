/**
 * The engine composes the journal, the run store, and the step cache over one
 * database. This pins that the
 * bundle really is one database with one migrated schema.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { describe, expect, it } from "@effect/vitest"
import { Journal } from "@smthrs/journal/Journal"
import { type RunId, type SourceId } from "@smthrs/journal/JournalEvent"
import { AttemptStore } from "@smthrs/run-store/AttemptStore"
import { RunStore } from "@smthrs/run-store/RunStore"
import { CacheStore } from "@smthrs/step-cache/CacheStore"
import { Effect, Option } from "effect"
import * as TestStores from "../src/test/TestStores.ts"

describe("TestStores", () => {
  it.effect("provides the complete production service bundle over in-memory SQLite", () =>
    Effect.gen(function*() {
      const owner = { hostId: "test-host", pid: 1, nonce: "bundle-owner" }
      const result = yield* (
        Effect.gen(function*() {
          const journal = yield* Journal
          const runs = yield* RunStore
          const attempts = yield* AttemptStore
          const cache = yield* CacheStore

          yield* runs.create("bundle-run", "{}")
          const pending = yield* runs.get("bundle-run")
          const snapshot = {
            status: pending.status,
            owner: pending.owner,
            heartbeatAtMs: pending.heartbeatAtMs
          }
          const claim = yield* runs.claim("bundle-run", snapshot, owner, 1)
          if (claim._tag !== "Claimed") {
            return yield* Effect.die(new Error("bundle run claim was lost"))
          }
          yield* runs.activate("bundle-run", owner, claim.claimedAtMs, snapshot)
          yield* attempts.put({
            runId: "bundle-run",
            stepKeyDigest: "bundle-step",
            attempt: 0,
            state: "running",
            startedAtMs: 1,
            meta: { poisonPill: false }
          }, owner)
          yield* attempts.finish({
            runId: "bundle-run",
            stepKeyDigest: "bundle-step",
            attempt: 0,
            state: "completed",
            finishedAtMs: 2,
            outcome: { value: "ok" }
          }, owner)
          yield* journal.emitDurable({
            runId: "bundle-run" as RunId,
            sourceId: "bundle" as SourceId,
            eventType: "step.completed",
            payload: { value: "ok" }
          }, owner)
          yield* journal.flush
          yield* cache.put({
            keyDigest: "bundle-cache",
            result: { value: "ok" },
            meta: {},
            createdAtMs: 2,
            recordedRunId: "bundle-run",
            recordedEventSeq: 0
          })

          return {
            attempt: yield* attempts.get({
              runId: "bundle-run",
              stepKeyDigest: "bundle-step",
              attempt: 0
            }),
            cache: yield* cache.get("bundle-cache"),
            entries: yield* journal.entries({
              runId: "bundle-run" as RunId,
              limit: 10
            })
          }
        }).pipe(
          Effect.provide(TestStores.layer({ capacity: 8 })),
          Effect.provide(NodeCrypto.layer),
          Effect.scoped
        )
      )

      expect(Option.getOrThrow(result.attempt).meta).toEqual({ poisonPill: false })
      expect(Option.getOrThrow(result.cache).result).toEqual({ value: "ok" })
      expect(result.entries.entries.map((entry) => entry.seq)).toEqual([0])
    }))
})
