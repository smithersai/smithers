/**
 * A guarded action's result and its boundary evidence agree.
 *
 * `guard` used to return a `TimeTravelError` when the `succeeded` record
 * failed to persist and leave the journal holding only `intended`, the
 * shape a crash leaves. The caller was told the effect failed while the
 * journal could not say how it settled, and when the record had committed
 * before its acknowledgment was lost the journal said `succeeded` while the
 * caller was told it failed. These cases run the real SQL journal: either the
 * caller gets the value and the journal says `succeeded`, or the caller gets
 * a typed `unknown` failure and the journal holds no `succeeded` record.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as SqlConsensus from "@smthrs/journal/SqlConsensus"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/sql/SqlClient"
import * as EffectBoundary from "../src/EffectBoundary.vibe"
import * as Migrations from "../src/Migrations.vibe"
import { TimeTravelError } from "../src/TimeTravelError.vibe"

const owner = { hostId: "settlement-host", pid: 7, nonce: "settlement-owner" }

const description = (id: string): EffectBoundary.Description => ({
  id,
  kind: "mail.send",
  tier: "irreversible",
  runId: "run",
  lineageId: "run/root",
  owner,
  sourceId: "adapter",
  sourceSeq: 0,
  idempotencyKey: `send/${id}`
})

/** The real journal, migrated, with `run` claimed by {@link owner}. */
const database = (maxEntryBytes?: number) =>
  SqlJournal.layer({ capacity: 32, overflow: "reject", ...(maxEntryBytes === undefined ? {} : { maxEntryBytes }) })
    .pipe(Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer)))

