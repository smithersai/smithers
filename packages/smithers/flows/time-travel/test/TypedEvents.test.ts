import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as EngineMigrations from "@smthrs/engine-store/Migrations"
import { EngineEvent, Journal, JournalEvent, SqlJournal } from "@smthrs/journal"
import { CacheStore } from "@smthrs/step-cache"
import { Effect, Layer, Schema } from "effect"
import * as Replay from "../src/internal/Replay.ts"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import * as SqlTimeTravelStore from "../src/SqlTimeTravelStore.ts"
import { ReadOnlyTimeTravel, TimeTravel } from "../src/TimeTravel.ts"
import { TimeTravelError } from "../src/TimeTravelError.ts"

const database = Layer.provideMerge(EngineMigrations.layer, TestDatabase.layer)
const stack = SqlJournal.layer({ capacity: 16, overflow: "reject" }).pipe(
  Layer.provideMerge(database),
  Layer.merge(CacheStore.layerNoop())
)
const runId = JournalEvent.RunId.make("typed-run")
const sourceId = JournalEvent.SourceId.make("typed-engine")
const lineageId = JournalEvent.LineageId.make("typed-lineage")
const scope: EngineEvent.Consumer = {
  runId,
  lineageId,
  rootRunId: runId,
  round: 0,
  parentRunId: null,
  sources: [sourceId],
  unknown: "ignore"
}
const lineage = EngineEvent.Lineage.make({
  kind: "root",
  runId,
  lineageId,
  rootRunId: runId,
  round: 0,
  parentRunId: null
})
const frame = { lineageId, seq: 1 }
const projection: Replay.Projection<ReadonlyArray<unknown>> = {
  initial: [],
  reduce: (state, entry) => [...state, entry.payload]
}

