import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Jj from "@smthrs/jj"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as EffectBoundary from "../src/EffectBoundary.ts"
import * as Rewind from "../src/internal/Rewind.ts"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import * as Migrations from "../src/Migrations.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"
import { makeWith, ReadOnlyTimeTravel, TimeTravel } from "../src/TimeTravel.ts"
import type { TimeTravelError } from "../src/TimeTravelError.ts"
import { TimeTravelStore } from "../src/TimeTravelStore.ts"

const entries: ReadonlyArray<JournalEvent.Entry> = [
  {
    runId: "run" as JournalEvent.RunId,
    seq: 0 as JournalEvent.Seq,
    eventId: "main-0",
    sourceId: "frame-validation" as JournalEvent.SourceId,
    sourceSeq: 0 as JournalEvent.SourceSeq,
    emittedAtMs: 0,
    eventType: "test",
    payload: { value: "main-0" },
    meta: { lineageId: "run/root" }
  },
  {
    runId: "run" as JournalEvent.RunId,
    seq: 1 as JournalEvent.Seq,
    eventId: "sibling-1",
    sourceId: "frame-validation" as JournalEvent.SourceId,
    sourceSeq: 1 as JournalEvent.SourceSeq,
    emittedAtMs: 1,
    eventType: "test",
    payload: { value: "sibling-1" },
    meta: { lineageId: "run/sibling" }
  },
  {
    runId: "run" as JournalEvent.RunId,
    seq: 2 as JournalEvent.Seq,
    eventId: "main-2",
    sourceId: "frame-validation" as JournalEvent.SourceId,
    sourceSeq: 2 as JournalEvent.SourceSeq,
    emittedAtMs: 2,
    eventType: "test",
    payload: { value: "main-2" },
    meta: { lineageId: "run/root" }
  }
]

const row = (): RunStore.RunRow => ({
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
})

const journal = Journal.makeNoop({
  entries: ({ after, limit }) =>
    Effect.sync(() => {
      const remaining = entries.filter((entry) => entry.seq > (after ?? -1))
      const page = remaining.slice(0, limit)
      return { entries: page, hasMore: remaining.length > page.length }
    })
})

const makeHarness = () => {
  const store = MemoryTimeTravelStore.make({
    records: entries.map((entry) => ({
      runId: entry.runId,
      seq: entry.seq,
      eventId: entry.eventId,
      lineageId: (entry.meta as { readonly lineageId: string }).lineageId,
      payload: { eventType: entry.eventType, payload: entry.payload, meta: entry.meta }
    }))
  })
  let claims = 0
  let workspaces = 0
  let writes = 0
  let reads = 0
  const runs = RunStore.makeNoop({
    get: () => Effect.succeed(row()),
    claim: (_runId, _expected, _owner, nowMs) =>
      Effect.sync(() => {
        claims += 1
        return { _tag: "Claimed" as const, claimedAtMs: nowMs }
      }),
    activate: () => Effect.succeed({ _tag: "Activated" as const }),
    transitionOwned: () => Effect.succeed({ _tag: "Transitioned" as const })
  })
  const dependencies = Layer.mergeAll(
    Layer.succeed(TimeTravelStore)(store),
    Layer.succeed(RunStore.RunStore)(runs),
    Layer.succeed(Journal.Journal)({
      ...journal,
      entries: (options) =>
        Effect.suspend(() => {
          reads += 1
          return journal.entries(options)
        }),
      emitDurable: (input) =>
        Effect.sync(() => {
          writes += 1
          return {
            _tag: "Accepted" as const,
            seq: 3 as JournalEvent.Seq,
            sourceSeq: input.sourceSeq ?? 0 as JournalEvent.SourceSeq
          }
        })
    }),
    Layer.succeed(Jj.Jj)(Jj.makeNoop({
      workspaceAdd: () => Effect.sync(() => void (workspaces += 1)),
      workspaceForget: () => Effect.void,
      snapshot: () => Effect.succeed({ commitId: "current", changeId: "current" })
    })),
    CacheStore.layerNoop()
  )
  const layer = TimeTravel.layer.pipe(Layer.provide(dependencies))
  const reader = TimeTravel.readOnly.pipe(Layer.provide(dependencies))
  return {
    claims: () => claims,
    layer,
    reader,
    reads: () => reads,
    store,
    workspaces: () => workspaces,
    writes: () => writes
  }
}

