import { expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Effect, Layer, Stream } from "effect"
import * as RunCatalog from "../src/RunCatalog.ts"
import * as SyncClient from "../src/SyncClient.ts"
import * as SyncPrincipal from "../src/SyncPrincipal.ts"
import * as SyncServer from "../src/SyncServer.ts"

const runId = "non-json" as JournalEvent.RunId
const scope = { _tag: "Run", runId } as const
const entry = (seq: number, payload: unknown) =>
  new JournalEvent.Entry({
    runId,
    seq: seq as JournalEvent.Seq,
    eventId: `entry-${seq}`,
    sourceId: "source" as JournalEvent.SourceId,
    sourceSeq: seq as JournalEvent.SourceSeq,
    emittedAtMs: 0,
    eventType: "extension",
    payload,
    meta: null
  })
const cycle: Record<string, unknown> = {}
cycle.self = cycle
for (const [label, payload] of [["cycle", cycle], ["bigint", 1n], ["function", () => 1]] as const) {
  for (const path of ["client bootstrap", "client live", "server read", "server run live", "server workspace live"]) {
    it.effect(`refuses a ${label} as malformed with its cause before any ${path} delivery`, () =>
      Effect.gen(function*() {
        const entries = [entry(0, "valid"), entry(1, payload)]
        let delivered = 0
        const server = yield* SyncServer.makeLive.pipe(Effect.provide(Layer.mergeAll(
          Journal.layerNoop({
            entries: () => Effect.succeed({ entries, hasMore: false }),
            stream: () => Stream.fromIterable(entries)
          }),
          RunCatalog.layerStatic([runId])
        )))
        const client = yield* SyncClient.make({
          client: {
            "Sync.Read": () =>
              Effect.succeed({ entries: path === "client live" ? [] : entries, cursors: [], done: true }),
            "Sync.Subscribe": () =>
              Stream.succeed({ generation: 0, _tag: "Entries", runId, fromSeq: 0, toSeq: 1, entries })
          } as unknown as Parameters<typeof SyncClient.make>[0]["client"]
        })
        const failed = path === "server read" ?
          server.read({ protocolVersion: 1, scope, cursors: [], limit: 2 })
          : path.startsWith("server") ?
          server.subscribe({
            protocolVersion: 1,
            scope: path === "server run live" ? scope : { _tag: "Workspace" },
            cursors: [],
            credit: 2
          })
            .pipe(
              Stream.tap(() =>
                Effect.sync(() => {
                  delivered++
                })
              ),
              Stream.runDrain
            )
          : client.subscribe({
            scope,
            cursors: [],
            apply: () =>
              Effect.sync(() => {
                delivered++
              })
          }).pipe(Stream.take(2), Stream.runDrain)
        const error = yield* Effect.flip(failed.pipe(Effect.provide(SyncPrincipal.layerWorkspace("non-json"))))
        expect(error).toMatchObject({ code: "decode_failed", cause: expect.any(String) })
        expect(delivered).toBe(0)
        expect((yield* client.progress).delivered).toEqual([])
        expect((yield* client.progress).applied).toEqual([])
      }))
  }
}
