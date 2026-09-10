import { describe, expect, it } from "@effect/vitest"
import * as Jj from "@smthrs/jj"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import type * as Ownership from "@smthrs/run-store/Ownership"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import { TestClock } from "effect/testing"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import { layerWith, TimeTravel } from "../src/TimeTravel.ts"
import { TimeTravelStore } from "../src/TimeTravelStore.ts"

const row: RunStore.RunRow = {
  runId: "run",
  status: "suspended",
  createdAtMs: 0,
  startedAtMs: 0,
  finishedAtMs: null,
  owner: null,
  heartbeatAtMs: null,
  claim: null,
  claimedAtMs: null,
  parentRunId: null,
  cancelRequestedAtMs: null,
  stateJson: "{}"
}

describe("TimeTravel rewind options", () => {
  const malformed: ReadonlyArray<{ readonly pageSize?: number; readonly maxHistoryEntries?: number }> = [
    { pageSize: 0 },
    { pageSize: -1 },
    { pageSize: Number.NaN },
    { pageSize: Number.POSITIVE_INFINITY },
    { maxHistoryEntries: 0 },
    { maxHistoryEntries: -1 },
    { maxHistoryEntries: 1.5 },
    { maxHistoryEntries: Number.NaN }
  ]
  for (const options of malformed) {
    it.effect(`rejects ${JSON.stringify(options)} before claim, audit, or truncation`, () =>
      Effect.gen(function*() {
        const store = MemoryTimeTravelStore.make({
          records: [
            {
              runId: "run",
              seq: 0,
              eventId: "base",
              lineageId: "run/root",
              payload: { eventType: "base", payload: {}, meta: { lineageId: "run/root" } }
            },
            {
              runId: "run",
              seq: 1,
              eventId: "suffix",
              lineageId: "run/root",
              payload: { eventType: "suffix", payload: {}, meta: { lineageId: "run/root" } }
            }
          ]
        })
        const before = store.state()
        let claims = 0
        let pages = 0
        const entries: ReadonlyArray<JournalEvent.Entry> = store.state().records.map((record) => ({
          runId: record.runId as JournalEvent.RunId,
          seq: record.seq as JournalEvent.Seq,
          eventId: record.eventId,
          sourceId: "options" as JournalEvent.SourceId,
          sourceSeq: record.seq as JournalEvent.SourceSeq,
          emittedAtMs: record.seq,
          eventType: "test",
          payload: {},
          meta: { lineageId: record.lineageId }
        }))
        const journal = Journal.makeNoop({
          entries: ({ after, limit }) =>
            Effect.sync(() => {
              pages += 1
              const remaining = entries.filter((entry) => entry.seq > (after ?? -1))
              const page = remaining.slice(0, Math.max(0, Math.min(limit, remaining.length)))
              return { entries: page, hasMore: remaining.length > page.length }
            })
        })
        const runs = RunStore.makeNoop({
          get: () => Effect.succeed(row),
          claim: (_runId, _expected, _owner, nowMs) =>
            Effect.sync(() => {
              claims += 1
              return { _tag: "Claimed" as const, claimedAtMs: nowMs }
            }),
          activate: () => Effect.succeed({ _tag: "Activated" as const }),
          transitionOwned: () => Effect.succeed({ _tag: "Transitioned" as const })
        })
        const layer = TimeTravel.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(TimeTravelStore)(store),
              Layer.succeed(RunStore.RunStore)(runs),
              Layer.succeed(Journal.Journal)(journal),
              Layer.succeed(Jj.Jj)(Jj.makeNoop({ snapshot: () => Effect.succeed({ changeId: "current" }) })),
              CacheStore.layerNoop()
            )
          )
        )
        const exit = yield* (
          Effect.scoped(
            Effect.gen(function*() {
              const timeTravel = yield* TimeTravel
              return yield* Effect.exit(
                timeTravel.rewind(
                  { runId: "run", frame: { lineageId: "run/root", seq: 0 } },
                  options
                )
              )
            }).pipe(Effect.provide(layer))
          )
        )

        expect(Exit.isFailure(exit)).toBe(true)
        expect(claims).toBe(0)
        expect(pages).toBe(0)
        expect(store.state()).toEqual(before)
      }))
  }
})