const malformedInputs = [
  { name: "negative seq", position: { runId: "run", frame: { lineageId: "run/root", seq: -1 } } },
  { name: "fractional seq", position: { runId: "run", frame: { lineageId: "run/root", seq: 1.5 } } },
  { name: "NaN seq", position: { runId: "run", frame: { lineageId: "run/root", seq: NaN } } },
  { name: "empty lineage", position: { runId: "run", frame: { lineageId: "", seq: 0 } } },
  { name: "empty run", position: { runId: "", frame: { lineageId: "run/root", seq: 0 } } },
  {
    name: "oversized page",
    position: { runId: "run", frame: { lineageId: "run/root", seq: 0 } },
    options: { pageSize: 20_000 }
  }
] as const

const projection = { initial: 0, reduce: (value: number) => value + 1 }

for (const mode of ["readOnly", "full"] as const) {
  for (const input of malformedInputs) {
    for (const verb of ["replay", "inspect", "fork", "rewind"] as const) {
      if (mode === "readOnly" && (verb === "fork" || verb === "rewind")) continue
      if ("options" in input && (verb === "inspect" || verb === "fork")) continue
      it.effect(`${mode}.${verb} refuses ${input.name} before reads, claims or writes`, () =>
        Effect.scoped(Effect.gen(function*() {
          const harness = makeHarness()
          const before = harness.store.state()
          const exit = yield* Effect.gen(function*() {
            const service = yield* TimeTravel
            const options = "options" in input ? input.options : undefined
            const operation: Effect.Effect<unknown, TimeTravelError> = verb === "replay" ?
              service.replay(input.position, projection, options)
              : verb === "inspect" ?
              service.inspect(input.position, projection)
              : verb === "fork" ?
              service.fork(input.position)
              : service.rewind(input.position, options)
            return yield* Effect.exit(operation)
          }).pipe(Effect.provide(
            mode === "full" ? harness.layer : Layer.effect(TimeTravel)(
              Effect.map(ReadOnlyTimeTravel, (reader) => ({
                ...reader,
                fork: () => Effect.die("readOnly has no fork"),
                rewind: () => Effect.die("readOnly has no rewind")
              }))
            ).pipe(Layer.provide(harness.reader))
          ))
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const failure = Cause.squash(exit.cause)
            expect(failure).toMatchObject({ code: "invalid" })
            if (!("options" in input)) expect(failure).toMatchObject({ cause: expect.anything() })
          }
          expect(harness.reads()).toBe(0)
          expect(harness.claims()).toBe(0)
          expect(harness.workspaces()).toBe(0)
          expect(harness.writes()).toBe(0)
          expect(harness.store.state()).toEqual(before)
        })))
    }
  }
}

it.effect("Rewind.validate refuses oversized pages before reading the journal", () =>
  Effect.gen(function*() {
    const failure = yield* Effect.flip(
      Rewind.validate({
        runId: "run",
        frame: { lineageId: "run/root", seq: 0 },
        pageSize: 20_000
      }).pipe(Effect.provideService(
        Journal.Journal,
        Journal.makeNoop({
          entries: () => Effect.die("validation must not read the journal")
        })
      ))
    )
    expect(failure.code).toBe("invalid")
  }))

for (const mode of ["readOnly", "full"] as const) {
  it.effect(`${mode} accepts the journal page-size ceiling`, () =>
    Effect.scoped(Effect.gen(function*() {
      const harness = makeHarness()
      const result = yield* Effect.gen(function*() {
        const service = yield* ReadOnlyTimeTravel
        return yield* service.replay(
          { runId: "run", frame: { lineageId: "run/root", seq: 2 } },
          projection,
          { pageSize: Journal.maxEntriesLimit }
        )
      }).pipe(Effect.provide(
        mode === "readOnly" ? harness.reader : Layer.effect(ReadOnlyTimeTravel)(TimeTravel).pipe(
          Layer.provide(harness.layer)
        )
      ))
      expect(result).toBe(2)
    })))
}

const rewind = (
  harness: ReturnType<typeof makeHarness>,
  frame: { readonly lineageId: string; readonly seq: number }
) =>
  Effect.scoped(
    Effect.gen(function*() {
      const timeTravel = yield* TimeTravel
      return yield* Effect.exit(timeTravel.rewind({ runId: "run", frame }))
    }).pipe(Effect.provide(harness.layer))
  )

