import { describe, expect, it } from "@effect/vitest"
import { JournalEvent } from "@smthrs/journal"
import { Deferred, Effect, Fiber, Stream } from "effect"
import * as SyncClient from "../src/SyncClient.ts"
import type * as SyncProtocol from "../src/SyncProtocol.ts"

const runId = "shared-client" as JournalEvent.RunId
const seq = (value: number) => value as JournalEvent.Seq

const entry = (sequence: number) =>
  new JournalEvent.Entry({
    runId,
    seq: seq(sequence),
    eventId: `shared-client-${sequence}`,
    sourceId: "source" as JournalEvent.SourceId,
    sourceSeq: sequence as JournalEvent.SourceSeq,
    emittedAtMs: sequence,
    eventType: "event",
    payload: sequence,
    meta: null
  })

describe("one SyncClient with concurrent subscriptions", () => {
  it.effect("follows a live run on a credit window instead of one subscribe per entry", () =>
    Effect.gen(function*() {
      // The client asked for `credit: 1`, so the server's `Stream.take(credit)`
      // closed the subscription after every single frame and the follow
      // resubscribed. A hundred live entries cost a hundred round trips.
      const total = 100
      let subscribes = 0
      let produced = 0
      const client = yield* SyncClient.make({
        client: {
          "Sync.Read": () => Effect.succeed({ entries: [], cursors: [], done: true }),
          "Sync.Subscribe": (request: SyncProtocol.SubscribeRequest) => {
            subscribes += 1
            const frames: Array<SyncProtocol.Frame> = []
            // The server serves at most `credit` frames per subscription.
            while (frames.length < request.credit && produced < total) {
              const sequence = seq(produced)
              frames.push({
                generation: 0,
                _tag: "Entries",
                runId,
                fromSeq: sequence,
                toSeq: sequence,
                entries: [entry(produced)]
              })
              produced += 1
            }
            return Stream.fromIterable(frames)
          }
        } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
      })

      const collected = yield* Stream.runCollect(
        Stream.take(client.subscribe({ scope: { _tag: "Run", runId }, cursors: [] }), total)
      )

      expect(Array.from(collected, (value) => value.seq)).toEqual(
        Array.from({ length: total }, (_, index) => index)
      )
      expect(subscribes).toBeLessThanOrEqual(Math.ceil(total / SyncClient.defaultCredit))
    }))

  it.effect("honours an explicit credit window", () =>
    Effect.gen(function*() {
      const total = 12
      const credit = 4
      let subscribes = 0
      let produced = 0
      const client = yield* SyncClient.make({
        client: {
          "Sync.Read": () => Effect.succeed({ entries: [], cursors: [], done: true }),
          "Sync.Subscribe": (request: SyncProtocol.SubscribeRequest) => {
            subscribes += 1
            expect(request.credit).toBe(credit)
            const frames: Array<SyncProtocol.Frame> = []
            while (frames.length < request.credit && produced < total) {
              const sequence = seq(produced)
              frames.push({
                generation: 0,
                _tag: "Entries",
                runId,
                fromSeq: sequence,
                toSeq: sequence,
                entries: [entry(produced)]
              })
              produced += 1
            }
            return Stream.fromIterable(frames)
          }
        } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
      })

      yield* Stream.runDrain(
        Stream.take(client.subscribe({ scope: { _tag: "Run", runId }, cursors: [], credit }), total)
      )

      expect(subscribes).toBe(total / credit)
    }))

  it.effect("keeps the acknowledged cursor monotonic when a lower commit lands late", () =>
    Effect.gen(function*() {
      const firstRead = yield* (Deferred.make<SyncProtocol.ReadResponse>())
      const secondRead = yield* (Deferred.make<SyncProtocol.ReadResponse>())
      const callsStarted = yield* (Deferred.make<void>())
      const thirdReadStarted = yield* (Deferred.make<void>())
      const observedRequests: Array<SyncProtocol.WorkspaceCursor> = []
      let reads = 0
      const client = yield* SyncClient.make({
        client: {
          "Sync.Read": (request: SyncProtocol.ReadRequest) => {
            observedRequests.push(request.cursors)
            reads += 1
            if (reads === 1) return Deferred.await(firstRead)
            if (reads === 2) {
              return Effect.andThen(Deferred.succeed(callsStarted, undefined), Deferred.await(secondRead))
            }
            const afterSeq = request.cursors.find((cursor) => cursor.runId === runId)?.afterSeq
            return Effect.andThen(
              Deferred.succeed(thirdReadStarted, undefined),
              Effect.succeed({
                entries: afterSeq === undefined || afterSeq < 2 ? [entry(2)] : [],
                cursors: [],
                done: true
              })
            )
          },
          "Sync.Subscribe": () => Stream.never
        } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
      })
      const scope = { _tag: "Run", runId } as const

      const result = yield* (
        Effect.scoped(
          Effect.gen(function*() {
            const lower = yield* Stream.runCollect(
              Stream.take(client.subscribe({ scope, cursors: [] }), 1)
            ).pipe(Effect.forkChild({ startImmediately: true }))
            yield* Effect.yieldNow
            const higher = yield* Stream.runCollect(
              Stream.take(client.subscribe({ scope, cursors: [] }), 1)
            ).pipe(Effect.forkChild({ startImmediately: true }))
            yield* Deferred.await(callsStarted)

            yield* Deferred.succeed(secondRead, {
              entries: [entry(2)],
              cursors: [{ generation: 0, runId, afterSeq: seq(2) }],
              done: true
            })
            yield* Fiber.join(higher)
            yield* Deferred.succeed(firstRead, {
              entries: [entry(1)],
              cursors: [{ generation: 0, runId, afterSeq: seq(1) }],
              done: true
            })
            yield* Fiber.join(lower)

            const cursorAfterRace = (yield* client.progress).delivered
            const third = yield* Stream.runCollect(
              Stream.take(client.subscribe({ scope, cursors: [] }), 1)
            ).pipe(Effect.forkChild({ startImmediately: true }))
            yield* Deferred.await(thirdReadStarted)
            yield* Effect.yieldNow
            const redeliveryExit = third.pollUnsafe()
            yield* Fiber.interrupt(third)
            return { cursorAfterRace, redeliveryExit }
          })
        )
      )

      expect(result.cursorAfterRace).toEqual([{ generation: 0, runId, afterSeq: 2 }])
      expect(observedRequests[2]).toEqual([{ generation: 0, runId, afterSeq: 2 }])
      expect(result.redeliveryExit).toBeUndefined()
    }))
})
