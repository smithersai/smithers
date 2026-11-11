import { describe, expect, it } from "@effect/vitest"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { FlowEngine } from "@smthrs/engine"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/sql/SqlClient"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Replay from "../src/internal/Replay.vibe"
import * as Migrations from "../src/Migrations.vibe"
import { TimeTravel } from "../src/TimeTravel.ts"
import { jjInstalled, parkSealedFlow, runRealEngine, withRealFixture } from "./RealTimeTravelHarness.ts"

const services = (filename: string) => {
  const database = Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
  const migrated = Layer.provideMerge(Migrations.layer, database)
  return Layer.mergeAll(
    SqlJournal.layer({ capacity: 32, overflow: "reject" }),
    CacheStore.layer
  ).pipe(Layer.provideMerge(migrated))
}

const projection = {
  initial: [] as Array<string>,
  reduce: (state: Array<string>, entry: JournalEvent.Entry, sealed: unknown | undefined) => [
    ...state,
    `${entry.seq}:${String((entry.payload as { readonly value: string }).value)}:${String(sealed)}`
  ]
}

/**
 * The engine-driven run's root lineage, taken from the constructor that mints it.
 *
 * Re-derived on 2026-09-01. `FlowEngine.Lineage` moved the root address from
 * `<runId>/root` to a versioned encoded tuple, so the old literal addressed a
 * lineage the engine no longer writes. The hand-seeded rows below keep their
 * own opaque `"run/root"` because nothing but this file produces or reads them.
 */
const engineLineage = FlowEngine.Lineage.root("replay-engine-run")

const replay = Replay.rederive(
  { lineageId: "run/root", seq: 5 },
  projection,
  { runId: "run", pageSize: 2 }
)

const seed = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const cache = yield* CacheStore.CacheStore
  for (
    const [seq, value, cacheKey] of [
      [0, "zero", undefined],
      [2, "two", "sealed-key"],
      [5, "five", undefined]
    ] as const
  ) {
    yield* sql`
      INSERT INTO flows_journal_events
        (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)
      VALUES ('run', ${seq}, ${`event-${seq}`}, 'replay', ${seq}, ${seq}, 'projection',
              ${JSON.stringify({ value })},
              ${JSON.stringify({ lineageId: "run/root", ...(cacheKey === undefined ? {} : { cacheKey }) })})
    `
  }
  yield* cache.put({
    keyDigest: "sealed-key",
    result: "sealed-v1",
    meta: {},
    createdAtMs: 0,
    recordedRunId: "run",
    recordedEventSeq: 2
  })
})

describe("durable replay", () => {
  it.effect("replays gaps and an exact-tail frame identically across two file-backed layer lifetimes", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-replay-durability-")))
      const filename = join(directory, "journal.sqlite")
      try {
        const first = yield* (
          Effect.scoped(seed.pipe(Effect.andThen(replay), Effect.provide(services(filename))))
        )
        const second = yield* (
          Effect.scoped(replay.pipe(Effect.provide(services(filename))))
        )

        expect(first).toEqual([
          "0:zero:undefined",
          "2:two:sealed-v1",
          "5:five:undefined"
        ])
        expect(second).toEqual(first)
      } finally {
        yield* Effect.promise(() => rm(directory, { recursive: true, force: true }))
      }
    }))

  // The finite budget covers a real engine replay and two independent file-backed service lifetimes.
  it.effect.skipIf(!jjInstalled)(
    "replays a registered sealed action after restart without dispatching it again",
    () =>
      Effect.gen(function*() {
        yield* withRealFixture("flows-replay-engine-", (fixture) =>
          Effect.gen(function*() {
            let dispatches = 0
            const execute = Effect.sync(() => {
              dispatches += 1
              return "recorded-result"
            })
            const fold = {
              initial: [] as Array<string>,
              reduce: (state: Array<string>, entry: JournalEvent.Entry) => [
                ...state,
                `${entry.seq}:${entry.eventType}`
              ]
            }
            const first = yield* runRealEngine(
              fixture.databaseFile,
              "replay-engine-first",
              Effect.gen(function*() {
                yield* parkSealedFlow("replay-engine-run", execute)
                const journal = yield* Journal.Journal
                yield* journal.flush
                const sql = yield* Effect.service(SqlClient.SqlClient)
                const rows = yield* sql<{ readonly tail: number }>`
              SELECT MAX(seq) AS tail FROM flows_journal_events WHERE run_id = 'replay-engine-run'
            `
                const tail = rows[0]!.tail
                const timeTravel = yield* TimeTravel
                const state = yield* timeTravel.inspect(
                  { runId: "replay-engine-run", frame: { lineageId: engineLineage, seq: tail } },
                  fold
                )
                return { state, tail }
              })
            )
            const second = yield* runRealEngine(
              fixture.databaseFile,
              "replay-engine-second",
              Effect.gen(function*() {
                // This drives the persisted run through the same registered
                // implementation. The cache/attempt evidence, not this closure,
                // must answer the action after restart.
                yield* parkSealedFlow("replay-engine-run", execute)
                const journal = yield* Journal.Journal
                yield* journal.flush
                const timeTravel = yield* TimeTravel
                return yield* timeTravel.inspect(
                  {
                    runId: "replay-engine-run",
                    frame: { lineageId: engineLineage, seq: first.tail }
                  },
                  fold
                )
              })
            )

            expect(second).toEqual(first.state)
            expect(dispatches).toBe(1)
          }))
      }),
    { timeout: 30_000 }
  )

  it.effect("keeps the projection stable when cache contents mutate between lifetimes", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-replay-cache-mutation-")))
      const filename = join(directory, "journal.sqlite")
      try {
        const first = yield* (
          Effect.scoped(seed.pipe(Effect.andThen(replay), Effect.provide(services(filename))))
        )
        const second = yield* (
          Effect.scoped(
            Effect.gen(function*() {
              const cache = yield* CacheStore.CacheStore
              yield* cache.evict("sealed-key")
              yield* cache.put({
                keyDigest: "sealed-key",
                result: "sealed-v2",
                meta: {},
                createdAtMs: 10,
                recordedRunId: "other",
                recordedEventSeq: 9
              })
              return yield* replay
            }).pipe(Effect.provide(services(filename)))
          )
        )

        expect(second).toEqual(first)
      } finally {
        yield* Effect.promise(() => rm(directory, { recursive: true, force: true }))
      }
    }))

  it.effect("normalizes duplicate and out-of-order pages to the durable projection", () =>
    Effect.gen(function*() {
      const directory = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "flows-replay-pages-")))
      const filename = join(directory, "journal.sqlite")
      try {
        const result = yield* (
          Effect.scoped(
            Effect.gen(function*() {
              yield* seed
              const real = yield* Journal.Journal
              const page = yield* real.entries({ runId: "run" as JournalEvent.RunId, limit: 10 })
              const malformed = Journal.makeNoop({
                entries: () =>
                  Effect.succeed({
                    entries: [page.entries[2]!, page.entries[0]!, page.entries[2]!, page.entries[1]!],
                    hasMore: false
                  })
              })
              return yield* replay.pipe(Effect.provideService(Journal.Journal, malformed))
            }).pipe(Effect.provide(services(filename)))
          )
        )

        expect(result).toEqual([
          "0:zero:undefined",
          "2:two:sealed-v1",
          "5:five:undefined"
        ])
      } finally {
        yield* Effect.promise(() => rm(directory, { recursive: true, force: true }))
      }
    }))
})