describe("public TimeTravel frame validation", () => {
  it.effect.each(
    [
      ["frame zero", { lineageId: "run/root", seq: 0 }],
      ["exact lineage tail", { lineageId: "run/root", seq: 2 }]
    ] as const
  )("accepts %s", ([_name, frame]) =>
    Effect.gen(function*() {
      const harness = makeHarness()
      const exit = yield* rewind(harness, frame)

      expect(Exit.isSuccess(exit)).toBe(true)
    }))

  for (
    const [name, frame] of [
      ["tail plus one", { lineageId: "run/root", seq: 3 }],
      ["nonexistent frame", { lineageId: "run/root", seq: 99 }],
      ["sibling-lineage coordinate", { lineageId: "run/sibling", seq: 1 }],
      ["foreign-lineage coordinate", { lineageId: "run/root", seq: 1 }]
    ] as const
  ) {
    it.effect(`refuses ${name} before any durable or workspace mutation`, () =>
      Effect.gen(function*() {
        const harness = makeHarness()
        const before = harness.store.state()
        const exit = yield* rewind(harness, frame)

        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toMatchObject({ code: "not_found" })
        }
        expect(harness.claims()).toBe(0)
        expect(harness.workspaces()).toBe(0)
        expect(harness.writes()).toBe(0)
        expect(harness.store.state()).toEqual(before)
      }))
  }
})

const bareHarness = (journal: Journal.Service) => {
  const store = MemoryTimeTravelStore.make()
  let claims = 0
  const runs = RunStore.makeNoop({
    get: () => Effect.succeed(row()),
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
        Layer.succeed(Jj.Jj)(
          Jj.makeNoop({ snapshot: () => Effect.succeed({ commitId: "current", changeId: "current" }) })
        ),
        CacheStore.layerNoop()
      )
    )
  )
  const rewindTo = (frame: { readonly lineageId: string; readonly seq: number }) =>
    Effect.scoped(
      Effect.gen(function*() {
        const timeTravel = yield* TimeTravel
        return yield* Effect.exit(timeTravel.rewind({ runId: "run", frame }))
      }).pipe(Effect.provide(layer))
    )
  return { claims: () => claims, rewindTo, store }
}

const lineageFreeEntry = (seq: number): JournalEvent.Entry => ({
  runId: "run" as JournalEvent.RunId,
  seq: seq as JournalEvent.Seq,
  eventId: `bare-${seq}`,
  sourceId: "frame-validation" as JournalEvent.SourceId,
  sourceSeq: seq as JournalEvent.SourceSeq,
  emittedAtMs: seq,
  eventType: "test",
  payload: {},
  meta: {}
})

describe("public TimeTravel frame validation edges", () => {
  it.effect("accepts frame zero of an empty journal and refuses any later frame", () =>
    Effect.gen(function*() {
      const harness = bareHarness(Journal.makeNoop({
        entries: () => Effect.succeed({ entries: [], hasMore: false })
      }))

      const zero = yield* harness.rewindTo({ lineageId: "run/root", seq: 0 })
      const later = yield* harness.rewindTo({ lineageId: "run/root", seq: 5 })

      expect(Exit.isSuccess(zero)).toBe(true)
      expect(Exit.isFailure(later)).toBe(true)
      if (Exit.isFailure(later)) {
        expect(Cause.squash(later.cause)).toMatchObject({ code: "not_found" })
      }
    }))

  it.effect("treats lineage-free records as evidence compatible with every frame", () =>
    Effect.gen(function*() {
      const bare = [lineageFreeEntry(0), lineageFreeEntry(1)]
      const harness = bareHarness(Journal.makeNoop({
        entries: ({ after }) =>
          Effect.succeed({
            entries: bare.filter((entry) => entry.seq > (after ?? -1)),
            hasMore: false
          })
      }))

      expect(Exit.isSuccess(yield* harness.rewindTo({ lineageId: "run/root", seq: 1 }))).toBe(true)
    }))

  it.effect("holds the tail at the maximum coordinate across an out-of-order page", () =>
    Effect.gen(function*() {
      const outOfOrder = [
        { ...lineageFreeEntry(2), meta: { lineageId: "run/root" } },
        { ...lineageFreeEntry(0), meta: { lineageId: "run/root" } }
      ]
      const harness = bareHarness(Journal.makeNoop({
        entries: ({ after }) =>
          Effect.succeed({
            entries: outOfOrder.filter((entry) => entry.seq > (after ?? -1)),
            hasMore: false
          })
      }))

      expect(Exit.isSuccess(yield* harness.rewindTo({ lineageId: "run/root", seq: 2 }))).toBe(true)
    }))

  it.effect("terminates on a malformed empty continuation page and refuses the frame", () =>
    Effect.gen(function*() {
      let pages = 0
      const harness = bareHarness(Journal.makeNoop({
        entries: () =>
          Effect.sync(() => {
            pages += 1
            return { entries: [], hasMore: true }
          })
      }))

      const exit = yield* harness.rewindTo({ lineageId: "run/root", seq: 5 })

      expect(pages).toBe(1)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(harness.claims()).toBe(0)
    }))

  it.effect("maps a journal outage during validation to a typed unknown failure", () =>
    Effect.gen(function*() {
      const harness = bareHarness(Journal.makeNoop())

      const exit = yield* harness.rewindTo({ lineageId: "run/root", seq: 0 })

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.squash(exit.cause)).toMatchObject({
          code: "unknown",
          message: "could not validate frame run/root@0 for run"
        })
      }
      expect(harness.claims()).toBe(0)
    }))
})

