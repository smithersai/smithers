import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as RunCatalog from "../src/RunCatalog.ts"
import * as SyncClient from "../src/SyncClient.ts"
import * as SyncPrincipal from "../src/SyncPrincipal.ts"
import * as SyncProtocol from "../src/SyncProtocol.ts"
import * as SyncServer from "../src/SyncServer.ts"
import * as TestSocket from "../src/test/TestSocket.ts"
import * as TestSync from "../src/test/TestSync.ts"

const runId = "wire-version" as JournalEvent.RunId
const scope = { _tag: "Run", runId } as const
const sourceId = "source" as JournalEvent.SourceId
const encoder = new TextEncoder()
const decoder = new TextDecoder()

describe("sync protocol compatibility over a socket", () => {
  for (const operation of ["Sync.Read", "Sync.Subscribe"]) {
    for (const version of [undefined, 999]) {
      it.live(`${operation} refuses protocol version ${version}`, () =>
        Effect.scoped(
          Effect.gen(function*() {
            const journal = yield* Journal.Journal
            yield* journal.emitDurableUnfenced({ runId, sourceId, eventType: "event", payload: null })
            const pair = yield* TestSocket.makePair()
            pair.faults.installFilter((bytes) =>
              encoder.encode(JSON.stringify(JSON.parse(decoder.decode(bytes)), (_key, value) => {
                if (value?.tag === operation && value.payload) {
                  return { ...value, payload: { ...value.payload, protocolVersion: version } }
                }
                return value
              }))
            )
            const server = yield* SyncServer.SyncServer
            const client = yield* TestSync.connect(pair).pipe(Effect.provideService(SyncServer.SyncServer, {
              ...server,
              read: operation === "Sync.Subscribe"
                ? () => Effect.succeed({ entries: [], cursors: [], done: true })
                : server.read
            }))
            const failure = yield* Effect.flip(
              client.subscribe({
                cursors: [],
                scope: { _tag: "Run", runId }
              }).pipe(Stream.take(1), Stream.runDrain)
            )
            expect(failure).toMatchObject({ code: "protocol_violation" })
            expect(yield* client.cursors).toEqual([])
          }).pipe(Effect.provide(TestSync.layerTest))
        ))
    }
  }

  for (const bootstrap of [true, false]) {
    it.live(`refuses missing generations in ${bootstrap ? "read pages" : "live frames"}`, () =>
      Effect.scoped(
        Effect.gen(function*() {
          const journal = yield* Journal.Journal
          yield* journal.emitDurableUnfenced({ runId, sourceId, eventType: "event", payload: null })
          const pair = yield* TestSocket.makePair()
          pair.faults.installFilter((bytes) =>
            encoder.encode(JSON.stringify(
              JSON.parse(decoder.decode(bytes)),
              (key, value) => key === "generation" ? undefined : value
            ))
          )
          const server = yield* SyncServer.SyncServer
          const client = yield* TestSync.connect(pair).pipe(Effect.provideService(SyncServer.SyncServer, {
            ...server,
            read: bootstrap ? server.read : () => Effect.succeed({ entries: [], cursors: [], done: true })
          }))
          const failure = yield* Effect.flip(
            client.subscribe({ cursors: [], scope: { _tag: "Run", runId } })
              .pipe(Stream.take(1), Stream.runDrain)
          )
          expect(failure).toMatchObject({ code: "protocol_violation" })
          expect(yield* client.cursors).toEqual([])
        }).pipe(Effect.provide(TestSync.layerTest))
      ))
  }
})

for (const bootstrap of [true, false]) {
  it.live(`accepts persisted generation-zero request cursors (${bootstrap ? "read" : "live"})`, () =>
    Effect.scoped(
      Effect.gen(function*() {
        const journal = yield* Journal.Journal
        for (let n = 0; n < 2; n++) {
          yield* journal.emitDurableUnfenced({ runId, sourceId, eventType: "event", payload: n })
        }
        const pair = yield* TestSocket.makePair()
        const server = yield* SyncServer.SyncServer
        const client = yield* TestSync.connect(pair).pipe(Effect.provideService(SyncServer.SyncServer, {
          ...server,
          read: bootstrap ? server.read : () => Effect.succeed({ entries: [], cursors: [], done: true })
        }))
        const options = {
          scope: { _tag: "Run", runId } as const,
          cursors: [{ runId, afterSeq: 0 as JournalEvent.Seq }]
        }
        const first = yield* client.subscribe(options).pipe(Stream.take(1), Stream.runCollect)
        expect(first.map((entry) => entry.seq)).toEqual([1])
        yield* journal.emitDurableUnfenced({ runId, sourceId, eventType: "event", payload: 2 })
        const second = yield* client.subscribe(options).pipe(Stream.take(1), Stream.runCollect)
        expect(second.map((entry) => entry.seq)).toEqual([2])
        expect(yield* client.cursors).toEqual([{ runId, afterSeq: 2, generation: 0 }])
      }).pipe(Effect.provide(TestSync.layerTest))
    ))
}

