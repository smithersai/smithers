/**
 * Boundary contracts that distinguish recoverable sync traffic from malformed
 * or terminal transport input.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Effect, Exit, Fiber, Layer, Stream } from "effect"
import * as RpcClient from "effect/unstable/rpc/RpcClient"
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization"
import * as Socket from "effect/unstable/socket/Socket"
import * as RunCatalog from "../src/RunCatalog.ts"
import * as SyncClient from "../src/SyncClient.ts"
import { SyncError, SyncGapError } from "../src/SyncError.ts"
import * as SyncPrincipal from "../src/SyncPrincipal.ts"
import * as SyncServer from "../src/SyncServer.ts"
import * as TestSocket from "../src/test/TestSocket.ts"

const runId = (value: string) => value as JournalEvent.RunId
const seq = (value: number) => value as JournalEvent.Seq
const sourceId = "source" as JournalEvent.SourceId
const sourceSeq = (value: number) => value as JournalEvent.SourceSeq

const entry = (sequence: number) =>
  new JournalEvent.Entry({
    runId: runId("boundary"),
    seq: seq(sequence),
    eventId: `boundary-${sequence}`,
    sourceId,
    sourceSeq: sourceSeq(sequence),
    emittedAtMs: sequence,
    eventType: "event",
    payload: sequence,
    meta: null
  })

const scope = { _tag: "Run", runId: runId("boundary") } as const

describe("sync malformed and terminal boundaries", () => {
  it.effect("constructs the public client layer over an active socket protocol", () =>
    Effect.gen(function*() {
      const cursors = yield* (
        Effect.gen(function*() {
          const pair = yield* TestSocket.makePair()
          const protocol = yield* RpcClient.makeProtocolSocket().pipe(
            Effect.provideService(Socket.Socket, pair.client),
            Effect.provide(RpcSerialization.layerJson)
          )
          const client = yield* SyncClient.SyncClient.pipe(
            Effect.provide(SyncClient.layer),
            Effect.provideService(RpcClient.Protocol, protocol)
          )
          return (yield* client.progress).delivered
        }).pipe(Effect.scoped)
      )

      expect(cursors).toEqual([])
    }))

  it.effect("preserves a typed transport failure rather than wrapping it again", () =>
    Effect.gen(function*() {
      const failure = new SyncError({ code: "protocol_violation", message: "bad response" })
      const client = yield* SyncClient.make({
        client: {
          "Sync.Read": () => Effect.fail(failure),
          "Sync.Subscribe": () => Stream.empty
        } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
      })

      const exit = yield* Effect.exit(Stream.runCollect(client.subscribe({ scope, cursors: [] })))

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error).toBe(failure)
      }
    }))

  it.effect("uses the stable fallback message for a non-Error transport rejection", () =>
    Effect.gen(function*() {
      const client = yield* SyncClient.make({
        client: {
          "Sync.Read": () => Effect.fail({ disconnected: true }),
          "Sync.Subscribe": () => Stream.empty
        } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
      })

      const exit = yield* Effect.exit(Stream.runCollect(client.subscribe({ scope, cursors: [] })))

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error).toMatchObject({
          code: "transport_failed",
          message: "Sync RPC transport failed"
        })
      }
    }))

  it.effect("rejects a live frame whose covered interval begins after the cursor", () =>
    Effect.gen(function*() {
      const client = yield* SyncClient.make({
        client: {
          "Sync.Read": () => Effect.succeed({ entries: [], cursors: [], done: true }),
          "Sync.Subscribe": () =>
            Stream.succeed({
              _tag: "Entries" as const,
              generation: 0,
              runId: runId("boundary"),
              fromSeq: seq(1),
              toSeq: seq(1),
              entries: [entry(1)]
            })
        } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
      })

      const exit = yield* Effect.exit(Stream.runCollect(client.subscribe({ scope, cursors: [] })))

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error).toBeInstanceOf(SyncGapError)
      }
    }))

  it.effect("does not re-admit an interval ending exactly at the supplied cursor", () =>
    Effect.gen(function*() {
      const client = yield* SyncClient.make({
        client: {
          "Sync.Read": () => Effect.succeed({ entries: [], cursors: [], done: true }),
          "Sync.Subscribe": () =>
            Stream.concat(
              Stream.succeed({
                _tag: "Entries" as const,
                generation: 0,
                runId: runId("boundary"),
                fromSeq: seq(0),
                toSeq: seq(1),
                entries: [entry(0), entry(1)]
              }),
              Stream.succeed({ _tag: "Closed" as const, reason: "complete" })
            )
        } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
      })

      const exit = yield* Effect.exit(
        Stream.runCollect(
          client.subscribe({ scope, cursors: [{ runId: runId("boundary"), afterSeq: seq(1) }] })
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error).toMatchObject({ code: "closed" })
      }
      expect((yield* client.progress).delivered).toEqual([])
    }))

  it.effect("maps a non-Error journal failure to the stable server fallback message", () =>
    Effect.gen(function*() {
      const failure = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive
          return yield* Effect.flip(server.read({ protocolVersion: 1, scope, cursors: [], limit: 1 }))
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({ entries: () => Effect.fail("offline" as unknown as Journal.JournalError) }),
              RunCatalog.layerStatic([runId("boundary")]),
              SyncPrincipal.layerWorkspace("coverage-suite")
            )
          )
        )
      )

      // The message names the run and nothing the journal wrote, and the
      // cause names the failure's type rather than carrying host data.
      expect(failure).toMatchObject({
        code: "unknown",
        message: `Journal read failed for run ${runId("boundary")}`,
        cause: "[object String]"
      })
    }))

  it.effect("passes a JSON null frame through range filtering without treating it as entries", () =>
    Effect.gen(function*() {
      const received = yield* (
        Effect.gen(function*() {
          const pair = yield* TestSocket.makePair()
          pair.faults.dropRange("boundary", 0, 1)
          const write = yield* pair.client.writer
          const frames: Array<string> = []
          const fiber = yield* pair.server.runRaw((bytes) =>
            Effect.sync(() => {
              frames.push(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes))
            })
          ).pipe(Effect.forkChild)
          yield* write("null")
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          yield* Fiber.interrupt(fiber)
          return frames
        }).pipe(Effect.scoped)
      )

      expect(received).toEqual(["null"])
    }))

  it.effect("allows synchronous frame handlers to acknowledge delivery without an Effect result", () =>
    Effect.gen(function*() {
      const received = yield* (
        Effect.gen(function*() {
          const pair = yield* TestSocket.makePair()
          const frames: Array<string> = []
          const fiber = yield* pair.server.runRaw((bytes) => {
            frames.push(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes))
          }).pipe(Effect.forkChild)
          const write = yield* pair.client.writer
          yield* write("synchronous")
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          yield* Fiber.interrupt(fiber)
          return frames
        }).pipe(Effect.scoped)
      )

      expect(received).toEqual(["synchronous"])
    }))
})