const sqlLayer = () => {
  const persistence = Layer.mergeAll(
    SqlJournal.layer({ capacity: 32, overflow: "reject" }),
    RunStore.layer,
    CacheStore.layer,
    SqlTimeTravelStore.layer,
    Layer.succeed(Jj.Jj)(Jj.makeNoop({ snapshot: () => Effect.succeed({ commitId: "current", changeId: "current" }) }))
  ).pipe(
    Layer.provideMerge(Layer.provideMerge(Migrations.layer, TestDatabase.layer))
  )
  return TimeTravel.layer.pipe(Layer.provideMerge(persistence))
}

const rewindSql = (frame: { readonly lineageId: string; readonly seq: number }) =>
  Effect.scoped(
    Effect.gen(function*() {
      const sql = yield* Effect.service(SqlClient.SqlClient)
      yield* sql`
          INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
          VALUES ('run', 'suspended', 0,
                  ${JSON.stringify({ version: 1, flowName: "FrameValidation", payload: {} })})
        `
      for (const entry of entries) {
        yield* sql`
            INSERT INTO flows_journal_events
              (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
            VALUES ('run', ${entry.seq}, ${entry.eventId}, 'frame-validation', ${entry.seq},
                    ${entry.emittedAtMs}, ${entry.eventType}, ${JSON.stringify(entry.payload)},
                    ${JSON.stringify(entry.meta)})
          `
      }
      const timeTravel = yield* TimeTravel
      const exit = yield* Effect.exit(timeTravel.rewind({ runId: "run", frame }))
      const audits = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM flows_time_travel_audits
        `
      const archive = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM flows_time_travel_archive
        `
      const journalRows = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM flows_journal_events WHERE run_id = 'run'
        `
      const receipts = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM flows_time_travel_receipts
        `
      const run = yield* sql<{ readonly status: string; readonly owner_host_id: string | null }>`
          SELECT status, owner_host_id FROM flows_runs WHERE run_id = 'run'
        `
      return {
        archive: Number(archive[0]!.count),
        audits: Number(audits[0]!.count),
        exit,
        journalRows: Number(journalRows[0]!.count),
        receipts: Number(receipts[0]!.count),
        run: run[0]!
      }
    }).pipe(Effect.provide(sqlLayer()))
  )