/**
 * Startup recovery is wiring, so the shipped composition has to be able to
 * make progress on its own: a rewind interrupted by a crash leaves the run
 * `running` under the dead incarnation's owner, and with no way to answer "is
 * that owner still there" every build refused the audit forever.
 */
describe("TimeTravel recovery liveness", () => {
  const stranger: Ownership.OwnerId = { hostId: "dead-host", pid: 7, nonce: "dead-incarnation" }

  const crashedAudit = {
    id: "audit",
    runId: "run",
    frame: { lineageId: "run/root", seq: 0 },
    status: "in_progress" as const,
    detail: {
      version: 1,
      phase: "archive_committed",
      originalStatus: "suspended",
      suffixCount: 1,
      suffixTailSeq: 1,
      warnings: [],
      cancelledChildren: []
    }
  }

  const recovered = (
    runs: RunStore.Service,
    options?: { readonly isAlive: Ownership.LivenessCheck }
  ) =>
    Effect.gen(function*() {
      // Past the heartbeat staleness window, so the default lease check has
      // something to conclude: the crashed incarnation stopped renewing.
      yield* TestClock.adjust("1 minute")
      const store = MemoryTimeTravelStore.make()
      yield* store.writeAudit(crashedAudit)
      const composed = (options === undefined ? TimeTravel.layer : layerWith(options)).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(TimeTravelStore)(store),
            Layer.succeed(RunStore.RunStore)(runs),
            Layer.succeed(Journal.Journal)(
              Journal.makeNoop({ entries: () => Effect.succeed({ entries: [], hasMore: false }) })
            ),
            Layer.succeed(Jj.Jj)(Jj.makeNoop({ snapshot: () => Effect.succeed({ changeId: "current" }) })),
            CacheStore.layerNoop()
          )
        )
      )
      yield* Effect.scoped(Effect.provide(Effect.void, composed))
      return store.state().audits
    })

  const runningRow = (owner: Ownership.OwnerId | null, heartbeatAtMs: number | null): RunStore.RunRow => ({
    ...row,
    status: "running",
    owner,
    heartbeatAtMs
  })

  it.effect("steals a crashed rewind's run from an owner whose lease expired", () =>
    Effect.gen(function*() {
      const evidence: Array<Ownership.LivenessEvidence> = []
      const audits = yield* recovered(
        RunStore.makeNoop({
          get: () => Effect.succeed(runningRow(stranger, 0)),
          steal: (_runId, _expected, _claimant, nowMs, supplied) =>
            Effect.sync(() => {
              evidence.push(supplied)
              return { _tag: "Claimed" as const, claimedAtMs: nowMs }
            }),
          activate: () => Effect.succeed({ _tag: "Activated" as const }),
          transitionOwned: () => Effect.succeed({ _tag: "Transitioned" as const })
        })
      )

      // `lease-expired` is the only host-neutral kind, and it is the one
      // `RunStore.steal` re-verifies for itself in the same write.
      expect(evidence.map((item) => item.kind)).toEqual(["lease-expired"])
      expect(evidence[0]?.expectedOwner).toEqual(stranger)
      expect(audits[0]).toMatchObject({ status: "completed" })
    }))

  it.effect("leaves the audit recoverable when a supplied probe says the owner is alive", () =>
    Effect.gen(function*() {
      let steals = 0
      const audits = yield* recovered(
        RunStore.makeNoop({
          get: () => Effect.succeed(runningRow(stranger, 0)),
          steal: () =>
            Effect.sync(() => {
              steals += 1
              return { _tag: "Claimed" as const, claimedAtMs: 0 }
            })
        }),
        { isAlive: () => Effect.succeed(true) }
      )

      expect(steals).toBe(0)
      expect(audits[0]).toMatchObject({ status: "in_progress" })
    }))

  it.effect("declines to produce evidence about a running row that records no owner", () =>
    Effect.gen(function*() {
      let steals = 0
      const audits = yield* recovered(
        RunStore.makeNoop({
          get: () => Effect.succeed(runningRow(null, null)),
          steal: () =>
            Effect.sync(() => {
              steals += 1
              return { _tag: "Claimed" as const, claimedAtMs: 0 }
            })
        })
      )

      expect(steals).toBe(0)
      expect(audits[0]).toMatchObject({ status: "in_progress" })
    }))
})

