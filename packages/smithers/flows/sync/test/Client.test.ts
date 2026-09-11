/**
 * End-to-end coverage for the browser-safe RPC sync client.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Effect, Fiber, type Scope, Stream } from "effect"
import * as SyncClient from "../src/SyncClient.ts"
import * as SyncRpcs from "../src/SyncRpcs.ts"
import * as SyncServer from "../src/SyncServer.ts"
import * as TestSocket from "../src/test/TestSocket.ts"
import * as TestSync from "../src/test/TestSync.ts"

const runId = (value: string) => value as JournalEvent.RunId
const sourceId = (value: string) => value as JournalEvent.SourceId
const seq = (value: number) => value as JournalEvent.Seq
const sourceSeq = (value: number) => value as JournalEvent.SourceSeq

const entry = (id: string, sequence: number) =>
  new JournalEvent.Entry({
    runId: runId(id),
    seq: seq(sequence),
    eventId: `${id}-${sequence}`,
    sourceId: sourceId("source"),
    sourceSeq: sourceSeq(sequence),
    emittedAtMs: sequence,
    eventType: "event",
    payload: sequence,
    meta: null
  })

const program = <A, E>(
  effect: Effect.Effect<A, E, Journal.Journal | Scope.Scope | SyncRpcs.SyncAuth | SyncServer.SyncServer>
) =>
  effect.pipe(
    Effect.provide(TestSync.layerTest),
    Effect.scoped
  )

describe("SyncClient", () => {
  it.effect("bootstraps durable entries and follows live entries over the socket pair", () =>
    Effect.gen(function*() {
      const entries = yield* program(
        Effect.gen(function*() {
          const journal = yield* Journal.Journal
          const pair = yield* TestSocket.makePair()
          const client = yield* TestSync.connect(pair)
          const id = runId("client-round-trip")

          yield* journal.emitDurableUnfenced({
            runId: id,
            sourceId: sourceId("source"),
            eventType: "before",
            payload: { value: 1 }
          })
          yield* journal.flush

          const fiber = yield* Stream.runCollect(
            client.subscribe({ scope: { _tag: "Run", runId: id }, cursors: [] }).pipe(Stream.take(2))
          ).pipe(Effect.forkChild({ startImmediately: true }))

          yield* journal.emitDurableUnfenced({
            runId: id,
            sourceId: sourceId("source"),
            eventType: "after",
            payload: { value: 2 }
          })
          yield* journal.flush
          return yield* Fiber.join(fiber)
        })
      )

      expect(Array.from(entries).map((entry) => entry.eventType)).toEqual(["before", "after"])
    }))

  it.effect("advances a bootstrap cursor only after each entry is consumed", () =>
    Effect.gen(function*() {
      const id = runId("partial-page")
      const client = yield* SyncClient.make({
        client: {
          "Sync.Read": () =>
            Effect.succeed({
              entries: [entry(id, 0), entry(id, 1), entry(id, 2)],
              cursors: [{ generation: 0, runId: id, afterSeq: seq(2) }],
              done: true
            }),
          "Sync.Subscribe": () => Stream.empty
        } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
      })

      const values = yield* (
        client.subscribe({ scope: { _tag: "Run", runId: id }, cursors: [] }).pipe(
          Stream.take(1),
          Stream.runCollect
        )
      )
      const cursors = (yield* client.progress).delivered

      expect(Array.from(values).map((value) => value.seq)).toEqual([0])
      expect(cursors).toEqual([{ generation: 0, runId: id, afterSeq: 0 }])
    }))
})
