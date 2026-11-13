/**
 * End-to-end sync behavior under injected transport faults.
 *
 * @since 0.1.0
 */
// These in-memory RPC fault cases use `it.live` for their stall and reconnect
// timeouts. They exercise socket queues without subprocesses or filesystem I/O.

import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Cause, Deferred, Effect, Fiber, Layer, type Scope, Stream } from "effect"
import * as NetAddress from "effect/net/NetAddress"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as RpcServer from "effect/rpc/RpcServer"
import * as Socket from "effect/socket/Socket"
import * as SocketServer from "effect/socket/SocketServer"
import * as SyncClient from "../src/SyncClient.ts"
import type * as SyncProtocol from "../src/SyncProtocol.ts"
import * as SyncRpcs from "../src/SyncRpcs.ts"
import * as SyncServer from "../src/SyncServer.ts"
import * as TestSocket from "../src/test/TestSocket.ts"
import * as TestSync from "../src/test/TestSync.ts"

const runId = (value: string) => value as JournalEvent.RunId
const sourceId = "source" as JournalEvent.SourceId

const wireFrames = (bytes: Uint8Array): ReadonlyArray<Readonly<Record<string, unknown>>> => {
  const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes))
  const frames: ReadonlyArray<unknown> = Array.isArray(decoded) ? decoded : [decoded]
  return frames.filter((frame): frame is Readonly<Record<string, unknown>> =>
    typeof frame === "object" && frame !== null
  )
}

/**
 * Replaces each `Entries` frame covering `seq` with a `Heartbeat` frame and
 * keeps the RPC `Chunk` message that carried it, so the entries are lost but
 * the RPC still acknowledges the message and the server keeps sending.
 * `TestSocket.dropRange` drops the whole message instead: the server then
 * waits for an acknowledgement that never comes, and a client that skipped
 * the hole looks the same as one that refused it.
 */
const loseEntries = (bytes: Uint8Array, runId: JournalEvent.RunId, seq: number, onLoss: () => void) => {
  const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes))
  const lose = (message: unknown): unknown => {
    if (typeof message !== "object" || message === null) return message
    const record = message as Readonly<Record<string, unknown>>
    if (record["_tag"] !== "Chunk" || !Array.isArray(record["values"])) return message
    return {
      ...record,
      values: (record["values"] as ReadonlyArray<Readonly<Record<string, unknown>>>).map((frame) => {
        if (
          frame["_tag"] !== "Entries" || frame["runId"] !== runId ||
          (frame["fromSeq"] as number) > seq || seq > (frame["toSeq"] as number)
        ) return frame
        onLoss()
        return { _tag: "Heartbeat" }
      })
    }
  }
  return new TextEncoder().encode(JSON.stringify(Array.isArray(decoded) ? decoded.map(lose) : lose(decoded)))
}

/**
 * `TestSync.connect`, with every live Subscribe request the client sends
 * reported to `onSubscribe` before it reaches the RPC client. A disconnected
 * test socket stays failed, so a retried request never reaches the wire; this
 * is where the reconnect policy's retries are observable.
 */
const connectRecording = (pair: TestSocket.Pair, onSubscribe: (request: SyncProtocol.SubscribeRequest) => void) =>
  Effect.gen(function*() {
    const sync = yield* SyncServer.SyncServer
    const serverProtocol = yield* RpcServer.makeProtocolSocketServer.pipe(
      Effect.provideService(SocketServer.SocketServer, {
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 0),
        run: (handler) => handler(pair.server).pipe(Effect.orDie, Effect.andThen(Effect.never))
      }),
      Effect.provide(RpcSerialization.layerJson)
    )
    yield* RpcServer.make(SyncRpcs.SyncRpcs, { disableFatalDefects: true }).pipe(
      Effect.provideService(RpcServer.Protocol, serverProtocol),
      Effect.provide(SyncServer.layerHandlers.pipe(Layer.provide(Layer.succeed(SyncServer.SyncServer, sync)))),
      Effect.forkScoped
    )
    const protocol = yield* RpcClient.makeProtocolSocket().pipe(
      Effect.provideService(Socket.Socket, pair.client),
      Effect.provide(RpcSerialization.layerJson)
    )
    const client = yield* RpcClient.make(SyncRpcs.SyncRpcs).pipe(Effect.provideService(RpcClient.Protocol, protocol))
    return yield* SyncClient.make({
      client: {
        ...client,
        "Sync.Subscribe": (request, options) => {
          onSubscribe(request)
          return client["Sync.Subscribe"](request, options)
        }
      }
    })
  })