describe("TimeTravel rewind history cap", () => {
  it.effect("refuses a suffix longer than maxHistoryEntries before the claim", () =>
    Effect.gen(function*() {
      const journalRecord = (seq: number): MemoryTimeTravelStore.JournalRecord => ({
        runId: "run",
        seq,
        eventId: `event-${seq}`,
        lineageId: "run/root",
        payload: { eventType: "test", payload: {}, meta: { lineageId: "run/root" } }
      })
      const store = MemoryTimeTravelStore.make({ records: [journalRecord(0), journalRecord(1), journalRecord(2)] })
      const before = store.state()
      let claims = 0
      const entries: ReadonlyArray<JournalEvent.Entry> = store.state().records.map((record) => ({
        runId: record.runId as JournalEvent.RunId,
        seq: record.seq as JournalEvent.Seq,
        eventId: record.eventId,
        sourceId: "options" as JournalEvent.SourceId,
        sourceSeq: record.seq as JournalEvent.SourceSeq,
        emittedAtMs: record.seq,
        eventType: "test",
        payload: {},
        meta: { lineageId: record.lineageId }
      }))
      const journal = Journal.makeNoop({
        entries: ({ after, limit }) =>
          Effect.sync(() => {
            const remaining = entries.filter((entry) => entry.seq > (after ?? -1))
            const page = remaining.slice(0, limit)
            return { entries: page, hasMore: remaining.length > page.length }
          })
      })
      const runs = RunStore.makeNoop({
        get: () => Effect.succeed(row),
        claim: (_runId, _expected, _owner, nowMs) =>
          Effect.sync(() => {
            claims += 1
            return { _tag: "Claimed" as const, claimedAtMs: nowMs }
          }),
        activate: () => Effect.succeed({ _tag: "Activated" as const }),
        transitionOwned: () => Effect.succeed({ _tag: "Transitioned" as const })
      })
      const layer = TimeTravel.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(TimeTravelStore)(store),
            Layer.succeed(RunStore.RunStore)(runs),
            Layer.succeed(Journal.Journal)(journal),
            Layer.succeed(Jj.Jj)(Jj.makeNoop({ snapshot: () => Effect.succeed({ changeId: "current" }) })),
            CacheStore.layerNoop()
          )
        )
      )
      const outcome = yield* Effect.scoped(
        Effect.gen(function*() {
          const timeTravel = yield* TimeTravel
          const refused = yield* Effect.flip(
            timeTravel.rewind({ runId: "run", frame: { lineageId: "run/root", seq: 0 } }, { maxHistoryEntries: 1 })
          )
          // Exactly at the cap the truncation proceeds.
          const allowed = yield* timeTravel.rewind(
            { runId: "run", frame: { lineageId: "run/root", seq: 0 } },
            { maxHistoryEntries: 2 }
          )
          return { refused, allowed }
        }).pipe(Effect.provide(layer))
      )

      expect(outcome.refused).toMatchObject({
        code: "limit_exceeded",
        message: "rewind of run would read more than 1 journal entries; raise maxHistoryEntries to allow it"
      })
      expect(outcome.allowed.archive.archived).toBe(2)
      // One claim: the refusal took none.
      expect(claims).toBe(1)
      expect(store.state().audits.map((audit) => audit.status)).toEqual(["completed"])
      expect(before.records).toHaveLength(3)
    }))
})

/**
 * The rewind rate limiter is a knob the reference and the troubleshooting page
 * tell an operator to raise, so it has to be reachable through the composition
 * rather than only through the internal operation the `exports` map blocks.
 */
