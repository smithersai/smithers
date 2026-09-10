/**
 * The generation fence on the FAR side of a paged read.
 *
 * A rewind is not only something a stale cursor arrives with; it can land
 * while a page is being read. The near-side comparison cannot see that, and
 * the entries the journal then hands back belong to the replacement history
 * while the follower is still resuming the old one — so a page read before the
 * rewind and admitted after it would deliver the new lineage's sequences as if
 * they continued the old one, silently.
 *
 * Every suite here drives the far-side comparison alone: the near side sees a
 * generation that matches (or no expectation at all), and only the comparison
 * after the read can refuse. The paged read and the workspace tail share one
 * fenced read, so both are exercised.
 *
 * @since 1.0.0-rc.0
 */
import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Effect, Layer, Stream } from "effect"
import * as RunCatalog from "../src/RunCatalog.ts"
import * as SyncPrincipal from "../src/SyncPrincipal.ts"
import * as SyncServer from "../src/SyncServer.ts"

const runId = "fenced" as JournalEvent.RunId
const seq = (value: number) => value as JournalEvent.Seq

const entry = new JournalEvent.Entry({
  runId,
  seq: seq(0),
  eventId: "fenced-0",
  sourceId: "source" as JournalEvent.SourceId,
  sourceSeq: 0 as JournalEvent.SourceSeq,
  emittedAtMs: 0,
  eventType: "event",
  payload: 0,
  meta: null
})

/**
 * A journal that serves one entry and reports generation 0 to the comparison
 * before the read and generation 1 to the one after it, which is what a rewind
 * committed by another process between them looks like from here.
 */
const rewoundMidRead = () => {
  let comparisons = 0
  return Journal.makeNoop({
    generation: () => Effect.sync(() => ({ generation: comparisons++ === 0 ? 0 : 1, afterSeq: seq(-1) })),
    entries: () => Effect.succeed({ entries: [entry], hasMore: false })
  })
}

const stack = Layer.mergeAll(RunCatalog.layerStatic([runId]), SyncPrincipal.layerWorkspace("fence-suite"))

describe("a rewind between the page read and the comparison after it", () => {
  for (const scope of [{ _tag: "Run", runId }, { _tag: "Workspace" }] as const) {
    it.effect(`${scope._tag} reads refuse it and expose the archive boundary`, () =>
      Effect.scoped(
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive.pipe(
            Effect.provideService(Journal.Journal, rewoundMidRead())
          )
          const failure = yield* Effect.flip(
            server.read({ protocolVersion: 1, scope, cursors: [], limit: 10 })
          )
          expect(failure).toMatchObject({
            code: "lineage_changed",
            rewind: { runId, generation: 1, afterSeq: -1 }
          })
        }).pipe(Effect.provide(stack))
      ))
  }

  it.effect("a workspace tail refuses it rather than emitting the replacement history", () =>
    Effect.scoped(
      Effect.gen(function*() {
        const server = yield* SyncServer.makeLive.pipe(
          Effect.provideService(Journal.Journal, rewoundMidRead())
        )
        const frames: Array<string> = []
        const failure = yield* Effect.flip(
          server.subscribe({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], credit: 1 }).pipe(
            Stream.tap((frame) => Effect.sync(() => frames.push(frame._tag))),
            Stream.runDrain
          )
        )
        expect(failure).toMatchObject({
          code: "lineage_changed",
          rewind: { runId, generation: 1, afterSeq: -1 }
        })
        expect(frames).toEqual([])
      }).pipe(Effect.provide(stack))
    ))
})
