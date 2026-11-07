/**
 * End-to-end sync behavior under injected transport faults.
 *
 * @since 0.1.0
 */
// Every case here runs on real elapsed time — subprocess spawns, file locks,
// mtimes, and poll loops — so the suite uses `it.live`; `it.effect`'s
// TestClock never advances for them.

import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Deferred, Effect, Fiber, type Scope, Stream } from "effect"
import type * as SyncRpcs from "../src/SyncRpcs.ts"
import type * as SyncServer from "../src/SyncServer.ts"
import * as TestSocket from "../src/test/TestSocket.ts"
import * as TestSync from "../src/test/TestSync.ts"

const runId = (value: string) => value as JournalEvent.RunId
const sourceId = "source" as JournalEvent.SourceId

const program = <A, E>(
  effect: Effect.Effect<A, E, Journal.Journal | Scope.Scope | SyncRpcs.SyncAuth | SyncServer.SyncServer>
) => Effect.exit(effect.pipe(Effect.provide(TestSync.layerTest), Effect.scoped))

describe("sync over a faulty transport", () => {
  it.live("never skips past an entry whose frame the transport keeps dropping", () =>
    Effect.gen(function*() {
      const id = runId("dropped-forever")
      const exit = yield* program(
        Effect.gen(function*() {
          const journal = yield* Journal.Journal
          const pair = yield* TestSocket.makePair()
          pair.faults.dropRange(id, 1, 1)
          const client = yield* TestSync.connect(pair)
          const initialRead = yield* Deferred.make<void>()

          yield* journal.emitDurableUnfenced({ runId: id, sourceId, eventType: "event-0", payload: { value: 0 } })
          yield* journal.flush

          const fiber = yield* Stream.runCollect(
            client.subscribe({ scope: { _tag: "Run", runId: id }, cursors: [] }).pipe(
              Stream.tap((entry) => entry.seq === 0 ? Deferred.succeed(initialRead, undefined) : Effect.void),
              Stream.take(3)
            )
          ).pipe(Effect.forkChild({ startImmediately: true }))

          yield* Deferred.await(initialRead)
          for (const value of [1, 2]) {
            yield* journal.emitDurableUnfenced({ runId: id, sourceId, eventType: `event-${value}`, payload: { value } })
            yield* journal.flush
          }
          const settled = yield* Fiber.join(fiber).pipe(Effect.timeoutOption("200 millis"))
          yield* Fiber.interrupt(fiber)
          return settled
        })
      )

      expect(exit._tag).toBe("Success")
      if (exit._tag === "Success") expect(exit.value._tag).toBe("None")
    }))

  it.live("delivers stalled traffic once the transport resumes", () =>
    Effect.gen(function*() {
      const id = runId("stalled-transport")
      const exit = yield* program(
        Effect.gen(function*() {
          const journal = yield* Journal.Journal
          const pair = yield* TestSocket.makePair()
          const client = yield* TestSync.connect(pair)

          yield* journal.emitDurableUnfenced({ runId: id, sourceId, eventType: "before-stall", payload: { value: 0 } })
          yield* journal.flush

          pair.faults.stall()
          const fiber = yield* Stream.runCollect(
            client.subscribe({ scope: { _tag: "Run", runId: id }, cursors: [] }).pipe(Stream.take(1))
          ).pipe(Effect.forkChild({ startImmediately: true }))

          const stalled = yield* Fiber.join(fiber).pipe(Effect.timeoutOption("200 millis"))
          pair.faults.resume()
          const entries = yield* Fiber.join(fiber)
          return {
            stalledTag: stalled._tag,
            eventTypes: Array.from(entries).map((entry) => entry.eventType)
          }
        })
      )

      expect(exit).toMatchObject({
        _tag: "Success",
        value: { stalledTag: "None", eventTypes: ["before-stall"] }
      })
    }))

  it.live("retries instead of failing the subscription when the transport disconnects mid-stream", () =>
    Effect.gen(function*() {
      const id = runId("disconnected")
      const exit = yield* program(
        Effect.gen(function*() {
          const journal = yield* Journal.Journal
          const pair = yield* TestSocket.makePair()
          const client = yield* TestSync.connect(pair)
          const following = Deferred.makeUnsafe<void>()
          // Disconnect a live Subscribe request, after catch-up has ended.
          // RPC 4.1 can start its socket reads before the first consumer pull.
          pair.faults.installFilter((bytes) => {
            const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes))
            const frames: ReadonlyArray<unknown> = Array.isArray(decoded) ? decoded : [decoded]
            if (
              frames.some((frame) =>
                typeof frame === "object" && frame !== null &&
                "_tag" in frame && frame._tag === "Request" && "tag" in frame && frame.tag === "Sync.Subscribe"
              )
            ) {
              Deferred.doneUnsafe(following, Effect.void)
            }
            return true
          })

          yield* journal.emitDurableUnfenced({ runId: id, sourceId, eventType: "first", payload: { value: 0 } })
          yield* journal.flush

          const fiber = yield* Stream.runCollect(
            client.subscribe({ scope: { _tag: "Run", runId: id }, cursors: [] }).pipe(Stream.take(2))
          ).pipe(Effect.forkChild({ startImmediately: true }))

          yield* Deferred.await(following)
          yield* pair.faults.disconnect()
          const settled = yield* Fiber.await(fiber).pipe(Effect.timeoutOption("500 millis"))
          yield* Fiber.interrupt(fiber)
          return settled._tag
        })
      )

      expect(exit).toMatchObject({ _tag: "Success", value: "None" })
    }))
})