describe("typed history admission", () => {
  it.effect("rejects inspect and replay frames past the committed SQL journal tail", () =>
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      for (let seq = 0; seq < 2; seq++) {
        yield* journal.emitDurableUnfenced({
          runId,
          sourceId,
          sourceSeq: JournalEvent.SourceSeq.make(seq),
          eventType: "test.recorded",
          payload: { seq },
          meta: { lineageId }
        })
      }
      yield* Effect.gen(function*() {
        const reader = yield* ReadOnlyTimeTravel
        for (const seq of [0, 1]) {
          const position = { runId, frame: { lineageId, seq } }
          expect(yield* reader.inspect(position, projection)).toHaveLength(seq + 1)
          expect(yield* reader.replay(position, projection, { pageSize: 1 })).toHaveLength(seq + 1)
        }
        for (const seq of [2, 999]) {
          const position = { runId, frame: { lineageId, seq } }
          expect((yield* Effect.flip(reader.inspect(position, projection))).code).toBe("not_found")
          expect((yield* Effect.flip(reader.replay(position, projection, { pageSize: 1 }))).code).toBe("not_found")
        }
      }).pipe(Effect.provide(TimeTravel.readOnly))
    }).pipe(Effect.provide(stack)))

  it.effect("decodes every v2 state family from real journal fixtures before replay", () =>
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      const fixtures = [
        { _tag: "Execution", lifecycle: { state: "running", waits: [] } },
        { _tag: "ClockScheduled", clockId: "clock", waitId: "wait", dueAtMs: 10 },
        { _tag: "DeferredCompleted", waitId: "wait", result: { _tag: "Success", value: "ready" } },
        { _tag: "Execution", lifecycle: { state: "completed", result: { _tag: "Success", value: "done" } } }
      ].map((event) => ({ version: 2, lineage, executionId: runId, event }))
      for (let index = 0; index < fixtures.length; index++) {
        yield* journal.emitDurableUnfenced(EngineEvent.stateEvent(
          Schema.decodeUnknownSync(EngineEvent.StatePayload)(fixtures[index]),
          sourceId,
          JournalEvent.SourceSeq.make(index)
        ))
      }
      expect(yield* Replay.rederive({ lineageId, seq: 3 }, projection, { runId, pageSize: 1, engineEvents: scope }))
        .toEqual(fixtures)
    }).pipe(Effect.provide(stack)))

  it.effect("replays current SQLite v2 fixtures through the public read-only service", () =>
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      const lifecycle = [
        { state: "running", startedAtMs: 5 },
        { state: "succeeded", startedAtMs: 5, finishedAtMs: 6, result: { _tag: "Success", value: { answer: 42 } } }
      ]
      const expected = lifecycle.map((state) =>
        Schema.decodeUnknownSync(EngineEvent.AttemptPayload)({
          version: 2,
          lineage,
          executionId: runId,
          stepKeyDigest: "step",
          attempt: 1,
          lifecycle: state
        })
      )
      for (let index = 0; index < expected.length; index++) {
        yield* journal.emitDurableUnfenced(
          EngineEvent.attempt(expected[index]!, sourceId, JournalEvent.SourceSeq.make(index))
        )
      }
      const actual = yield* Effect.gen(function*() {
        const reader = yield* ReadOnlyTimeTravel
        return yield* reader.replay({ runId, frame }, projection, { pageSize: 1, engineEvents: scope })
      }).pipe(Effect.provide(TimeTravel.readOnly))
      expect(actual).toEqual(expected)
      for (
        const engineEvents of [undefined, { ...scope, runId: JournalEvent.RunId.make("foreign") }, {
          ...scope,
          lineageId: JournalEvent.LineageId.make("foreign")
        }]
      ) {
        const error = yield* Effect.flip(Replay.rederive(frame, projection, { runId, engineEvents }))
        expect(error.code).toBe("invalid")
        expect(error.cause).toBeDefined()
      }
      const foreign = yield* Effect.flip(
        Replay.rederive(frame, projection, { runId, engineEvents: { ...scope, sources: [] } })
      )
      expect(foreign.cause).toMatchObject({ code: "foreign" })
    }).pipe(Effect.provide(stack)))

  for (
    const engineEvents of [undefined, { ...scope, runId: JournalEvent.RunId.make("foreign") }, {
      ...scope,
      lineageId: JournalEvent.LineageId.make("foreign")
    }]
  ) {
    it.effect(`keeps payloads out of scope refusals for ${JSON.stringify(engineEvents)}`, () =>
      Effect.gen(function*() {
        const payloadMarker = "SECRET-V2-STEP-RESULT-PAYLOAD"
        const metaMarker = "SECRET-JOURNAL-METADATA"
        const journal = yield* Journal.Journal
        yield* journal.emitDurableUnfenced({
          ...EngineEvent.attempt(
            Schema.decodeUnknownSync(EngineEvent.AttemptPayload)({
              version: 2,
              lineage,
              executionId: runId,
              stepKeyDigest: "step",
              attempt: 1,
              lifecycle: {
                state: "succeeded",
                startedAtMs: 5,
                finishedAtMs: 6,
                result: { _tag: "Success", value: { marker: payloadMarker } }
              }
            }),
            sourceId,
            JournalEvent.SourceSeq.make(0)
          ),
          meta: { lineageId, marker: metaMarker }
        })
        const entry = (yield* journal.entries({ runId, limit: 1 })).entries[0]!
        expect(JSON.stringify(entry.payload)).toContain(payloadMarker)
        expect(JSON.stringify(entry.meta)).toContain(metaMarker)
        const failure = yield* Effect.gen(function*() {
          const reader = yield* ReadOnlyTimeTravel
          return yield* Effect.flip(reader.replay({ runId, frame }, projection, { engineEvents }))
        }).pipe(Effect.provide(TimeTravel.readOnly))

        expect(failure.code).toBe("invalid")
        const encoded = JSON.stringify(Schema.encodeSync(TimeTravelError)(failure))
        expect(encoded).not.toContain(payloadMarker)
        expect(encoded).not.toContain(metaMarker)
        expect(failure.cause).toEqual({
          runId: entry.runId,
          seq: entry.seq,
          eventId: entry.eventId,
          eventType: entry.eventType,
          expected: { runId, lineageId }
        })
      }).pipe(Effect.provide(stack)))
  }

  it.effect("fails before folding malformed or unsupported known v2 events", () =>
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      yield* journal.emitDurableUnfenced({
        runId,
        sourceId,
        eventType: EngineEvent.attemptEventType,
        payload: { version: 2 }
      })
      let calls = 0
      const error = yield* Effect.flip(
        Replay.rederive(frame, { initial: 0, reduce: () => ++calls }, { runId, engineEvents: scope })
      )
      expect(error.code).toBe("invalid")
      expect(error.cause).toMatchObject({ code: "malformed" })
      expect(calls).toBe(0)
    }).pipe(Effect.provide(stack)))

  it.effect("refuses an unsupported version of the known engine namespace before folding", () =>
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      yield* journal.emitDurableUnfenced({ runId, sourceId, eventType: "flows.engine.v3.future", payload: {} })
      let calls = 0
      const failure = yield* Effect.flip(Replay.rederive(frame, { initial: 0, reduce: () => ++calls }, {
        runId,
        engineEvents: scope
      }))
      expect(failure.cause).toMatchObject({ code: "unsupported" })
      expect(calls).toBe(0)
    }).pipe(Effect.provide(stack)))

  it.effect("decodes actual current SQLite attempt markers and refuses corrupt markers in both stores", () =>
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      const current = { runId, stepKeyDigest: "step", attempt: 1, tier: "sealed" }
      yield* journal.emitDurableUnfenced({
        runId,
        sourceId,
        eventType: "flows.engine.attempt-started",
        payload: current,
        meta: { lineageId }
      })
      const page = yield* journal.entries({ runId, limit: 10 })
      expect((yield* EngineEvent.decodeCurrentAttempt(page.entries[0], scope)).marker.payload).toEqual(current)
      const sql = yield* SqlTimeTravelStore.make
      expect(yield* sql.attemptsAt(runId, frame)).toEqual([{ stepKeyDigest: "step", attempt: 1 }])
      yield* journal.emitDurableUnfenced({
        runId,
        sourceId,
        eventType: "flows.engine.attempt-started",
        payload: { stepKeyDigest: "step", attempt: -1 },
        meta: { lineageId }
      })
      const rows = yield* journal.entries({ runId, limit: 10 })
      const memory = MemoryTimeTravelStore.make({ records: rows.entries.map((entry) => ({ ...entry, lineageId })) })
      for (const store of [sql, memory]) {
        const failure = yield* Effect.flip(store.attemptsAt(runId, frame))
        expect(failure.code).toBe("invalid")
        expect(failure.cause).toBeDefined()
      }
    }).pipe(Effect.provide(stack)))
})
