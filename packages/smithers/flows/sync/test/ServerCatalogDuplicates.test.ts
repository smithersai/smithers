/**
 * What the server does with a host catalog that names one run twice.
 *
 * `RunCatalog.Service` is a host seam — `RunCatalog.make` takes any `list`
 * effect — and its type is `ReadonlyArray<RunId>`, which does not say the
 * array is a set. Every implementation in this package deduplicates, so a
 * duplicate only ever arrives from a consumer's own catalog, which is exactly
 * the dependency boundary the rest of this package defends at.
 *
 * A duplicate must cost nothing. Both fan-out paths key their served position
 * by run, so a run visited twice in one pass reads the same position twice and
 * serves the same entries twice: on the read path inside a single response,
 * and on the subscribe path as two concurrent tails emitting identical frames.
 * The shipped client filters entries at or below its cursor and survives; a
 * consumer applying frames directly double-applies every entry, which is the
 * same defect the bootstrap paging bug produced.
 *
 * @since 1.0.0-rc.0
 */
import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Effect, Layer, Stream } from "effect"
import * as RunCatalog from "../src/RunCatalog.ts"
import * as SyncPrincipal from "../src/SyncPrincipal.ts"
import type * as SyncProtocol from "../src/SyncProtocol.ts"
import * as SyncServer from "../src/SyncServer.ts"
import { entry } from "./fixtures/entry.ts"

const runId = (value: string) => value as JournalEvent.RunId

/**
 * A journal shaped like the real one: a run stream replays what is there and
 * then follows forever, so a duplicated run cannot be hidden by a stream that
 * politely ends.
 */
const followingJournal = (byRun: Record<string, ReadonlyArray<JournalEvent.Entry>>) =>
  Journal.layerNoop({
    entries: ({ after, limit, runId: id }: any) => {
      const all = (byRun[id] ?? []).filter((value) => after === undefined || value.seq > after)
      const page = all.slice(0, limit)
      // A real journal read suspends. A synchronous fixture lets one tail
      // finish and record its position before a concurrent tail of the same
      // run starts, which is the one interleaving that hides the defect.
      return Effect.map(Effect.yieldNow, () => ({ entries: page, hasMore: page.length < all.length }))
    },
    stream: ({ afterSequence, runId: id }: any) =>
      Stream.concat(
        Stream.fromIterable(
          (byRun[id] ?? []).filter((value) => afterSequence === undefined || value.seq > afterSequence)
        ),
        Stream.never
      )
  } as any)

/** A host catalog that names `duplicated` twice on every list. */
const duplicatingCatalog = (ids: ReadonlyArray<JournalEvent.RunId>) =>
  Layer.succeed(
    RunCatalog.RunCatalog,
    RunCatalog.RunCatalog.of({ list: Effect.succeed(ids), changes: Stream.empty })
  )

const byRun = { alpha: [entry("alpha", 0), entry("alpha", 1)], beta: [entry("beta", 0)] }
const duplicated = [runId("alpha"), runId("beta"), runId("alpha")]

describe("SyncServer against a catalog that repeats a run", () => {
  it.effect("serves each entry once in a read page", () =>
    Effect.gen(function*() {
      const response = yield* Effect.gen(function*() {
        const server = yield* SyncServer.makeLive
        return yield* server.read({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], limit: 10 })
      }).pipe(
        Effect.provide(Layer.mergeAll(
          followingJournal(byRun),
          duplicatingCatalog(duplicated),
          SyncPrincipal.layerWorkspace("duplicate-suite")
        ))
      )

      expect(response.entries.map((value) => `${value.runId}:${value.seq}`)).toEqual([
        "alpha:0",
        "alpha:1",
        "beta:0"
      ])
      expect(response.done).toBe(true)
    }))

  it.live("serves each entry once across one subscription", () =>
    Effect.gen(function*() {
      const seen: Array<string> = []
      yield* Effect.gen(function*() {
        const server = yield* SyncServer.makeLiveWith({ concurrency: 4 })
        return yield* Stream.runDrain(
          // The credit window is deliberately wider than the three entries
          // this workspace holds: a window that closes on the third frame
          // ends the subscription before the repeat is ever reached, which
          // reports the absence of a bound rather than the absence of a
          // duplicate.
          server.subscribe({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], credit: 16 }).pipe(
            Stream.tap((frame: SyncProtocol.Frame) =>
              Effect.sync(() => {
                if (frame._tag === "Entries") {
                  for (const value of frame.entries) seen.push(`${value.runId}:${value.seq}`)
                }
              })
            )
          )
        )
      }).pipe(
        Effect.provide(Layer.mergeAll(
          followingJournal(byRun),
          duplicatingCatalog(duplicated),
          SyncPrincipal.layerWorkspace("duplicate-suite")
        )),
        Effect.scoped,
        // A workspace follow never ends on its own, so the wait is what
        // bounds this case; what it served by then is the assertion.
        Effect.timeoutOption("5 seconds")
      )

      expect(seen.slice().sort()).toEqual(["alpha:0", "alpha:1", "beta:0"])
    }))
})