const claimRun = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO flows_runs (run_id, status, created_at_ms, state_json) VALUES ('run', 'suspended', 0, '{}')`
  const runs = yield* RunStore.make.pipe(Effect.provide(SqlConsensus.layer))
  const expected = { status: "suspended" as const, owner: null, heartbeatAtMs: null }
  yield* runs.claim("run", expected, owner, 0)
  yield* runs.activate("run", owner, 0, expected)
})

const statusOf = (input: JournalEvent.Input): string =>
  (input.payload as { readonly effect: { readonly status: string } }).effect.status

/** The boundary statuses the journal holds for `run`, in commit order. */
const recorded = Effect.gen(function*() {
  const page = yield* (yield* Journal.Journal).entries({ runId: "run" as JournalEvent.RunId, limit: 100 })
  const entries = page.entries.filter((entry) => entry.eventType === EffectBoundary.eventType)
  return {
    statuses: entries.map((entry) => (entry.payload as { readonly effect: { readonly status: string } }).effect.status),
    folded: yield* EffectBoundary.fromEntries(entries)
  }
})

/**
 * The real journal with one fault injected into the durable channel. `fault`
 * sees each write and either lets the real journal take it or answers for it.
 */
const faulty = (
  fault: (
    input: JournalEvent.Input,
    write: Effect.Effect<Journal.DurableReceipt, Journal.JournalError>
  ) => Effect.Effect<Journal.DurableReceipt, Journal.JournalError>
) =>
  Effect.gen(function*() {
    const real = yield* Journal.Journal
    return {
      ...real,
      emitDurable: (input, holder) => fault(input, real.emitDurable(input, holder))
    } satisfies Journal.Service
  })

const offline = (message: string) => Effect.fail(new Journal.JournalError({ code: "sink_failed", message }))

describe("EffectBoundary.guard settles a success it could not record", () => {
  it.effect("records unknown and fails typed when the succeeded record is refused", () =>
    Effect.gen(function*() {
      yield* claimRun
      let runs = 0
      // The real journal refuses the succeeded record: its output is over
      // the entry bound the intended and unknown records fit under.
      const failure = yield* Effect.flip(
        EffectBoundary.guard(description("oversized"), Effect.sync(() => (runs += 1, "x".repeat(8_192))))
      )
      const { folded, statuses } = yield* recorded

      expect(runs).toBe(1)
      expect(failure).toBeInstanceOf(TimeTravelError)
      expect(failure).toMatchObject({
        code: "unknown",
        message: "effect oversized succeeded, but its succeeded boundary could not be recorded; it is recorded unknown"
      })
      expect((failure as TimeTravelError).cause).toMatchObject({ code: "invalid_event" })
      expect(statuses).toEqual(["intended", "unknown"])
      expect(folded).toEqual([expect.objectContaining({ id: "oversized", status: "unknown" })])
      expect(folded[0]).not.toHaveProperty("output")
    }).pipe(Effect.provide(database(2_048))))

  it.effect("returns the value when the succeeded record committed but its acknowledgment was lost", () =>
    Effect.gen(function*() {
      yield* claimRun
      const writes: Array<string> = []
      const journal = yield* faulty((input, write) => {
        writes.push(statusOf(input))
        // The first succeeded write commits, then its receipt is lost.
        return statusOf(input) === "succeeded" && writes.filter((status) => status === "succeeded").length === 1
          ? write.pipe(Effect.andThen(offline("connection reset after commit")))
          : write
      })
      const value = yield* EffectBoundary.guard(description("acknowledged"), Effect.succeed("sent")).pipe(
        Effect.provideService(Journal.Journal, journal)
      )
      const { folded, statuses } = yield* recorded

      expect(value).toBe("sent")
      // The unknown write collided with the committed success, and an
      // identical succeeded write confirmed it.
      expect(writes).toEqual(["intended", "succeeded", "unknown", "succeeded"])
      expect(statuses).toEqual(["intended", "succeeded"])
      expect(folded).toEqual([expect.objectContaining({ id: "acknowledged", status: "succeeded", output: "sent" })])
    }).pipe(Effect.provide(database())))

  it.effect("fails typed and leaves only intended when the journal accepts no terminal record", () =>
    Effect.gen(function*() {
      yield* claimRun
      const journal = yield* faulty((input, write) =>
        statusOf(input) === "intended" ? write : offline("journal offline")
      )
      const failure = yield* Effect.flip(
        EffectBoundary.guard(description("offline"), Effect.succeed("sent")).pipe(
          Effect.provideService(Journal.Journal, journal)
        )
      )
      const { folded, statuses } = yield* recorded

      expect(failure).toMatchObject({
        code: "unknown",
        message: "effect offline succeeded, but neither its succeeded nor its unknown boundary could be recorded"
      })
      expect(statuses).toEqual(["intended"])
      expect(folded).toEqual([expect.objectContaining({ id: "offline", status: "intended" })])
    }).pipe(Effect.provide(database())))

  it.effect("fails typed when the success may have committed but cannot be confirmed", () =>
    Effect.gen(function*() {
      yield* claimRun
      let succeeded = 0
      const journal = yield* faulty((input, write) => {
        if (statusOf(input) !== "succeeded") return write
        succeeded += 1
        // The success commits and its receipt is lost; the journal is then
        // gone before the confirming write.
        return succeeded === 1 ? write.pipe(Effect.andThen(offline("connection reset after commit"))) : offline("gone")
      })
      const failure = yield* Effect.flip(
        EffectBoundary.guard(description("unconfirmed"), Effect.succeed("sent")).pipe(
          Effect.provideService(Journal.Journal, journal)
        )
      )

      expect(failure).toMatchObject({
        code: "unknown",
        message: "effect unconfirmed succeeded, but its succeeded boundary could not be confirmed"
      })
      expect(succeeded).toBe(2)
    }).pipe(Effect.provide(database())))

  it.effect("still decodes a crossing an older guard left at intended", () =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      // The shape the old guard left when its succeeded record failed:
      // `intended` and nothing after it.
      yield* sql`
        INSERT INTO flows_journal_events
          (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
        VALUES ('run', 0, 'legacy-intended', 'adapter', 0, 0, ${EffectBoundary.eventType},
          ${
        JSON.stringify({
          version: 1,
          effect: {
            id: "legacy",
            kind: "mail.send",
            tier: "irreversible",
            status: "intended",
            runId: "run",
            lineageId: "run/root",
            idempotencyKey: "send/legacy"
          }
        })
      }, ${JSON.stringify({ lineageId: "run/root" })})`
      const { folded, statuses } = yield* recorded

      expect(statuses).toEqual(["intended"])
      expect(folded).toEqual([
        expect.objectContaining({ id: "legacy", status: "intended", durableBoundary: true, providerStream: false })
      ])
    }).pipe(Effect.provide(database())))
})
