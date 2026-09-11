/**
 * Cursor materialization and re-subscription behavior of the sync client.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import { JournalEvent } from "@smthrs/journal"
import { Effect, Stream } from "effect"
import * as SyncClient from "../src/SyncClient.ts"
import type * as SyncProtocol from "../src/SyncProtocol.ts"

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

const stubClient = (read: () => Effect.Effect<SyncProtocol.ReadResponse>) =>
  Effect.runSync(SyncClient.make({
    client: {
      "Sync.Read": read,
      "Sync.Subscribe": () => Stream.empty
    } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
  }))

describe("SyncClient cursors", () => {
  it.effect("canonicalizes duplicate supplied cursors through the Map key invariant", () =>
    Effect.gen(function*() {
      const reads: Array<SyncProtocol.WorkspaceCursor> = []
      const client = yield* SyncClient.make({
        client: {
          "Sync.Read": (request: SyncProtocol.ReadRequest) => {
            reads.push(request.cursors)
            return Effect.succeed({
              entries: [entry("duplicate", 5)],
              cursors: [{ runId: runId("duplicate"), afterSeq: seq(5), generation: 0 }],
              done: true
            })
          },
          "Sync.Subscribe": () => Stream.empty
        } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
      })

      const values = yield* (
        client.subscribe({
          scope: { _tag: "Run", runId: runId("duplicate") },
          cursors: [
            { generation: 0, runId: runId("duplicate"), afterSeq: seq(3) },
            { generation: 0, runId: runId("duplicate"), afterSeq: seq(4) }
          ]
        }).pipe(Stream.take(1), Stream.runCollect)
      )

      // Both cursor ingestion and acknowledgement use Map keys, so a canonical
      // snapshot has one cursor per run and sorting never compares equal run IDs.
      expect(reads).toEqual([[{ generation: 0, runId: "duplicate", afterSeq: 4 }]])
      expect(Array.from(values).map((value) => value.seq)).toEqual([5])
      expect((yield* client.progress).delivered).toEqual([{ generation: 0, runId: "duplicate", afterSeq: 5 }])
    }))

  it.effect("returns acknowledged cursors in canonical run order regardless of arrival order", () =>
    Effect.gen(function*() {
      let page = 0
      const client = stubClient(() => {
        page += 1
        return Effect.succeed(
          page === 1
            ? {
              entries: [entry("zeta", 0), entry("alpha", 3), entry("mid", 1)],
              cursors: [
                { runId: runId("zeta"), afterSeq: seq(0), generation: 0 },
                { runId: runId("alpha"), afterSeq: seq(3), generation: 0 },
                { runId: runId("mid"), afterSeq: seq(1), generation: 0 }
              ],
              done: true
            }
            : { entries: [], cursors: [], done: true }
        )
      })

      yield* (
        Stream.runDrain(
          client.subscribe({ scope: { _tag: "Workspace" }, cursors: [] }).pipe(Stream.take(3))
        )
      )
      const cursors = (yield* client.progress).delivered

      expect(cursors).toEqual([
        { generation: 0, runId: "alpha", afterSeq: 3 },
        { generation: 0, runId: "mid", afterSeq: 1 },
        { generation: 0, runId: "zeta", afterSeq: 0 }
      ])
    }))

  it.effect("carries acknowledged cursors into a later subscription so entries are not re-delivered", () =>
    Effect.gen(function*() {
      const reads: Array<SyncProtocol.WorkspaceCursor> = []
      const client = yield* SyncClient.make({
        client: {
          "Sync.Read": (request: SyncProtocol.ReadRequest) => {
            reads.push(request.cursors)
            return Effect.succeed({
              entries: reads.length === 1 ? [entry("run", 0), entry("run", 1)] : [entry("run", 2)],
              cursors: [{ runId: runId("run"), afterSeq: seq(reads.length === 1 ? 1 : 2), generation: 0 }],
              done: true
            })
          },
          "Sync.Subscribe": () => Stream.empty
        } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
      })

      const scope = { _tag: "Run", runId: runId("run") } as const
      yield* (
        Stream.runDrain(client.subscribe({ scope, cursors: [] }).pipe(Stream.take(2)))
      )
      const second = yield* (
        Stream.runCollect(client.subscribe({ scope, cursors: [] }).pipe(Stream.take(1)))
      )

      expect(reads[0]).toEqual([])
      expect(reads[1]).toEqual([{ generation: 0, runId: "run", afterSeq: 1 }])
      expect(Array.from(second).map((value) => value.seq)).toEqual([2])
    }))

  // The documented contract: the effective cursor is `max(caller,
  // acknowledged)` per run. A caller whose cursor is AHEAD restored progress
  // from its own persistence; regressing it to the acknowledged view would
  // re-deliver entries it has already materialized, which is exactly what the
  // client promises never to do.
  it.effect("keeps a caller cursor that is ahead of the acknowledged view", () =>
    Effect.gen(function*() {
      const reads: Array<SyncProtocol.WorkspaceCursor> = []
      const client = yield* SyncClient.make({
        client: {
          "Sync.Read": (request: SyncProtocol.ReadRequest) => {
            reads.push(request.cursors)
            return Effect.succeed({
              entries: [entry("ahead", reads.length === 1 ? 4 : 10)],
              cursors: [{ runId: runId("ahead"), afterSeq: seq(reads.length === 1 ? 4 : 10), generation: 0 }],
              done: true
            })
          },
          "Sync.Subscribe": () => Stream.empty
        } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
      })
      const scope = { _tag: "Run", runId: runId("ahead") } as const

      yield* Stream.runDrain(client.subscribe({ scope, cursors: [] }).pipe(Stream.take(1)))
      yield* Stream.runDrain(
        client.subscribe({ scope, cursors: [{ generation: 0, runId: runId("ahead"), afterSeq: seq(9) }] }).pipe(
          Stream.take(1)
        )
      )

      expect(reads[0]).toEqual([])
      expect(reads[1]).toEqual([{ generation: 0, runId: "ahead", afterSeq: 9 }])
    }))

  // The other direction of the same contract. A warm client cannot re-serve
  // history it has already acknowledged without breaking that promise for the
  // concurrent subscriptions sharing its map, so a BEHIND cursor is
  // fast-forwarded. Rebuilding a projection from zero is a fresh client, whose
  // acknowledged map is empty and which therefore honours the cursor exactly.
  it.effect("fast-forwards a behind cursor on a warm client but honours it on a fresh one", () =>
    Effect.gen(function*() {
      const warmReads: Array<SyncProtocol.WorkspaceCursor> = []
      const warm = yield* SyncClient.make({
        client: {
          "Sync.Read": (request: SyncProtocol.ReadRequest) => {
            warmReads.push(request.cursors)
            return Effect.succeed({
              entries: warmReads.length === 1
                ? [entry("rebuild", 0), entry("rebuild", 1)]
                : [entry("rebuild", 2)],
              cursors: [{ runId: runId("rebuild"), afterSeq: seq(warmReads.length === 1 ? 1 : 2), generation: 0 }],
              done: true
            })
          },
          "Sync.Subscribe": () => Stream.empty
        } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
      })
      const scope = { _tag: "Run", runId: runId("rebuild") } as const
      const behind = [{ generation: 0, runId: runId("rebuild"), afterSeq: seq(0) }]

      yield* Stream.runDrain(warm.subscribe({ scope, cursors: [] }).pipe(Stream.take(2)))
      yield* Stream.runDrain(warm.subscribe({ scope, cursors: behind }).pipe(Stream.take(1)))

      const freshReads: Array<SyncProtocol.WorkspaceCursor> = []
      const fresh = yield* SyncClient.make({
        client: {
          "Sync.Read": (request: SyncProtocol.ReadRequest) => {
            freshReads.push(request.cursors)
            return Effect.succeed({
              entries: [entry("rebuild", 1)],
              cursors: [{ runId: runId("rebuild"), afterSeq: seq(1), generation: 0 }],
              done: true
            })
          },
          "Sync.Subscribe": () => Stream.empty
        } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
      })
      yield* Stream.runDrain(fresh.subscribe({ scope, cursors: behind }).pipe(Stream.take(1)))

      expect(warmReads[1]).toEqual([{ generation: 0, runId: "rebuild", afterSeq: 1 }])
      expect(freshReads[0]).toEqual([{ generation: 0, runId: "rebuild", afterSeq: 0 }])
    }))
})
