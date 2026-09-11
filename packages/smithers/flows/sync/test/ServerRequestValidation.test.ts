import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Effect, Layer, Result, Schema, Stream } from "effect"
import * as RunCatalog from "../src/RunCatalog.ts"
import * as SyncPrincipal from "../src/SyncPrincipal.ts"
import * as SyncProtocol from "../src/SyncProtocol.ts"
import * as SyncServer from "../src/SyncServer.ts"
import * as TestEntry from "./fixtures/entry.ts"

const runId = "request-validation" as JournalEvent.RunId
const seq = (value: number) => value as JournalEvent.Seq

const entry = (sequence: number) => TestEntry.entry(runId, sequence)

describe("SyncServer request validation", () => {
  // The read position came from the FIRST duplicate and the echoed response
  // state from the LAST, so a follower persisting the returned cursors — which
  // the protocol tells it to do — skipped entries the page never carried.
  // There is no correct choice between the two readings, so neither is made.
  it.effect("refuses a cursor set that names one run twice, on both request paths", () =>
    Effect.gen(function*() {
      const reads: Array<JournalEvent.Seq | undefined> = []
      const [readFailure, subscribeFailure] = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive
          const cursors = [
            { generation: 0, runId, afterSeq: seq(0) },
            { generation: 0, runId, afterSeq: seq(2) }
          ]
          return [
            yield* Effect.flip(server.read({ protocolVersion: 1, scope: { _tag: "Run", runId }, cursors, limit: 10 })),
            yield* Effect.flip(
              Stream.runCollect(
                server.subscribe({ protocolVersion: 1, scope: { _tag: "Run", runId }, cursors, credit: 4 })
              )
            )
          ] as const
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({
                entries: ({ after }) => {
                  reads.push(after)
                  return Effect.succeed({ entries: [entry(1), entry(2)], hasMore: false })
                }
              }),
              RunCatalog.layerStatic([runId]),
              SyncPrincipal.layerWorkspace("validation-suite")
            )
          )
        )
      )

      expect(readFailure.code).toBe("invalid_request")
      expect(readFailure.message).toContain(runId)
      expect(subscribeFailure.code).toBe("invalid_request")
      // Refused before the journal is touched at all.
      expect(reads).toEqual([])
    }))

  it.effect("bounds limit at the wire and clamps it again for an in-process caller", () =>
    Effect.gen(function*() {
      const oversized = 1_000_000
      // The wire refuses the over-limit request outright.
      expect(
        Result.isFailure(
          Schema.decodeUnknownResult(SyncProtocol.ReadRequest)({
            protocolVersion: 1,
            scope: { _tag: "Run", runId },
            cursors: [],
            limit: oversized
          })
        )
      ).toBe(true)

      let receivedLimit = 0
      const page = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive
          // Constructed directly, bypassing the schema, the way an in-process
          // caller can. The journal must still never see an unbounded page.
          return yield* server.read({
            protocolVersion: 1,
            scope: { _tag: "Run", runId },
            cursors: [],
            limit: oversized
          })
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({
                entries: ({ limit }) => {
                  receivedLimit = limit
                  return Effect.succeed({ entries: [entry(0)], hasMore: false })
                }
              }),
              RunCatalog.layerStatic([runId]),
              SyncPrincipal.layerWorkspace("validation-suite")
            )
          )
        )
      )

      expect(receivedLimit).toBe(SyncProtocol.maxReadLimit)
      expect(page.entries).toHaveLength(1)
      expect(
        Schema.decodeUnknownSync(SyncProtocol.ReadRequest)({
          protocolVersion: 1,
          scope: { _tag: "Run", runId },
          cursors: [],
          limit: SyncProtocol.maxReadLimit
        })
      ).toMatchObject({ limit: SyncProtocol.maxReadLimit })
    }))

  // `subscribe` has floored `credit` since it was written; `read` only
  // CLAMPED, and `Math.min(NaN, ceiling)` is `NaN`. Every `entries.length >=
  // limit` comparison against it answered false, so no loop stopped early and
  // the value arrived at `journal.entries` as the page size, once per covered
  // run. Zero and a negative reached it verbatim the same way.
  it.effect("refuses a read limit that is not a positive safe integer, before touching the journal", () =>
    Effect.gen(function*() {
      const receivedLimits: Array<number> = []
      const refusals = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive
          const refuse = (limit: number) =>
            Effect.flip(server.read({ protocolVersion: 1, scope: { _tag: "Run", runId }, cursors: [], limit }))
          return [
            yield* refuse(Number.NaN),
            yield* refuse(0),
            yield* refuse(-1),
            yield* refuse(1.5)
          ] as const
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({
                entries: ({ limit }) => {
                  receivedLimits.push(limit)
                  return Effect.succeed({ entries: [entry(0)], hasMore: false })
                }
              }),
              RunCatalog.layerStatic([runId]),
              SyncPrincipal.layerWorkspace("validation-suite")
            )
          )
        )
      )

      for (const refusal of refusals) {
        expect(refusal.code).toBe("invalid_request")
        expect(refusal.message).toContain("A read's limit")
      }
      // The refusal precedes the read, so no page size ever left the boundary.
      expect(receivedLimits).toEqual([])
    }))

  it.effect("refuses a policy that is not a positive safe integer instead of quietly disabling it", () =>
    Effect.gen(function*() {
      const refusals = yield* (
        Effect.gen(function*() {
          return [
            // NaN made every `bytes > maxFrameBytes` comparison false, which
            // silently removed the ceiling the option exists to install.
            yield* Effect.flip(SyncServer.makeLiveWith({ maxFrameBytes: Number.NaN })),
            yield* Effect.flip(SyncServer.makeLiveWith({ concurrency: 0 })),
            yield* Effect.flip(SyncServer.makeLiveWith({ tailIntervalMs: -1 }))
          ] as const
        }).pipe(
          Effect.provide(
            Layer.mergeAll(Journal.layerNoop({}), RunCatalog.layerStatic([runId]))
          )
        )
      )

      for (const refusal of refusals) {
        expect(refusal.code).toBe("invalid_request")
        expect(refusal.message).toContain("SyncServer.Options")
      }
    }))
})
