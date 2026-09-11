/**
 * Workspace-scope paging, catalog fan-out, and journal failure mapping.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Effect, Exit, Fiber, Layer, Stream } from "effect"
import * as RunCatalog from "../src/RunCatalog.ts"
import { SyncError } from "../src/SyncError.ts"
import * as SyncPrincipal from "../src/SyncPrincipal.ts"
import * as SyncServer from "../src/SyncServer.ts"
import { entry } from "./fixtures/entry.ts"

const runId = (value: string) => value as JournalEvent.RunId
const sourceId = (value: string) => value as JournalEvent.SourceId
const seq = (value: number) => value as JournalEvent.Seq
const sourceSeq = (value: number) => value as JournalEvent.SourceSeq

const bigEntry = (id: JournalEvent.RunId, sequence: number, payload: string) => entry(id, sequence, { payload })

const journalOf = (byRun: Record<string, ReadonlyArray<JournalEvent.Entry>>) =>
  Journal.layerNoop({
    entries: ({ after, limit, runId: id }: any) => {
      const all = (byRun[id] ?? []).filter((value) => after === undefined || value.seq > after)
      const page = all.slice(0, limit)
      return Effect.succeed({ entries: page, hasMore: page.length < all.length })
    },
    stream: ({ afterSequence, runId: id }: any) =>
      Stream.fromIterable(
        (byRun[id] ?? []).filter((value) => afterSequence === undefined || value.seq > afterSequence)
      )
  } as any)

describe("SyncServer workspace scope", () => {
  it.effect("pages runs in a stable order and reports the durable tail", () =>
    Effect.gen(function*() {
      const response = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive
          return yield* server.read({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], limit: 10 })
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              journalOf({ b: [entry("b", 0)], a: [entry("a", 0), entry("a", 1)] }),
              RunCatalog.layerStatic([runId("b"), runId("a")]),
              SyncPrincipal.layerWorkspace("workspace-suite")
            )
          )
        )
      )

      expect(response.entries.map((value) => `${value.runId}:${value.seq}`)).toEqual(["a:0", "a:1", "b:0"])
      expect(response.cursors).toEqual([
        { generation: 0, runId: "a", afterSeq: 1 },
        { generation: 0, runId: "b", afterSeq: 0 }
      ])
      expect(response.done).toBe(true)
    }))

  it.effect("stops at the limit and reports that the page is not done", () =>
    Effect.gen(function*() {
      const response = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive
          return yield* server.read({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], limit: 2 })
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              journalOf({ a: [entry("a", 0), entry("a", 1), entry("a", 2)], b: [entry("b", 0)] }),
              RunCatalog.layerStatic([runId("a"), runId("b")]),
              SyncPrincipal.layerWorkspace("workspace-suite")
            )
          )
        )
      )

      // Each covered run takes a share of the budget before any run takes a
      // second helping, so a run with a backlog cannot spend the whole page on
      // itself and leave the runs behind it unserved.
      expect(response.entries.map((value) => `${value.runId}:${value.seq}`)).toEqual(["a:0", "b:0"])
      expect(response.done).toBe(false)
    }))

  it.effect("resumes each run from its supplied cursor and preserves untouched cursors", () =>
    Effect.gen(function*() {
      const response = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive
          return yield* server.read({
            protocolVersion: 1,
            scope: { _tag: "Workspace" },
            cursors: [
              { generation: 0, runId: runId("a"), afterSeq: seq(0) },
              { generation: 0, runId: runId("ghost"), afterSeq: seq(4) }
            ],
            limit: 10
          })
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              journalOf({ a: [entry("a", 0), entry("a", 1)] }),
              RunCatalog.layerStatic([runId("a")]),
              SyncPrincipal.layerWorkspace("workspace-suite")
            )
          )
        )
      )

      expect(response.entries.map((value) => value.seq)).toEqual([1])
      expect(response.cursors).toEqual([
        { generation: 0, runId: "a", afterSeq: 1 },
        { generation: 0, runId: "ghost", afterSeq: 4 }
      ])
    }))

  it.effect("maps a journal read failure to a sync error", () =>
    Effect.gen(function*() {
      const exit = yield* Effect.exit(
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive
          return yield* server.read({
            protocolVersion: 1,
            scope: { _tag: "Run", runId: runId("a") },
            cursors: [],
            limit: 10
          })
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({
                entries: (() => Effect.fail(new Error("disk gone"))) as any
              }),
              RunCatalog.layerNoop,
              SyncPrincipal.layerWorkspace("workspace-suite")
            )
          )
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error
        expect(failure).toBeInstanceOf(SyncError)
        // The host's own message never crosses the boundary; the run does.
        expect(failure).toMatchObject({ code: "unknown" })
        expect((failure as SyncError).message).toContain("Journal read failed for run")
        expect((failure as SyncError).message).not.toContain("disk gone")
      }
    }))

  it.effect("subscribes across every catalog run and honours the credit limit", () =>
    Effect.gen(function*() {
      const frames = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive
          return yield* Stream.runCollect(
            server.subscribe({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], credit: 3 })
          )
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              journalOf({ a: [entry("a", 0), entry("a", 1)], b: [entry("b", 0)] }),
              RunCatalog.layerStatic([runId("a"), runId("b")]),
              SyncPrincipal.layerWorkspace("workspace-suite")
            )
          )
        )
      )

      const collected = Array.from(frames)
      expect(collected).toHaveLength(3)
      expect(
        collected.map((frame) => frame._tag === "Entries" ? `${frame.runId}:${frame.toSeq}` : frame._tag).sort()
      ).toEqual(["a:0", "a:1", "b:0"])
    }))

  it.effect("picks up runs registered after the subscription started", () =>
    Effect.gen(function*() {
      const frames = yield* (
        Effect.gen(function*() {
          const memory = yield* RunCatalog.makeMemory()
          const server = yield* SyncServer.makeLive.pipe(
            Effect.provideService(RunCatalog.RunCatalog, memory.catalog)
          )
          const fiber = yield* Effect.forkChild(
            Stream.runCollect(
              server.subscribe({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], credit: 1 })
            ),
            { startImmediately: true }
          )
          // let the subscription attach to the catalog change feed first
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          yield* Effect.yieldNow
          yield* memory.register(runId("late"))
          return yield* Effect.exit(Fiber.join(fiber))
        }).pipe(
          Effect.provide(journalOf({ late: [entry("late", 0)] })),
          Effect.provide(SyncPrincipal.layerWorkspace("workspace-suite")),
          Effect.scoped
        )
      )

      expect(Exit.isSuccess(frames)).toBe(true)
      if (Exit.isSuccess(frames)) {
        expect(Array.from(frames.value)).toMatchObject([{ generation: 0, _tag: "Entries", runId: "late", toSeq: 0 }])
      }
    }))

  it.effect("makeNoop reports an empty read and a closed subscription", () =>
    Effect.gen(function*() {
      const noop = SyncServer.makeNoop()
      expect(yield* (noop.read({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], limit: 1 })))
        .toEqual({ entries: [], cursors: [], done: true })
      const frames = yield* (
        Stream.runCollect(noop.subscribe({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], credit: 1 }))
      )
      expect(Array.from(frames)).toMatchObject([{ _tag: "Closed" }])
    }))
})

describe("RunCatalog", () => {
  it.effect("layerStatic deduplicates ids and never emits changes", () =>
    Effect.gen(function*() {
      const result = yield* (
        Effect.gen(function*() {
          const catalog = yield* RunCatalog.RunCatalog
          const ids = yield* catalog.list
          const changes = yield* Stream.runCollect(catalog.changes)
          return { ids, changes: Array.from(changes) }
        }).pipe(Effect.provide(RunCatalog.layerStatic([runId("a"), runId("a"), runId("b")])))
      )

      expect(result.ids).toEqual(["a", "b"])
      expect(result.changes).toEqual([])
    }))

  it.effect("makeMemory publishes each run exactly once", () =>
    Effect.gen(function*() {
      const result = yield* (
        Effect.gen(function*() {
          const memory = yield* RunCatalog.makeMemory()
          const fiber = yield* Effect.forkChild(
            Stream.runCollect(Stream.take(memory.catalog.changes, 2)),
            { startImmediately: true }
          )
          yield* memory.register(runId("one"))
          // a repeated registration must not publish a second change
          yield* memory.register(runId("one"))
          yield* memory.register(runId("two"))
          const changes = yield* Effect.exit(Fiber.join(fiber))
          return { changes, ids: yield* memory.catalog.list }
        }).pipe(Effect.scoped)
      )

      expect(result.ids).toEqual(["one", "two"])
      expect(Exit.isSuccess(result.changes)).toBe(true)
      if (Exit.isSuccess(result.changes)) {
        expect(Array.from(result.changes.value)).toEqual(["one", "two"])
      }
    }))

  it.effect("layerNoop lists no runs", () =>
    Effect.gen(function*() {
      const ids = yield* (
        Effect.flatMap(RunCatalog.RunCatalog, (catalog) => catalog.list).pipe(
          Effect.provide(RunCatalog.layerNoop)
        )
      )
      expect(ids).toEqual([])
    }))
  // A sustained producer on the FIRST run keeps `done` false forever, so a
  // bootstrapping follower pages that run and only that run: the runs behind
  // it were never delayed, they were never served at all. Reads fill in run
  // order, so the order is the fairness question, and calling this a catch-up
  // API does not answer it.
  it.effect("serves every covered run in one page when the first run always has more", () =>
    Effect.gen(function*() {
      const hot = runId("aaa-hot")
      const cold = runId("zzz-cold")
      const response = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLive
          return yield* server.read({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], limit: 8 })
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Journal.layerNoop({
                entries: ({ after, limit, runId: id }: any) => {
                  // The hot run is a producer that never runs dry: it always
                  // fills whatever page it is offered and always reports more.
                  const from = after === undefined ? 0 : after + 1
                  const page = id === hot
                    ? Array.from({ length: limit }, (_, index) => entry(id, from + index))
                    : [entry(id, 0)].filter((value) => value.seq >= from)
                  return Effect.succeed({ entries: page, hasMore: id === hot })
                }
              } as any),
              RunCatalog.layerStatic([hot, cold]),
              SyncPrincipal.layerWorkspace("fairness-suite")
            )
          )
        )
      )

      const ids = new Set(response.entries.map((value) => value.runId))
      expect(ids.has(cold)).toBe(true)
      expect(response.entries.length).toBeLessThanOrEqual(8)
      // The hot run still takes the larger share; what it must not take is
      // every slot.
      expect(ids.has(hot)).toBe(true)
      expect(response.done).toBe(false)
    }))
  // The page budget and the frame ceiling both stop the read MID-SHARE, with
  // covered runs still unvisited. Each stop has to end the whole read rather
  // than fall through to the next run, or the page would keep filling past
  // the ceiling it just refused for.
  it.effect("stops the whole read when the frame budget runs out inside the first run's share", () =>
    Effect.gen(function*() {
      const big = "y".repeat(4096)
      const first = runId("aaa-big")
      const second = runId("zzz-small")
      const response = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLiveWith({ maxFrameBytes: 6_000 })
          return yield* server.read({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], limit: 8 })
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              journalOf({
                "aaa-big": [bigEntry(first, 0, big), bigEntry(first, 1, big)],
                "zzz-small": [entry("zzz-small", 0)]
              }),
              RunCatalog.layerStatic([first, second]),
              SyncPrincipal.layerWorkspace("workspace-suite")
            )
          )
        )
      )

      expect(response.entries.map((value) => `${value.runId}:${value.seq}`)).toEqual(["aaa-big:0"])
      expect(response.done).toBe(false)
    }))

  it.effect("refuses the whole read when the first run carries an entry no page can hold", () =>
    Effect.gen(function*() {
      const first = runId("aaa-huge")
      const second = runId("zzz-small")
      const failure = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLiveWith({ maxFrameBytes: 512 })
          return yield* Effect.flip(
            server.read({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], limit: 8 })
          )
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              journalOf({
                "aaa-huge": [bigEntry(first, 0, "z".repeat(4096))],
                "zzz-small": [entry("zzz-small", 0)]
              }),
              RunCatalog.layerStatic([first, second]),
              SyncPrincipal.layerWorkspace("workspace-suite")
            )
          )
        )
      )

      expect(failure.code).toBe("frame_too_large")
    }))
})
