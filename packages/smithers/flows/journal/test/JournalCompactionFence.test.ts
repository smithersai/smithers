/**
 * Pins the fence on automatic compaction (#4555).
 *
 * The policy's checkpoint carries the calling process's own `capture`, so an
 * attempt is a mutating write. It runs only after a write an owner's fence
 * admitted, under that owner's fence. A process that does not own the run,
 * a displaced owner included, can raise the count and can never pin its
 * replay state over the live owner's history or delete that history.
 */
import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Cause, Context, Effect, Layer, Logger, Option } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { Journal, type Service } from "../src/Journal.ts"
import { Input, type RunId, type Seq, type SourceId, type SourceSeq } from "../src/JournalEvent.ts"
import * as Migrations from "../src/Migrations.ts"
import type { OwnerId } from "../src/OwnerId.ts"
import * as SqlJournal from "../src/SqlJournal.ts"
import * as Leases from "./fixtures/leases.ts"

const run = "r" as RunId
const live: OwnerId = { hostId: "live", pid: 1, nonce: "live" }
const zombie: OwnerId = { hostId: "zombie", pid: 2, nonce: "stale" }

const input = (sourceId: string, sourceSeq: number) =>
  new Input({
    runId: run,
    sourceId: sourceId as SourceId,
    sourceSeq: sourceSeq as SourceSeq,
    eventType: "event",
    payload: sourceSeq
  })

const database = Layer.provideMerge(Migrations.layer, TestDatabase.layer)

/** A second journal over the same database: another process. */
const process = (options: Partial<SqlJournal.SqlJournalOptions> = {}) =>
  Effect.map(
    Layer.build(SqlJournal.layer({ capacity: 64, overflow: "reject", ...options })),
    (context): Service => Context.get(context, Journal)
  )

const rows = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return (yield* sql<{ seq: number; source_id: string }>`
    SELECT seq, source_id FROM flows_journal_events WHERE run_id = ${run} ORDER BY seq
  `).map((row) => ({ seq: Number(row.seq), source_id: row.source_id }))
})

const hold = (holder: OwnerId) => Effect.flatMap(SqlClient.SqlClient, (sql) => Leases.hold(sql, run, holder))

const fourFromTheLiveOwner = [0, 1, 2, 3].map((seq) => ({ seq, source_id: "engine" }))

const effect = (name: string, body: Effect.Effect<void, unknown, any>) =>
  it.effect(name, () => body.pipe(Effect.scoped, Effect.provide(database)) as Effect.Effect<void>)