const program = <A, E>(
  effect: Effect.Effect<A, E, Journal.Journal | Scope.Scope | SyncRpcs.SyncAuth | SyncServer.SyncServer>
) => Effect.exit(effect.pipe(Effect.provide(TestSync.layerTest), Effect.scoped))

describe("sync over a faulty transport", () => {
  it.live("fails with a gap instead of skipping an entry whose frame the transport dropped", () =>
    Effect.gen(function*() {
      const id = runId("dropped-forever")
      const exit = yield* program(
        Effect.gen(function*() {
          const journal = yield* Journal.Journal
          const pair = yield* TestSocket.makePair()
          const dropped = yield* Deferred.make<void>()
          pair.faults.installFilter((bytes) =>
            loseEntries(bytes, id, 1, () => Deferred.doneUnsafe(dropped, Effect.void))
          )
          const client = yield* TestSync.connect(pair)
          const initialRead = yield* Deferred.make<void>()

          yield* journal.emitDurableUnfenced({ runId: id, sourceId, eventType: "event-0", payload: { value: 0 } })
          yield* journal.flush

          const fiber = yield* Stream.runCollect(
            client.subscribe({ scope: { _tag: "Run", runId: id }, cursors: [] }).pipe(
              Stream.tap((entry) => entry.seq === 0 ? Deferred.succeed(initialRead, undefined) : Effect.void),
              Stream.take(2)
            )
          ).pipe(Effect.forkChild({ startImmediately: true }))

          yield* Deferred.await(initialRead)
          yield* journal.emitDurableUnfenced({ runId: id, sourceId, eventType: "event-1", payload: { value: 1 } })
          yield* journal.flush
          yield* Deferred.await(dropped)
          yield* journal.emitDurableUnfenced({ runId: id, sourceId, eventType: "event-2", payload: { value: 2 } })
          yield* journal.flush
          const settled = yield* Fiber.await(fiber)
          return { settled, progress: yield* client.progress }
        })
      )

      expect(exit._tag).toBe("Success")
      if (exit._tag !== "Success") return
      const { progress, settled } = exit.value
      expect(settled._tag).toBe("Failure")
      if (settled._tag === "Failure") {
        expect(Cause.squash(settled.cause)).toMatchObject({
          _tag: "@smthrs/sync/SyncGapError",
          runId: id,
          expectedFrom: 1,
          receivedFrom: 2
        })
      }
      expect(progress.delivered).toEqual([{ runId: id, afterSeq: 0, generation: 0 }])
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

  it.live("resubscribes after the delivered entry when the transport disconnects mid-stream", () =>
    Effect.gen(function*() {
      const id = runId("disconnected")
      const exit = yield* program(
        Effect.gen(function*() {
          const journal = yield* Journal.Journal
          const pair = yield* TestSocket.makePair()
          const subscribes: Array<ReadonlyArray<SyncProtocol.RunCursor>> = []
          const resubscribed = Deferred.makeUnsafe<void>()
          const client = yield* connectRecording(pair, (request) => {
            subscribes.push(request.cursors)
            if (subscribes.length === 2) Deferred.doneUnsafe(resubscribed, Effect.void)
          })
          const following = Deferred.makeUnsafe<void>()
          // Disconnect a live Subscribe request, after catch-up has ended.
          // RPC 4.1 can start its socket reads before the first consumer pull.
          pair.faults.installFilter((bytes) => {
            if (wireFrames(bytes).some((frame) => frame["_tag"] === "Request" && frame["tag"] === "Sync.Subscribe")) {
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
          // The first reconnect waits 500 ms; allow it several times over.
          const retried = yield* Deferred.await(resubscribed).pipe(Effect.timeoutOption("5 seconds"))
          const settled = yield* Fiber.await(fiber).pipe(Effect.timeoutOption("1 millis"))
          yield* Fiber.interrupt(fiber)
          return { retried: retried._tag, settled: settled._tag, subscribes }
        })
      )

      expect(exit).toMatchObject({
        _tag: "Success",
        value: {
          retried: "Some",
          settled: "None",
          subscribes: [
            [{ runId: id, afterSeq: 0, generation: 0 }],
            [{ runId: id, afterSeq: 0, generation: 0 }]
          ]
        }
      })
    }))
})