describe("TimeTravel rewind rate limiter", () => {
  const journalRecord = (seq: number): MemoryTimeTravelStore.JournalRecord => ({
    runId: "run",
    seq,
    eventId: `event-${seq}`,
    lineageId: "run/root",
    payload: { eventType: "test", payload: {}, meta: { lineageId: "run/root" } }
  })

  const composed = (
    store: ReturnType<typeof MemoryTimeTravelStore.make>,
    options: Parameters<typeof layerWith>[0]
  ) => {
    const entries: ReadonlyArray<JournalEvent.Entry> = store.state().records.map((record) => ({
      runId: record.runId as JournalEvent.RunId,
      seq: record.seq as JournalEvent.Seq,
      eventId: record.eventId,
      sourceId: "options" as JournalEvent.SourceId,
      sourceSeq: record.seq as JournalEvent.SourceSeq,
      emittedAtMs: record.seq,
      eventType: "test",
      payload: {},
      meta: { lineageId: record.lineageId }
    }))
    return layerWith(options).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(TimeTravelStore)(store),
          Layer.succeed(RunStore.RunStore)(
            RunStore.makeNoop({
              get: () => Effect.succeed(row),
              claim: (_runId, _expected, _owner, nowMs) =>
                Effect.succeed({ _tag: "Claimed" as const, claimedAtMs: nowMs }),
              activate: () => Effect.succeed({ _tag: "Activated" as const }),
              transitionOwned: () => Effect.succeed({ _tag: "Transitioned" as const })
            })
          ),
          Layer.succeed(Journal.Journal)(
            Journal.makeNoop({
              entries: ({ after, limit }) =>
                Effect.sync(() => {
                  const remaining = entries.filter((entry) => entry.seq > (after ?? -1))
                  const page = remaining.slice(0, limit)
                  return { entries: page, hasMore: remaining.length > page.length }
                })
            })
          ),
          Layer.succeed(Jj.Jj)(Jj.makeNoop({ snapshot: () => Effect.succeed({ changeId: "current" }) })),
          CacheStore.layerNoop()
        )
      )
    )
  }

  it.effect("refuses `rate_limited` through the composition and records the decision", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({ records: [journalRecord(0), journalRecord(1)] })
      const asked: Array<{ readonly runId: string; readonly lineageId: string; readonly seq: number }> = []
      const layer = composed(store, {
        rateLimit: ({ frame, runId }) =>
          Effect.sync(() => {
            asked.push({ runId, lineageId: frame.lineageId, seq: frame.seq })
            return { allowed: false, detail: { reason: "quota" } }
          })
      })
      const refused = yield* Effect.scoped(
        Effect.gen(function*() {
          const timeTravel = yield* TimeTravel
          return yield* Effect.flip(timeTravel.rewind({ runId: "run", frame: { lineageId: "run/root", seq: 0 } }))
        }).pipe(Effect.provide(layer))
      )

      expect(refused).toMatchObject({ code: "rate_limited", message: "rewind rate limit exceeded for run" })
      // The limiter is asked about the position the caller named, once.
      expect(asked).toEqual([{ runId: "run", lineageId: "run/root", seq: 0 }])
      expect(store.state().audits[0]).toMatchObject({ status: "failed", rateLimit: { reason: "quota" } })
      // The refusal precedes the archive: the suffix is still there.
      expect(store.state().records).toHaveLength(2)
      expect(store.state().archived).toHaveLength(0)
    }))

  it.effect("stamps an allowing decision on the audit and truncates the suffix", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make({ records: [journalRecord(0), journalRecord(1)] })
      const checkedAt: Array<number> = []
      const layer = composed(store, {
        rateLimit: ({ nowMs }) =>
          Effect.sync(() => {
            checkedAt.push(nowMs)
            return { allowed: true }
          })
      })
      const result = yield* Effect.scoped(
        Effect.gen(function*() {
          const timeTravel = yield* TimeTravel
          return yield* timeTravel.rewind({ runId: "run", frame: { lineageId: "run/root", seq: 0 } })
        }).pipe(Effect.provide(layer))
      )

      expect(result.archive.archived).toBe(1)
      // The audit records the clock the limiter was asked on, not a second reading.
      expect(checkedAt).toHaveLength(1)
      expect(store.state().audits[0]).toMatchObject({
        status: "completed",
        rateLimit: { allowed: true, checkedAtMs: checkedAt[0] }
      })
      expect(store.state().records).toHaveLength(1)
    }))
})
