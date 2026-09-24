import { describe, expect, it } from "@effect/vitest"
import * as JournalModule from "@smthrs/journal/Journal"
import { Journal } from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Effect } from "effect"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as ProcessLedger from "../src/ProcessLedger.ts"

const run = <A, E>(effect: Effect.Effect<A, E, Journal | Scope.Scope>) =>
  effect.pipe(Effect.provide(TestJournal.layer()), Effect.scoped)

const seq = (value: number): JournalEvent.Seq => value as JournalEvent.Seq

/** One committed row, as the journal would return it from `entries`. */
const entry = (options: {
  readonly seq: number
  readonly eventType: string
  readonly payload: unknown
  readonly sourceId?: string
}): JournalEvent.Entry =>
  new JournalEvent.Entry({
    runId: ProcessLedger.hostRunId("host-a"),
    seq: seq(options.seq),
    eventId: `event-${options.seq}`,
    sourceId: (options.sourceId ?? ProcessLedger.sourceId) as JournalEvent.SourceId,
    sourceSeq: seq(options.seq) as unknown as JournalEvent.SourceSeq,
    emittedAtMs: 0,
    eventType: options.eventType,
    payload: options.payload,
    meta: {}
  })

const record = (pid: number, ownerPid: number) => ({
  pid,
  pgid: pid,
  hostId: "host-a",
  ownerPid,
  startedAtMs: 0,
  commandDigest: `sleep ${pid}`
})

