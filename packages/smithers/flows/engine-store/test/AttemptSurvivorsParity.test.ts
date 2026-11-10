/**
 * Pins issue #96: the durable-state range read and the `AttemptStore`
 * point-probe fallback must answer survivor discovery identically for every
 * shape of pruned prefix. Before the fix the SQL path reported a survivor
 * whatever its attempt number while the fallback gave up after 32 missing
 * leading attempts, so the same run restored its retry origin under SQL
 * state and silently restarted its expiration budget under the fallback.
 */
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { AttemptStore, type Ownership } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as SqlClient from "effect/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.vibe"
import * as AttemptProbe from "../src/internal/AttemptProbe.vibe"
import * as Migrations from "../src/Migrations.vibe"
import { withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "survivor-parity", pid: 1, nonce: "owner" }

const layers = Layer.provideMerge(
  Layer.mergeAll(Migrations.layer, Layer.provide(AttemptStore.layer, Migrations.layer)),
  TestDatabase.layer
)

const insertOwnedRun = (runId: string) =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    yield* sql`
      INSERT INTO flows_runs (
        run_id, status, created_at_ms,
        owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, state_json
      ) VALUES (
        ${runId}, 'running', 0,
        ${owner.hostId}, ${owner.pid}, ${owner.nonce}, 0, '{}'
      )
    `
  })

const insertAttempt = (runId: string, digest: string, attempt: number) =>
  Effect.gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    yield* sql`
      INSERT INTO flows_attempts (
        run_id, step_key_digest, attempt, state, started_at_ms, meta_json
      ) VALUES (
        ${runId}, ${digest}, ${attempt}, 'failed', ${1000 + attempt}, '{}'
      )
    `
  })

/** Every shape that distinguishes the two implementations. */
const shapes: ReadonlyArray<{ readonly name: string; readonly attempts: ReadonlyArray<number> }> = [
  { name: "fresh key", attempts: [] },
  { name: "from attempt 1", attempts: [1, 2, 3] },
  { name: "short pruned prefix", attempts: [5, 6, 7] },
  { name: "gap after the survivors", attempts: [2, 3, 9] },
  { name: "at the tolerance boundary", attempts: [32, 33] },
  { name: "one past the tolerance boundary", attempts: [33, 34] },
  { name: "long pruned prefix", attempts: [40] }
]

describe("attempt survivor discovery agrees across both paths (issue #96)", () => {
  it.effect.each(shapes)("$name", ({ attempts, name }) =>
    Effect.gen(function*() {
      const digest = `digest-${name.replace(/\s/g, "-")}`
      const runId = `parity-${digest}`
      const probed = yield* withCrypto(
        Effect.gen(function*() {
          yield* insertOwnedRun(runId)
          for (const attempt of attempts) yield* insertAttempt(runId, digest, attempt)
          const state = yield* DurableEngineState.make
          const attemptStore = yield* AttemptStore.AttemptStore
          const ranged = yield* AttemptProbe.probeAttempts(
            attemptStore,
            state.attemptSurvivors,
            runId,
            digest
          )
          const probes = yield* AttemptProbe.probeAttempts(attemptStore, undefined, runId, digest)
          return { ranged, probes }
        }).pipe(Effect.provide(layers))
      )

      expect(probed.ranged).toEqual(probed.probes)

      const first = attempts[0]
      if (first === undefined || first > AttemptProbe.prunedPrefixScanLimit) {
        expect(Option.isNone(probed.ranged)).toBe(true)
        return
      }
      let latest = first
      for (const attempt of attempts.slice(1)) {
        if (attempt !== latest + 1) break
        latest = attempt
      }
      expect(Option.getOrThrow(probed.ranged)).toEqual({
        earliestAttempt: first,
        earliestStartedAtMs: 1000 + first,
        latest
      })
    }))
})
