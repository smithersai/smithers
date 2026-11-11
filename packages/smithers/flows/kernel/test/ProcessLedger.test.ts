import { describe, expect, it } from "@effect/vitest"
import * as JournalModule from "@smthrs/journal/Journal"
import { Journal } from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Effect } from "effect"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as FastCheck from "fast-check"
import { effectProperty } from "../../../../repo-targets/test-utils/effect-property.mjs"
import * as ProcessLedger from "../src/ProcessLedger.ts"

const run = <A, E>(effect: Effect.Effect<A, E, Journal | Scope.Scope>) =>
  effect.pipe(Effect.provide(TestJournal.layer()), Effect.scoped)

const snapshotEventType = "flows.host.process-snapshot.v1"

/** Faulted replay pages still answer the independent snapshot lookup. */
const replayJournal = (overrides: Pick<JournalModule.Service, "entries">) =>
  JournalModule.layerNoop({
    entries: (options) =>
      options.eventTypes?.includes(snapshotEventType)
        ? Effect.succeed({ entries: [], hasMore: false })
        : overrides.entries(options)
  })

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

  it.effect("stores the spawn instant the spawner supplies instead of the time it records", () =>
    run(
      Effect.gen(function*() {
        const ledger = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 4242 })
        const spawnedAt = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
        // A supervisor that took five seconds to come up is recorded afterwards.
        yield* TestClock.adjust("5 seconds")
        const spawned = yield* ledger.record({ pid: 91, pgid: 91, commandDigest: "sleep 60", startedAtMs: spawnedAt })

        expect(spawned.startedAtMs).toBe(spawnedAt)
        const journal = yield* Journal
        const page = yield* journal.entries({ runId: ProcessLedger.hostRunId("host-a"), limit: 16 })
        expect(page.entries[0]?.payload).toMatchObject({ pid: 91, startedAtMs: spawnedAt })
      })
    ))

  it.effect("reports a dead incarnation's processes to a successor that was given the same pid", () =>
    run(
      Effect.gen(function*() {
        // A container restart hands the next host the same low pid.
        const journal = yield* Journal
        yield* journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: ProcessLedger.hostRunId("host-a"),
            sourceId: ProcessLedger.sourceId as JournalEvent.SourceId,
            eventType: ProcessLedger.SpawnedEventType,
            payload: { ...record(11, 1), incarnation: "dead" }
          })
        )
        const successor = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 1 })
        const own = yield* successor.record({ pid: 12, pgid: 12, commandDigest: "sleep 60" })

        expect(own.incarnation).toBeTypeOf("string")
        expect(own.incarnation).not.toBe("dead")
        expect((yield* successor.orphans).map((row) => row.pid)).toEqual([11])
      })
    ))

  it.effect("shares one incarnation between the ledgers of one process", () =>
    run(
      Effect.gen(function*() {
        const runtime = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 1 })
        const live = yield* runtime.record({ pid: 11, pgid: 11, commandDigest: "sleep 60" })
        const control = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 1 })
        const memory = yield* ProcessLedger.makeMemory({ hostId: "host-a", ownerPid: 1 })

        // A second ledger in the same process must not reap the first one's children.
        expect(yield* control.orphans).toEqual([])
        const other = yield* memory.record({ pid: 12, pgid: 12, commandDigest: "true" })
        expect(other.incarnation).toBe(live.incarnation)
      })
    ))

  it.effect("reports a record written before incarnations were stamped as an orphan", () =>
    Effect.gen(function*() {
      const ledger = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 1 }).pipe(
        Effect.provide(
          replayJournal({
            entries: () =>
              Effect.succeed({
                entries: [entry({ seq: 0, eventType: "flows.host.process-spawned.v1", payload: record(21, 1) })],
                hasMore: false
              })
          })
        )
      )
      expect(yield* ledger.orphans).toEqual([record(21, 1)])
    }))

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

  it.effect("restarts from a live-set snapshot instead of rereading settled process history", () =>
    run(
      Effect.gen(function*() {
        const journal = yield* Journal
        const first = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 1 })
        for (let pid = 1; pid <= 260; pid++) {
          const process = yield* first.record({ pid, pgid: pid, commandDigest: "true" })
          yield* first.release(process)
        }
        const abandoned = yield* first.record({ pid: 300, pgid: 300, commandDigest: "sleep" })
        const second = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 2 })
        expect(yield* second.orphans).toEqual([abandoned])

        const later = yield* first.record({ pid: 301, pgid: 301, commandDigest: "sleep" })
        // Telemetry on the same host run must not add replay pages.
        for (let index = 0; index < 260; index++) {
          yield* journal.emitDurableUnfenced(
            new JournalEvent.Input({
              runId: ProcessLedger.hostRunId("host-a"),
              sourceId: "telemetry" as JournalEvent.SourceId,
              eventType: "control.telemetry",
              payload: {}
            })
          )
        }
        let rowsRead = 0
        const observed = JournalModule.make({
          ...journal,
          entries: (options) =>
            journal.entries(options).pipe(Effect.tap((page) =>
              Effect.sync(() => {
                rowsRead += page.entries.length
              })
            ))
        })
        const third = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 3 }).pipe(
          Effect.provideService(Journal, observed)
        )
        expect(yield* third.orphans).toEqual([abandoned, later])
        expect(rowsRead).toBe(3) // Snapshot, new process event, and the publication check.
        yield* third.reaped(abandoned)
        yield* third.skipped(later, "identity-mismatch")
        expect(yield* third.orphans).toEqual([])
        const fourth = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 4 })
        expect(yield* fourth.orphans).toEqual([])
      })
    ))

  it.effect("bounds the first restart using periodic snapshots without an earlier replay", () =>
    run(
      Effect.gen(function*() {
        const journal = yield* Journal
        const writer = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 1 })
        for (let pid = 1; pid <= 260; pid++) {
          const process = yield* writer.record({ pid, pgid: pid, commandDigest: "true" })
          yield* writer.release(process)
        }
        const abandoned = yield* writer.record({ pid: 301, pgid: 301, commandDigest: "sleep" })
        let rowsRead = 0
        const observed = JournalModule.make({
          ...journal,
          entries: (options) =>
            journal.entries(options).pipe(Effect.tap((page) =>
              Effect.sync(() => {
                rowsRead += page.entries.length
              })
            ))
        })
        const successor = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 2 }).pipe(
          Effect.provideService(Journal, observed)
        )
        expect(yield* successor.orphans).toEqual([abandoned])
        expect(rowsRead).toBe(11) // Two snapshot lookups and nine transitions after the 512th write.
      })
    ))

  it.effect("does not publish an older cursor after a concurrent replay checkpoints newer events", () =>
    run(
      Effect.gen(function*() {
        const journal = yield* Journal
        const writer = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 1 })
        const abandoned = yield* writer.record({ pid: 401, pgid: 401, commandDigest: "sleep" })
        const newer = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 2 })
        let interleaved = false
        let later: ProcessLedger.ProcessRecord | undefined
        const concurrent = JournalModule.make({
          ...journal,
          entries: (options) =>
            journal.entries(options).pipe(Effect.tap(() =>
              Effect.gen(function*() {
                if (interleaved || options.eventTypes?.includes(snapshotEventType)) return
                interleaved = true
                for (let pid = 1; pid <= 260; pid++) {
                  const process = yield* writer.record({ pid, pgid: pid, commandDigest: "true" })
                  yield* writer.release(process)
                }
                later = yield* writer.record({ pid: 402, pgid: 402, commandDigest: "sleep" })
                expect(yield* newer.orphans.pipe(Effect.orDie)).toEqual([abandoned, later])
              })
            ))
        })
        const stale = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 3 }).pipe(
          Effect.provideService(Journal, concurrent)
        )
        expect(yield* stale.orphans).toEqual([abandoned])
        expect(interleaved).toBe(true)
        let rowsRead = 0
        const observed = JournalModule.make({
          ...journal,
          entries: (options) =>
            journal.entries(options).pipe(Effect.tap((page) =>
              Effect.sync(() => {
                rowsRead += page.entries.length
              })
            ))
        })
        const successor = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 4 }).pipe(
          Effect.provideService(Journal, observed)
        )
        expect(yield* successor.orphans).toEqual([abandoned, later])
        expect(rowsRead).toBe(1) // The delayed replay left the newest snapshot in place.
      })
    ))

  it.effect("does not skip a spawn committed between a snapshot read and write", () =>
    run(
      Effect.gen(function*() {
        const journal = yield* Journal
        const before = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 1 })
        const first = yield* before.record({ pid: 401, pgid: 401, commandDigest: "sleep" })
        let raced: ProcessLedger.ProcessRecord | undefined
        const concurrent = JournalModule.make({
          ...journal,
          emitDurableUnfenced: (input) =>
            Effect.gen(function*() {
              if (input.eventType === snapshotEventType && raced === undefined) {
                raced = yield* before.record({ pid: 402, pgid: 402, commandDigest: "sleep" })
              }
              return yield* journal.emitDurableUnfenced(input)
            })
        })
        const second = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 2 }).pipe(
          Effect.provideService(Journal, concurrent)
        )
        expect(yield* second.orphans).toEqual([first])
        const third = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 3 })
        expect(yield* third.orphans).toEqual([first, raced])
        yield* before.release(first)
        expect(yield* third.orphans).toEqual([raced])
        // A replay with no new process events does not add snapshots forever.
        const tail = yield* journal.entries({ runId: ProcessLedger.hostRunId("host-a"), limit: 100 })
        expect(yield* third.orphans).toEqual([raced])
        expect(yield* journal.entries({ runId: ProcessLedger.hostRunId("host-a"), limit: 100 })).toEqual(tail)
      })
    ))

  for (const invalid of ["producer", "payload", "cursor"] as const) {
    it.effect(`falls back to full replay for a snapshot with an invalid ${invalid}`, () =>
      run(
        Effect.gen(function*() {
          const journal = yield* Journal
          const previous = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 1 })
          const abandoned = yield* previous.record({ pid: 501, pgid: 501, commandDigest: "sleep" })
          yield* journal.emitDurableUnfenced(
            new JournalEvent.Input({
              runId: ProcessLedger.hostRunId("host-a"),
              sourceId: (invalid === "producer" ? "other" : ProcessLedger.sourceId) as JournalEvent.SourceId,
              eventType: snapshotEventType,
              payload: invalid === "payload" ? {} : { through: invalid === "cursor" ? 999 : 0, records: [] }
            })
          )
          const successor = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 2 })
          expect(yield* successor.orphans).toEqual([abandoned])
        })
      ))
  }

  it.effect("keeps replay usable when the optional snapshot write fails", () =>
    run(
      Effect.gen(function*() {
        const journal = yield* Journal
        const previous = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 1 })
        const abandoned = yield* previous.record({ pid: 601, pgid: 601, commandDigest: "sleep" })
        const faulted = JournalModule.make({
          ...journal,
          emitDurableUnfenced: (input) =>
            input.eventType === snapshotEventType
              ? JournalModule.makeNoop().emitDurableUnfenced(input)
              : journal.emitDurableUnfenced(input)
        })
        const successor = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 2 }).pipe(
          Effect.provideService(Journal, faulted)
        )
        expect(yield* successor.orphans).toEqual([abandoned])
        const next = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 3 })
        expect(yield* next.orphans).toEqual([abandoned])
      })
    ))

  it.effect("reports an unreadable event tail after reading a valid snapshot", () =>
    run(
      Effect.gen(function*() {
        const journal = yield* Journal
        const previous = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 1 })
        yield* previous.record({ pid: 701, pgid: 701, commandDigest: "sleep" })
        yield* previous.orphans
        const faulted = JournalModule.make({
          ...journal,
          entries: (options) =>
            options.eventTypes?.includes(snapshotEventType)
              ? journal.entries(options)
              : JournalModule.makeNoop().entries(options)
        })
        const successor = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 2 }).pipe(
          Effect.provideService(Journal, faulted)
        )
        expect((yield* Effect.flip(successor.orphans)).code).toBe("journal_unreadable")
      })
    ))

  it.effect("does not mistake another event type for a live-set snapshot", () =>
    Effect.gen(function*() {
      const process = record(801, 1)
      const ledger = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 2 }).pipe(
        Effect.provide(JournalModule.layerNoop({
          entries: (options) =>
            Effect.succeed({
              entries: options.eventTypes?.includes(snapshotEventType)
                ? [entry({ seq: 2, eventType: ProcessLedger.SpawnedEventType, payload: { through: 1, records: [] } })]
                : [
                  entry({ seq: 0, eventType: ProcessLedger.SpawnedEventType, payload: process }),
                  entry({ seq: 1, eventType: "unrelated", payload: process })
                ],
              hasMore: false
            })
        }))
      )
      expect(yield* ledger.orphans).toEqual([process])
    }))

  it.effect("does not fail a committed process transition when periodic snapshot reads fail", () =>
    run(
      Effect.gen(function*() {
        const journal = yield* Journal
        const faulted = JournalModule.make({ ...journal, entries: JournalModule.makeNoop().entries })
        const ledger = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 1 }).pipe(
          Effect.provideService(Journal, faulted)
        )
        for (let pid = 1; pid <= 128; pid++) {
          const process = yield* ledger.record({ pid, pgid: pid, commandDigest: "true" })
          yield* ledger.release(process)
        }
        const abandoned = yield* ledger.record({ pid: 802, pgid: 802, commandDigest: "sleep" })
        const successor = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 2 })
        expect(yield* successor.orphans).toEqual([abandoned])
      })
    ))

  it.effect("bootstraps legacy histories with a linear sequence scan on every page", () =>
    run(
      Effect.gen(function*() {
        const journal = yield* Journal
        for (let pid = 1; pid <= 260; pid++) {
          for (const eventType of [ProcessLedger.SpawnedEventType, ProcessLedger.ExitedEventType]) {
            yield* journal.emitDurableUnfenced(
              new JournalEvent.Input({
                runId: ProcessLedger.hostRunId("host-a"),
                sourceId: ProcessLedger.sourceId as JournalEvent.SourceId,
                eventType,
                payload: record(pid, 1)
              })
            )
          }
        }
        const abandoned = record(900, 1)
        yield* journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: ProcessLedger.hostRunId("host-a"),
            sourceId: ProcessLedger.sourceId as JournalEvent.SourceId,
            eventType: ProcessLedger.SpawnedEventType,
            payload: abandoned
          })
        )
        let bootstrap = true
        let pages = 0
        const observed = JournalModule.make({
          ...journal,
          entries: (options) =>
            Effect.gen(function*() {
              if (!options.eventTypes?.includes(snapshotEventType)) {
                pages += 1
                if (bootstrap) expect(options.eventTypes).toBeUndefined()
                else {expect(options.eventTypes).toEqual([
                    ProcessLedger.SpawnedEventType,
                    ProcessLedger.ExitedEventType,
                    ProcessLedger.ReapedEventType,
                    ProcessLedger.SkippedEventType
                  ])}
              }
              return yield* journal.entries(options)
            })
        })
        const successor = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 2 }).pipe(
          Effect.provideService(Journal, observed)
        )
        expect(yield* successor.orphans).toEqual([abandoned])
        expect(pages).toBe(3)
        bootstrap = false
        pages = 0
        expect(yield* successor.orphans).toEqual([abandoned])
        expect(pages).toBe(1)
      })
    ))

  effectProperty(it.effect)(
    "preserves generated process identities and retirements across repeated snapshots",
    [FastCheck.array(
      FastCheck.tuple(
        FastCheck.constantFrom("record", "release", "reaped", "skipped"),
        FastCheck.nat({ max: 4 })
      ),
      { maxLength: 30 }
    )],
    ([operations]) =>
      run(Effect.gen(function*() {
        const writer = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 1 })
        const reader = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 2 })
        const history: Array<ProcessLedger.ProcessRecord> = []
        const live = new Map<number, ProcessLedger.ProcessRecord>()
        for (const [index, [operation, choice]] of operations.entries()) {
          if (operation === "record") {
            const process = yield* writer.record({
              pid: choice + 1,
              pgid: choice + 1,
              commandDigest: "sleep",
              startedAtMs: index
            })
            history.push(process)
            live.set(process.startedAtMs, process)
          } else if (history.length > 0) {
            const process = history[choice % history.length]!
            yield* writer[operation](process, "identity-mismatch")
            live.delete(process.startedAtMs)
          }
          expect(yield* reader.orphans).toEqual([...live.values()])
        }
        expect(yield* reader.orphans).toEqual([...live.values()])
      })),
    { fastCheck: { numRuns: 30 } }
  )

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
          replayJournal({
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
        Effect.provide(replayJournal({ entries: () => Effect.succeed(stuck) }))
      )
      // A history that was not read to its end is not the history: a record
      // past the stall could retire pid 41 or name another abandoned child.
      const failure = yield* Effect.flip(ledger.orphans)
      expect(failure._tag).toBe("@smthrs/kernel/ProcessLedgerReplayError")
      expect(failure.code).toBe("cursor_stalled")
    }))

  it.effect("refuses a history whose journal returns an empty page that reports more", () =>
    Effect.gen(function*() {
      let call = 0
      const pages = [
        {
          entries: [entry({ seq: 0, eventType: "flows.host.process-spawned.v1", payload: record(51, 1) })],
          hasMore: true
        },
        { entries: [], hasMore: true }
      ]
      const ledger = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 2 }).pipe(
        Effect.provide(
          replayJournal({
            entries: () =>
              Effect.sync(() => {
                const page = pages[call] ?? { entries: [], hasMore: false }
                call += 1
                return page
              })
          })
        )
      )
      // The page past seq 0 may hold the exit of pid 51; without it, 51 would
      // be reported abandoned and a reaper could signal a reused pid.
      const failure = yield* Effect.flip(ledger.orphans)
      expect(failure.code).toBe("cursor_stalled")
      expect(failure.message).toContain("returned an empty page after seq 0")
    }))

  it.effect("refuses a history whose first page is empty but reports more", () =>
    Effect.gen(function*() {
      const ledger = yield* ProcessLedger.make({ hostId: "host-a", ownerPid: 2 }).pipe(
        Effect.provide(replayJournal({ entries: () => Effect.succeed({ entries: [], hasMore: true }) }))
      )
      const failure = yield* Effect.flip(ledger.orphans)
      expect(failure.code).toBe("cursor_stalled")
      expect(failure.message).toContain("returned an empty page at the start")
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
        const page = yield* journal.entries({
          runId: ProcessLedger.hostRunId("host-skip"),
          eventTypes: [ProcessLedger.SpawnedEventType, ProcessLedger.SkippedEventType],
          limit: 16
        })
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