for (const generation of [0, 5]) {
  for (const rows of ["missing", "partially missing", "foreign-only", "duplicate"] as const) {
    it.effect(`refuses ${rows} read cursor rows at generation ${generation} before application`, () =>
      Effect.gen(function*() {
        const otherRun = "other-run" as JournalEvent.RunId
        const cursors = [otherRun, runId].map((runId) => ({
          runId,
          afterSeq: 5 as JournalEvent.Seq,
          generation
        }))
        const responseCursors = cursors.map((cursor) => ({ ...cursor, afterSeq: 6 as JournalEvent.Seq }))
        const entries = cursors.map(({ runId }) =>
          new JournalEvent.Entry({
            runId,
            seq: 6 as JournalEvent.Seq,
            eventId: `${runId}-6`,
            sourceId,
            sourceSeq: 6 as JournalEvent.SourceSeq,
            emittedAtMs: 6,
            eventType: "event",
            payload: null,
            meta: null
          })
        )
        let applications = 0
        let requested: SyncProtocol.WorkspaceCursor = []
        const client = yield* SyncClient.make({
          client: {
            "Sync.Read": (request: SyncProtocol.ReadRequest) => {
              requested = request.cursors
              return Effect.succeed({
                entries,
                cursors: rows === "missing" ?
                  []
                  : rows === "partially missing" ?
                  responseCursors.slice(0, 1)
                  : rows === "foreign-only"
                  ? [{ ...responseCursors[0]!, runId: "foreign" as JournalEvent.RunId }]
                  : [...responseCursors, responseCursors[0]!],
                done: true
              })
            },
            "Sync.Subscribe": () => Stream.never
          } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
        })
        const before = yield* client.progress
        const exit = yield* Effect.exit(
          client.subscribe({
            scope: { _tag: "Workspace" },
            cursors,
            apply: () =>
              Effect.sync(() => {
                applications++
              })
          }).pipe(Stream.take(2), Stream.runDrain)
        )
        expect(applications).toBe(0)
        expect(yield* client.progress).toEqual(before)
        expect(yield* client.cursors).toEqual([])
        expect(requested).toEqual(cursors)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error)
            .toMatchObject({ code: "protocol_violation" })
        }
      }))
  }
}

/**
 * One accepted version, one refusal code.
 *
 * Every case here is computed from `SyncProtocol.protocolVersion`, so a bump
 * that leaves a hard-coded number behind in a schema fails these tests rather
 * than shipping a path that speaks the old revision.
 */
describe("one protocol version", () => {
  const accepted = SyncProtocol.protocolVersion
  const request: SyncProtocol.SnapshotRequest = {
    protocolVersion: accepted,
    runId,
    lineageId: "lineage",
    projection: "counter",
    projectionVersion: 1,
    atLeastSeq: 0 as JournalEvent.Seq
  }

  it("decodes a mismatched request version so the refusal can be typed", () => {
    expect(Schema.is(SyncProtocol.SnapshotRequest)(request)).toBe(true)
    expect(Schema.is(SyncProtocol.SnapshotRequest)({ ...request, protocolVersion: accepted + 1 })).toBe(true)
    expect(Schema.is(SyncProtocol.SnapshotRequest)({ ...request, protocolVersion: 1.5 })).toBe(false)
    expect(Schema.is(SyncProtocol.ReadRequest)({ protocolVersion: accepted + 1, scope, cursors: [], limit: 1 }))
      .toBe(true)
  })

  it.effect("answers protocol_violation on the read, subscribe and snapshot paths alike", () =>
    Effect.gen(function*() {
      const server = yield* SyncServer.makeLive.pipe(
        Effect.provide(Layer.merge(Journal.layerNoop(), RunCatalog.layerStatic([runId])))
      )
      const mismatch = { code: "protocol_violation", cause: "protocol_version_mismatch" }
      const version = accepted + 1
      expect(yield* Effect.flip(server.read({ protocolVersion: version, scope, cursors: [], limit: 1 })))
        .toMatchObject(mismatch)
      expect(
        yield* Effect.flip(
          server.subscribe({ protocolVersion: version, scope, cursors: [], credit: 1 }).pipe(Stream.runDrain)
        )
      ).toMatchObject(mismatch)
      expect(yield* Effect.flip(server.snapshot({ ...request, protocolVersion: version })))
        .toMatchObject(mismatch)
    }).pipe(Effect.provideService(SyncPrincipal.SyncPrincipal, SyncPrincipal.workspace("versions"))))
})
