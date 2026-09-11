import { describe, expect, it } from "@effect/vitest"
import { JournalEvent } from "@smthrs/journal"
import { Data, Deferred, Effect, Fiber, Schema, Stream } from "effect"
import { expectTypeOf } from "vitest"
import * as SyncClient from "../src/SyncClient.ts"
import { SyncError, type SyncGapError } from "../src/SyncError.ts"
import * as Protocol from "../src/SyncProtocol.ts"
import * as TestEntry from "./fixtures/entry.ts"

const runId = "application-progress" as JournalEvent.RunId
const scope = { _tag: "Run", runId } as const
const entries = [0, 1].map((seq) =>
  TestEntry.entry(runId, seq, { eventId: `event-${seq}`, emittedAtMs: 0, eventType: "increment", payload: seq + 1 })
)
const make = () =>
  SyncClient.make({
    client: {
      "Sync.Read": (request: Protocol.ReadRequest) =>
        Effect.succeed({
          entries: entries.filter((entry) => entry.seq > (request.cursors[0]?.afterSeq ?? -1)),
          cursors: [{ generation: 0, runId, afterSeq: 1 as JournalEvent.Seq }],
          done: true
        }),
      "Sync.Subscribe": () => Stream.never
    } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
  })
const cursor = (afterSeq: number) => [{ generation: 0, runId, afterSeq }]

/** A consumer's own transaction failure, owned by the consumer rather than the wire vocabulary. */
class RolledBack extends Data.TaggedError("RolledBack")<{ readonly seq: number }> {}

describe("distinct delivered and applied progress", () => {
  it.effect("does not acknowledge delivery-only data or skip it for a later applying subscription", () =>
    Effect.gen(function*() {
      const client = yield* make()
      yield* client.subscribe({ scope, cursors: [] }).pipe(Stream.take(2), Stream.runDrain)
      expect(yield* client.progress).toEqual({ delivered: cursor(1), applied: [] })
      let total = 0
      yield* client.subscribe({
        scope,
        cursors: [],
        apply: (entry) =>
          Effect.sync(() => {
            total += Number(entry.payload)
          })
      })
        .pipe(Stream.take(2), Stream.runDrain)
      expect(total).toBe(3)
      expect((yield* client.progress).applied).toEqual(cursor(1))
      expect(yield* SyncClient.makeNoop().progress).toEqual({ delivered: [], applied: [] })
    }))

  it.effect("reports progress as the schema's two cursor sets, the service's one position accessor", () =>
    Effect.gen(function*() {
      const client = yield* make()
      yield* client.subscribe({ scope, cursors: [] }).pipe(Stream.take(1), Stream.runDrain)
      const progress = yield* client.progress
      expect(Schema.decodeUnknownSync(Protocol.Progress)(progress)).toEqual({ delivered: cursor(0), applied: [] })
      expect(Object.keys(client).sort()).toEqual(["progress", "snapshot", "subscribe"])
      expect(Object.keys(SyncClient.makeNoop()).sort()).toEqual(["progress", "snapshot", "subscribe"])
    }))

  it.effect("keeps the failed entry unapplied and fails with the consumer's own error", () =>
    Effect.gen(function*() {
      const client = yield* make()
      const error = new RolledBack({ seq: 1 })
      const applied: Array<number> = []
      const failing = client.subscribe({
        scope,
        cursors: [],
        apply: (entry) =>
          entry.seq === 1
            ? Effect.fail(error) :
            Effect.sync(() => {
              applied.push(entry.seq)
            })
      })
      expectTypeOf(failing).toEqualTypeOf<Stream.Stream<JournalEvent.Entry, SyncError | SyncGapError | RolledBack>>()
      const failure = yield* Effect.flip(Stream.runDrain(failing))
      expect(failure).toBe(error)
      expect(SyncError.is(failure)).toBe(false)
      expect((yield* client.progress).applied).toEqual(cursor(0))
      yield* client.subscribe({
        scope,
        cursors: [],
        apply: (entry) =>
          Effect.sync(() => {
            applied.push(entry.seq)
          })
      })
        .pipe(Stream.take(1), Stream.runDrain)
      expect(applied).toEqual([0, 1])
      expect((yield* client.progress).applied).toEqual(cursor(1))
    }))

  it.effect("types a subscription without callbacks with the sync failures alone", () =>
    Effect.gen(function*() {
      const client = yield* make()
      expectTypeOf(client.subscribe({ scope, cursors: [] })).toEqualTypeOf<
        Stream.Stream<JournalEvent.Entry, SyncError | SyncGapError>
      >()
    }))

  it.effect("does not acknowledge an interrupted application", () =>
    Effect.gen(function*() {
      const client = yield* make()
      const entered = yield* Deferred.make<void>()
      const fiber = yield* client.subscribe({
        scope,
        cursors: [],
        apply: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
      }).pipe(Stream.runDrain, Effect.forkChild)
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(fiber)
      expect(yield* client.progress).toEqual({ delivered: [], applied: [] })
    }))
})