describe("SQL public TimeTravel frame validation mirror", () => {
  it.effect.each(["restored", "persistence failure", "fence loss"] as const)(
    "preserves a pending run's irreversible refusal after %s",
    (restoration) =>
      Effect.scoped(
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const runs = yield* RunStore.RunStore
          const store = yield* TimeTravelStore
          const stateJson = JSON.stringify({ version: 1, flowName: "FrameValidation", payload: { cursor: 7 } })
          yield* sql`
            INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
            VALUES ('run', 'pending', 0, ${stateJson})
          `
          for (const seq of [0, 1]) {
            const payload = seq === 0 ? {} : {
              version: 1,
              effect: {
                id: "send",
                kind: "send",
                tier: "irreversible",
                status: "succeeded",
                runId: "run",
                lineageId: "run/root",
                idempotencyKey: "send"
              }
            }
            yield* sql`
              INSERT INTO flows_journal_events
                (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
              VALUES ('run', ${seq}, ${`event-${seq}`}, 'frame-validation', ${seq}, ${seq},
                      ${seq === 0 ? "baseline" : EffectBoundary.eventType}, ${JSON.stringify(payload)},
                      ${JSON.stringify({ lineageId: "run/root" })})
            `
          }
          const timeTravel = yield* makeWith().pipe(Effect.provideService(RunStore.RunStore, {
            ...runs,
            transitionOwned: restoration === "restored" ? runs.transitionOwned : () =>
              restoration === "fence loss"
                ? Effect.succeed({ _tag: "FenceLost" as const })
                : Effect.fail(
                  new RunStore.RunStoreError({
                    code: "persistence_failed",
                    method: "transitionOwned",
                    message: "restore unavailable",
                    cause: undefined
                  })
                )
          }))
          const failure = yield* Effect.flip(
            timeTravel.rewind({ runId: "run", frame: { lineageId: "run/root", seq: 0 } })
          )
          const row = yield* runs.get("run")
          const audits = yield* sql<{ readonly status: string; readonly detail: string }>`
            SELECT status, detail_json AS detail FROM flows_time_travel_audits WHERE run_id = 'run'
          `

          expect(failure.code).toBe("irreversible")
          expect(row.stateJson).toBe(stateJson)
          expect(audits).toHaveLength(1)
          if (restoration === "restored") {
            expect(row).toMatchObject({ status: "suspended", owner: null, heartbeatAtMs: null, claim: null })
            expect(audits[0]!.status).toBe("failed")
            expect(JSON.parse(audits[0]!.detail)).toMatchObject({ phase: "rolled_back", originalStatus: "pending" })
            expect(yield* store.pendingAudits()).toEqual([])
            const claimant = { hostId: "next-driver", pid: 42, nonce: "next-driver" }
            const claim = yield* runs.claim(
              "run",
              {
                status: row.status,
                owner: row.owner,
                heartbeatAtMs: row.heartbeatAtMs
              },
              claimant,
              yield* Clock.currentTimeMillis
            )
            expect(claim._tag).toBe("Claimed")
            if (claim._tag === "Claimed") yield* runs.abandonClaim("run", claimant, claim.claimedAtMs)
          } else {
            expect(audits[0]!.status).toBe("in_progress")
            expect(failure.cause).toMatchObject({
              restoration: restoration === "fence loss"
                ? "restore run state returned FenceLost"
                : "restore run state failed"
            })
          }
        }).pipe(Effect.provide(sqlLayer()))
      )
  )

  it.effect.each(
    [
      ["frame zero", { lineageId: "run/root", seq: 0 }],
      ["exact lineage tail", { lineageId: "run/root", seq: 2 }]
    ] as const
  )("accepts %s", ([_name, frame]) =>
    Effect.gen(function*() {
      expect(Exit.isSuccess((yield* rewindSql(frame)).exit)).toBe(true)
    }))

  for (
    const [name, frame] of [
      ["tail plus one", { lineageId: "run/root", seq: 3 }],
      ["nonexistent frame", { lineageId: "run/root", seq: 99 }],
      ["sibling-lineage coordinate", { lineageId: "run/sibling", seq: 1 }],
      ["foreign-lineage coordinate", { lineageId: "run/root", seq: 1 }]
    ] as const
  ) {
    it.effect(`refuses ${name} with no SQL mutation`, () =>
      Effect.gen(function*() {
        const result = yield* rewindSql(frame)

        expect(result.audits).toBe(0)
        expect(result.archive).toBe(0)
        expect(result.receipts).toBe(0)
        expect(result.journalRows).toBe(3)
        expect(result.run).toEqual({ status: "suspended", owner_host_id: null })
        expect(Exit.isFailure(result.exit)).toBe(true)
        if (Exit.isFailure(result.exit)) {
          expect(Cause.squash(result.exit.cause)).toMatchObject({ code: "not_found" })
        }
      }))
  }
})