describe("the fence on automatic compaction (#4555)", () => {
  effect(
    "a displaced owner's lossy entry never overwrites the checkpoint or deletes the live owner's history",
    Effect.gen(function*() {
      let captures = 0
      // The zombie held the run once; the live owner displaced it.
      yield* hold(zombie)
      yield* hold(live)
      const owner = yield* process()
      for (let index = 0; index < 4; index++) yield* owner.emitDurable(input("engine", index), live)

      const stale = yield* process({
        compaction: {
          entryThreshold: 5,
          capture: () =>
            Effect.sync(() => {
              captures += 1
              return { from: "zombie memory" }
            })
        }
      })
      expect(yield* stale.emitLossy(input("telemetry", 0))).toMatchObject({ _tag: "Accepted" })
      yield* stale.flush

      const refused = yield* Effect.flip(stale.checkpoint({ runId: run, seq: 4 as Seq, state: {} }, zombie))
      expect(refused.code).toBe("fence_lost")
      expect(captures).toBe(0)
      expect(Option.isNone(yield* owner.latestCheckpoint(run))).toBe(true)
      expect(yield* rows).toEqual([...fourFromTheLiveOwner, { seq: 4, source_id: "telemetry" }])
    })
  )

  effect(
    "an unfenced durable write that crosses the threshold compacts nothing",
    Effect.gen(function*() {
      let captures = 0
      yield* hold(live)
      const owner = yield* process()
      for (let index = 0; index < 4; index++) yield* owner.emitDurable(input("engine", index), live)
      const stale = yield* process({
        compaction: {
          entryThreshold: 5,
          capture: () =>
            Effect.sync(() => {
              captures += 1
              return { from: "zombie memory" }
            })
        }
      })
      yield* stale.emitDurableUnfenced(input("telemetry", 0))
      yield* stale.emitDurableUnfenced(input("telemetry", 1))
      yield* stale.flush
      expect(captures).toBe(0)
      expect(Option.isNone(yield* owner.latestCheckpoint(run))).toBe(true)
      expect(yield* rows).toHaveLength(6)
      // Its own fenced write is refused before it commits, so it triggers nothing either.
      expect((yield* Effect.flip(stale.emitDurable(input("telemetry", 2), zombie))).code).toBe("fence_lost")
      expect(captures).toBe(0)
      expect(yield* rows).toHaveLength(6)
    })
  )

  effect(
    "an owner displaced between its commit and the attempt is refused, and its emit still succeeds",
    Effect.gen(function*() {
      const logged: Array<unknown> = []
      const logger = Logger.make<unknown, void>(({ cause }) => {
        if (cause.reasons.length > 0) logged.push(Cause.squash(cause))
      })
      let captures = 0
      yield* hold(zombie)
      const sql = yield* SqlClient.SqlClient
      const stale = yield* process({
        compaction: {
          entryThreshold: 2,
          capture: () =>
            // The reclaim lands after the write committed and before the
            // attempt's own transactions check the fence.
            Effect.as(
              Effect.andThen(Effect.sync(() => captures++), Leases.hold(sql, run, live)),
              { from: "zombie memory" }
            ).pipe(Effect.orDie)
        }
      }).pipe(Effect.provide(Logger.layer([logger])))
      const body = Effect.gen(function*() {
        yield* stale.emitDurable(input("engine", 0), zombie)
        expect(yield* stale.emitDurable(input("engine", 1), zombie)).toMatchObject({ _tag: "Accepted", seq: 1 })
        expect(captures).toBe(1)
        expect(Option.isNone(yield* stale.latestCheckpoint(run))).toBe(true)
        expect(yield* rows).toHaveLength(2)
        expect(logged).toContainEqual(expect.objectContaining({ code: "fence_lost" }))

        // Damped: the live owner's process, with its own policy, compacts with
        // its own capture once its fenced writes reach the threshold.
        const owner = yield* process({
          compaction: { entryThreshold: 3, capture: (_, upTo) => Effect.succeed({ from: "live memory", upTo }) }
        })
        yield* owner.emitDurable(input("engine", 2), live)
        const latest = Option.getOrThrow(yield* owner.latestCheckpoint(run))
        expect(latest.seq).toBe(2)
        expect(latest.state).toEqual({ from: "live memory", upTo: 2 })
        expect(latest.compactedAtMs).not.toBeNull()
        expect(yield* rows).toEqual([{ seq: 2, source_id: "engine" }])
      })
      yield* body.pipe(Effect.provide(Logger.layer([logger])))
    })
  )

  effect(
    "the owner's deferred entries trigger the policy under that owner when they are flushed",
    Effect.gen(function*() {
      const captured: Array<number> = []
      yield* hold(live)
      const owner = yield* process({
        compaction: {
          entryThreshold: 3,
          capture: (_, upTo) =>
            Effect.sync(() => {
              captured.push(upTo)
              return { from: "live memory" }
            })
        }
      })
      yield* owner.emitDeferred!(input("engine", 0), live)
      yield* owner.emitDeferred!(input("engine", 1), live)
      // The host's next write to the run carries the queued entries with it.
      yield* owner.emitDurable(input("engine", 2), live)
      yield* owner.flush
      expect(captured.length).toBeGreaterThan(0)
      const latest = Option.getOrThrow(yield* owner.latestCheckpoint(run))
      expect(latest.state).toEqual({ from: "live memory" })
      expect(latest.seq).toBe(captured.at(-1))
      expect((yield* rows).at(-1)?.seq).toBe(2)
    })
  )
})