describe("ProcessLedger", () => {
  it.effect("journals a spawned process on the host's own run and lists it live", () =>
    run(
      Effect.gen(function*() {
        const ledger = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 4242 })
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
        const spawned = yield* ledger.record({ pid: 91, pgid: 91, commandDigest: "sleep 60" })

        expect(spawned.hostId).toBe("host-a")
        expect(spawned.ownerPid).toBe(4242)
        expect(spawned.startedAtMs).toBe(now)
        expect(yield* ledger.live).toEqual([spawned])

        yield* TestClock.adjust("5 seconds")
        const later = yield* ledger.record({ pid: 92, pgid: 92, commandDigest: "sleep 60" })
        expect(later.startedAtMs).toBe(now + 5_000)

        const journal = yield* Journal
        const page = yield* journal.entries({ runId: ProcessLedger.hostRunId("host-a"), limit: 16 })
        expect(page.entries.map((row) => row.eventType)).toEqual([
          "flows.host.process-spawned.v1",
          "flows.host.process-spawned.v1"
        ])
        expect(page.entries[0]?.payload).toMatchObject({ pid: 91, pgid: 91, commandDigest: "sleep 60" })
        expect(page.entries.map((row) => row.payload)).toEqual([spawned, later])
      })
    ))

  it.effect("drops a released process from the live set and journals its exit", () =>
    run(
      Effect.gen(function*() {
        const ledger = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 1 })
        const spawned = yield* ledger.record({ pid: 7, pgid: null, commandDigest: "true" })
        yield* ledger.release(spawned)

        expect(yield* ledger.live).toEqual([])
        const journal = yield* Journal
        const page = yield* journal.entries({ runId: ProcessLedger.hostRunId("host-a"), limit: 16 })
        expect(page.entries.map((row) => row.eventType)).toEqual([
          "flows.host.process-spawned.v1",
          "flows.host.process-exited.v1"
        ])
      })
    ))

  it.effect("reports the live processes of a previous incarnation as orphans", () =>
    run(
      Effect.gen(function*() {
        const first = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 100 })
        const stale = yield* first.record({ pid: 11, pgid: 11, commandDigest: "sleep 60" })
        const settled = yield* first.record({ pid: 12, pgid: 12, commandDigest: "sleep 1" })
        yield* first.release(settled)

        const second = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 200 })
        yield* second.record({ pid: 13, pgid: 13, commandDigest: "sleep 60" })

        // The dead incarnation's unreleased process, and only that one: a
        // released process is finished and this incarnation's own is alive.
        expect((yield* second.orphans).map((row) => row.pid)).toEqual([11])

        // A different host owns a different journal run and sees nothing.
        const elsewhere = yield* ProcessLedger.make({ hostId: "host-b", ownerPid: 300 })
        expect(yield* elsewhere.orphans).toEqual([])

        // Reaping retires the record, and the next incarnation inherits only
        // what the second one left running.
        yield* second.reaped(stale)
        const third = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 300 })
        expect((yield* third.orphans).map((row) => row.pid)).toEqual([13])
      })
    ))

  it.effect("keeps a reused pid live when an older process is released again", () =>
    Effect.gen(function*() {
      const ledger = yield* ProcessLedger.makeMemory({ hostId: "host-a", ownerPid: 100 })
      const first = yield* ledger.record({ pid: 11, pgid: 11, commandDigest: "sleep" })
      yield* TestClock.adjust("5 seconds")
      const second = yield* ledger.record({ pid: 11, pgid: 11, commandDigest: "sleep" })

      yield* ledger.release(first)
      expect(yield* ledger.live).toEqual([second])
      yield* ledger.release(first)
      expect(yield* ledger.live).toEqual([second])
      yield* ledger.release(second)
      expect(yield* ledger.live).toEqual([])
    }))

  for (const retirement of ["release", "reaped", "skipped"] as const) {
    it.effect(`keeps a reused pid orphaned after a delayed ${retirement} of its predecessor`, () =>
      run(
        Effect.gen(function*() {
          const ledger = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 100 })
          const first = yield* ledger.record({ pid: 11, pgid: 11, commandDigest: "sleep" })
          yield* TestClock.adjust("5 seconds")
          const second = yield* ledger.record({ pid: 11, pgid: 11, commandDigest: "sleep" })
          yield* ledger[retirement](first, "identity-mismatch")

          const next = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 200 })
          expect(yield* next.orphans).toEqual([second])
          if (retirement === "release") expect(yield* ledger.live).toEqual([second])
          yield* next.reaped(second)
          expect(yield* next.orphans).toEqual([])
        })
      ))
  }

  it.effect("ignores journal entries written by another producer or about another subject", () =>
    run(
      Effect.gen(function*() {
        const journal = yield* Journal
        const emit = (input: {
          readonly eventType: string
          readonly payload: unknown
          readonly sourceId?: string
        }) =>
          journal.emitDurableUnfenced(
            new JournalEvent.Input({
              runId: ProcessLedger.hostRunId("host-a"),
              sourceId: (input.sourceId ?? ProcessLedger.sourceId) as JournalEvent.SourceId,
              eventType: input.eventType,
              payload: input.payload
            })
          )

        // A forged record from a producer that is not the ledger.
        yield* emit({ eventType: "flows.host.process-spawned.v1", payload: record(21, 1), sourceId: "someone-else" })
        // The ledger's own producer, but a payload that is not a record.
        yield* emit({ eventType: "flows.host.process-spawned.v1", payload: { pid: "not a number" } })
        // A well-formed record under an event type the ledger does not know.
        yield* emit({ eventType: "flows.host.process-adopted.v1", payload: record(23, 1) })

        const ledger = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 9 })
        expect(yield* ledger.orphans).toEqual([])
      })
    ))

  it.effect("reads every page of a long ledger history", () =>
    Effect.gen(function*() {
      let call = 0
      const pages = [
        {
          entries: [entry({ seq: 0, eventType: "flows.host.process-spawned.v1", payload: record(31, 1) })],
          hasMore: true
        },
        {
          entries: [entry({ seq: 1, eventType: "flows.host.process-spawned.v1", payload: record(32, 1) })],
          hasMore: false
        }
      ]
      const ledger = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 2 }).pipe(
        Effect.provide(
          JournalModule.layerNoop({
            entries: () =>
              Effect.sync(() => {
                const page = pages[call] ?? { entries: [], hasMore: false }
                call += 1
                return page
              })
          })
        )
      )
      expect((yield* ledger.orphans).map((row) => row.pid)).toEqual([31, 32])
      expect(call).toBe(2)
    }))

  it.effect("refuses a history whose journal cursor stops advancing", () =>
    Effect.gen(function*() {
      const stuck = {
        entries: [entry({ seq: 0, eventType: "flows.host.process-spawned.v1", payload: record(41, 1) })],
        hasMore: true
      }
      const ledger = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 2 }).pipe(
        Effect.provide(JournalModule.layerNoop({ entries: () => Effect.succeed(stuck) }))
      )
      // A history that was not read to its end is not the history: a record
      // past the stall could retire pid 41 or name another abandoned child.
      const failure = yield* Effect.flip(ledger.orphans)
      expect(failure._tag).toBe("@smthrs/kernel/ProcessLedgerReplayError")
      expect(failure.code).toBe("cursor_stalled")
    }))

  it.effect("REPORTS every refused write instead of pretending it committed", () =>
    Effect.gen(function*() {
      const ledger = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 1 })

      // A spawn whose record did not commit is a child no later incarnation
      // can find. Swallowing that is the failure mode this ledger exists to
      // remove, so every durable write reports what happened to it.
      const spawned = yield* Effect.flip(ledger.record({ pid: 5, pgid: null, commandDigest: "sleep 60" }))
      expect(spawned._tag).toBe("@smthrs/journal/JournalError")

      const held = {
        pid: 5,
        pgid: null,
        hostId: "host-a",
        ownerPid: 1,
        startedAtMs: 0,
        commandDigest: "sleep 60"
      } as const
      // The caller is told the spawn was not recorded and kills the child, so
      // the ledger must not retain a process this incarnation does not hold.
      expect(yield* ledger.live).toEqual([])
      expect((yield* Effect.flip(ledger.reaped(held)))._tag).toBe("@smthrs/journal/JournalError")
      expect((yield* Effect.flip(ledger.skipped(held, "pre-boot")))._tag).toBe("@smthrs/journal/JournalError")
      expect((yield* Effect.flip(ledger.release(held)))._tag).toBe("@smthrs/journal/JournalError")
      expect(yield* ledger.live).toEqual([])
      // The history cannot be read either. An unreadable history is not an
      // empty one: the ledger says so instead of claiming nothing was left.
      const replay = yield* Effect.flip(ledger.orphans)
      expect(replay._tag).toBe("@smthrs/kernel/ProcessLedgerReplayError")
      expect(replay.code).toBe("journal_unreadable")
    }).pipe(Effect.provide(JournalModule.layerNoop())))

  it.effect("retires a skipped record and says in the journal that nothing was signalled", () =>
    run(
      Effect.gen(function*() {
        const previous = yield* ProcessLedger.make({ hostId: "host-skip", ownerPid: 100 })
        const stale = yield* previous.record({ pid: 61, pgid: 61, commandDigest: "sleep 60" })

        const current = yield* ProcessLedger.make({ hostId: "host-skip", ownerPid: 200 })
        expect((yield* current.orphans).map((row) => row.pid)).toEqual([61])
        yield* current.skipped(stale, "identity-mismatch")

        // Retired without a kill: a later incarnation inherits nothing, and the
        // journal distinguishes the two outcomes.
        const third = yield* ProcessLedger.make({ hostId: "host-skip", ownerPid: 300 })
        expect(yield* third.orphans).toEqual([])
        const journal = yield* Journal
        const page = yield* journal.entries({ runId: ProcessLedger.hostRunId("host-skip"), limit: 16 })
        expect(page.entries.map((row) => row.eventType)).toEqual([
          "flows.host.process-spawned.v1",
          "flows.host.process-reap-skipped.v1"
        ])
        expect(page.entries[1]?.payload).toMatchObject({ pid: 61, reason: "identity-mismatch" })
      })
    ))

  it.effect("provides a journal-backed ledger as a layer", () =>
    run(
      Effect.gen(function*() {
        const ledger = yield* ProcessLedger.ProcessLedger.pipe(
          Effect.provide(ProcessLedger.layer({ hostId: "host-layer", ownerPid: 77 }))
        )
        const spawned = yield* ledger.record({ pid: 51, pgid: 51, commandDigest: "sleep 60" })
        expect(spawned.hostId).toBe("host-layer")

        const journal = yield* Journal
        const page = yield* journal.entries({ runId: ProcessLedger.hostRunId("host-layer"), limit: 16 })
        expect(page.entries.map((row) => row.eventType)).toEqual(["flows.host.process-spawned.v1"])
      })
    ))

  it.effect("provides a journal-free ledger as a layer", () =>
    run(
      Effect.gen(function*() {
        const ledger = yield* ProcessLedger.ProcessLedger.pipe(
          Effect.provide(ProcessLedger.layerMemory({ hostId: "host-memory", ownerPid: 78 }))
        )
        yield* ledger.record({ pid: 52, pgid: null, commandDigest: "sleep 60" })
        expect((yield* ledger.live).map((row) => row.pid)).toEqual([52])

        // Nothing reached the journal the layer was built beside.
        const journal = yield* Journal
        const page = yield* journal.entries({ runId: ProcessLedger.hostRunId("host-memory"), limit: 16 })
        expect(page.entries).toEqual([])
      })
    ))

  it.effect("tracks processes without a journal at all", () =>
    Effect.gen(function*() {
      const ledger = yield* ProcessLedger.makeMemory({ hostId: "host-a", ownerPid: 1 })
      const spawned = yield* ledger.record({ pid: 5, pgid: 5, commandDigest: "sleep 60" })
      expect(yield* ledger.live).toEqual([spawned])
      // Nothing durable was written, so nothing can be inherited.
      expect(yield* ledger.orphans).toEqual([])
      yield* ledger.reaped(spawned)
      yield* ledger.skipped(spawned, "pre-boot")
      yield* ledger.release(spawned)
      expect(yield* ledger.live).toEqual([])
    }))
})
