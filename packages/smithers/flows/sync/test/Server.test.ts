import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Effect, Layer, Result, Schema, Stream } from "effect"
import * as RunCatalog from "../src/RunCatalog.ts"
import { SyncError } from "../src/SyncError.ts"
import * as SyncPrincipal from "../src/SyncPrincipal.ts"
import * as SyncProtocol from "../src/SyncProtocol.ts"
import * as SyncServer from "../src/SyncServer.ts"
import * as TestEntry from "./fixtures/entry.ts"

const runId = "gapped-run" as JournalEvent.RunId
const seq = (value: number) => value as JournalEvent.Seq
const sourceId = "source" as JournalEvent.SourceId
const sourceSeq = (value: number) => value as JournalEvent.SourceSeq

const entry = (value: number) => TestEntry.entry(runId, value, { eventId: `event-${value}` })

const makeServer = (entries: ReadonlyArray<JournalEvent.Entry>) =>
  SyncServer.makeLive.pipe(
    Effect.provide(
      Layer.mergeAll(
        Journal.layerNoop({
          stream: ({ afterSequence }) =>
            Stream.fromIterable(entries.filter((entry) => afterSequence === undefined || entry.seq > afterSequence))
        }),
        RunCatalog.layerStatic([runId])
      )
    )
  )

// Non-branch reads are fail-closed; these suites test replication mechanics,
// so they run as the workspace principal.
const asWorkspace = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provide(effect, SyncPrincipal.layerWorkspace("server-suite"))

describe("SyncServer", () => {
  it.effect("covers legitimate journal gaps and enforces subscription credit", () =>
    Effect.gen(function*() {
      const frames = yield* asWorkspace(
        Effect.gen(function*() {
          const server = yield* makeServer([entry(2), entry(5), entry(8)])
          return yield* server.subscribe({
            protocolVersion: 1,
            scope: { _tag: "Run", runId },
            cursors: [{ generation: 0, runId, afterSeq: seq(0) }],
            credit: 2
          }).pipe(Stream.runCollect)
        })
      )

      expect(Array.from(frames)).toMatchObject([
        { generation: 0, _tag: "Entries", fromSeq: 1, toSeq: 2, entries: [{ seq: 2 }] },
        { generation: 0, _tag: "Entries", fromSeq: 3, toSeq: 5, entries: [{ seq: 5 }] }
      ])
    }))

  for (const budget of ["count", "bytes"] as const) {
    it.effect(`serves every backlogged run across ${budget}-limited pages`, () =>
      Effect.gen(function*() {
        const ids = ["a", "b", "c"] as Array<JournalEvent.RunId>
        const makeEntry = (id: JournalEvent.RunId, value: number) =>
          new JournalEvent.Entry({ ...entry(value), runId: id })
        const server = yield* SyncServer.makeLiveWith({
          maxFrameBytes: budget === "bytes" ? SyncProtocol.encodedByteLength(makeEntry(ids[0]!, 10_000)) : 4096
        }).pipe(Effect.provide(Layer.mergeAll(
          Journal.layerNoop({
            entries: ({ runId, after, limit }) =>
              Effect.succeed({
                entries: Array.from({ length: limit }, (_, i) => makeEntry(runId, (after ?? -1) + (i + 1) * 100)),
                hasMore: true
              })
          }),
          RunCatalog.layerStatic(ids)
        )))
        let cursors: SyncProtocol.WorkspaceCursor = []
        const seen = new Set<JournalEvent.RunId>()
        for (let page = 0; page < 6; page++) {
          const response = yield* asWorkspace(server.read({
            protocolVersion: 1,
            scope: { _tag: "Workspace" },
            cursors,
            limit: budget === "count" ? 2 : 6
          }))
          expect(response.done).toBe(false)
          expect(response.entries.length).toBeGreaterThan(0)
          expect(response.entries.length).toBeLessThanOrEqual(budget === "count" ? 2 : 1)
          for (const value of response.entries) {
            expect(value.seq).toBeGreaterThan(cursors.find((cursor) => cursor.runId === value.runId)?.afterSeq ?? -1)
            seen.add(value.runId)
          }
          cursors = response.cursors
        }
        expect([...seen].sort()).toEqual(ids)
        expect(cursors.every((cursor) => cursor.afterSeq >= 199)).toBe(true)
      }))
  }

  // A zero credit has two readings that are indistinguishable on the wire —
  // "open a window of nothing" and "a caller computed its window wrong" — and
  // the second busy-loops a follow that replenishes by resubscribing. It is
  // refused rather than served as an immediately-empty stream.
  it.effect("refuses a subscription whose credit is not a positive integer", () =>
    Effect.gen(function*() {
      const refusals = yield* asWorkspace(
        Effect.gen(function*() {
          const server = yield* makeServer([entry(0)])
          const attempt = (credit: number) =>
            Effect.flip(
              Stream.runCollect(
                server.subscribe({ protocolVersion: 1, scope: { _tag: "Run", runId }, cursors: [], credit })
              )
            )
          return [yield* attempt(0), yield* attempt(-1), yield* attempt(Number.NaN)] as const
        })
      )

      for (const refusal of refusals) {
        expect(SyncError.is(refusal)).toBe(true)
        expect(refusal.code).toBe("invalid_request")
      }
      expect(
        Result.isFailure(
          Schema.decodeUnknownResult(SyncProtocol.SubscribeRequest)({
            protocolVersion: 1,
            scope: { _tag: "Run", runId },
            cursors: [],
            credit: 0
          })
        )
      ).toBe(true)
    }))

  // The credit ceiling is enforced on both sides: the wire refuses an
  // over-limit request outright, and an in-process caller is clamped, so no
  // path can pin one server-side fan-out for an unbounded number of frames.
  it.effect("bounds credit above as well as below", () =>
    Effect.gen(function*() {
      const windows = yield* asWorkspace(
        Effect.gen(function*() {
          const server = yield* makeServer(
            Array.from({ length: SyncProtocol.maxSubscribeCredit + 1 }, (_, i) => entry(i))
          )
          return yield* Effect.forEach(
            [SyncProtocol.maxSubscribeCredit, SyncProtocol.maxSubscribeCredit + 1],
            (credit) =>
              Stream.runCollect(
                server.subscribe({
                  protocolVersion: 1,
                  scope: { _tag: "Run", runId },
                  cursors: [],
                  credit
                })
              )
          )
        })
      )

      for (const frames of windows) expect(Array.from(frames)).toHaveLength(SyncProtocol.maxSubscribeCredit)
      expect(
        Result.isFailure(
          Schema.decodeUnknownResult(SyncProtocol.SubscribeRequest)({
            protocolVersion: 1,
            scope: { _tag: "Run", runId },
            cursors: [],
            credit: SyncProtocol.maxSubscribeCredit + 1
          })
        )
      ).toBe(true)
    }))
})
