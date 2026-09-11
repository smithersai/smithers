/**
 * Liveness of the bounded workspace fan-out.
 *
 * `ServerSoak` proves the fan-out bound holds. It cannot prove the bound still
 * serves the workspace, because its journal fixture ends every run stream as
 * soon as the run's entries are exhausted. A real journal stream is
 * replay-then-follow: it never ends. A bound that fills its slots with streams
 * that never end therefore serves only the first `concurrency` runs and
 * starves every run behind them, on the covered branch and on the announced
 * branch alike. These cases pin the property the bound must not cost: every
 * covered run is served, and a run announced after the subscription attached
 * is served, when the workspace is larger than the bound.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Effect, Fiber, Layer, Option, Stream } from "effect"
import * as RunCatalog from "../src/RunCatalog.ts"
import * as SyncPrincipal from "../src/SyncPrincipal.ts"
import * as SyncProtocol from "../src/SyncProtocol.ts"
import * as SyncServer from "../src/SyncServer.ts"
import { entry } from "./fixtures/entry.ts"

const runId = (value: string) => value as JournalEvent.RunId
const sourceId = (value: string) => value as JournalEvent.SourceId
const seq = (value: number) => value as JournalEvent.Seq
const sourceSeq = (value: number) => value as JournalEvent.SourceSeq

/**
 * A journal shaped like the real one: a run stream replays what is there and
 * then follows forever. `Stream.never` is what `SqlJournal.stream`'s live tail
 * is to a consumer that reads to the end of the durable log.
 */
const followingJournal = (byRun: Record<string, ReadonlyArray<JournalEvent.Entry>>) =>
  Journal.layerNoop({
    entries: ({ after, limit, runId: id }: any) => {
      const all = (byRun[id] ?? []).filter((value) => after === undefined || value.seq > after)
      const page = all.slice(0, limit)
      return Effect.succeed({ entries: page, hasMore: page.length < all.length })
    },
    stream: ({ afterSequence, runId: id }: any) =>
      Stream.concat(
        Stream.fromIterable(
          (byRun[id] ?? []).filter((value) => afterSequence === undefined || value.seq > afterSequence)
        ),
        Stream.never
      )
  } as any)

const workspace = (runs: number) => {
  const byRun: Record<string, ReadonlyArray<JournalEvent.Entry>> = {}
  const ids: Array<JournalEvent.RunId> = []
  for (let run = 0; run < runs; run++) {
    const id = `run-${run}`
    byRun[id] = [entry(id, 0)]
    ids.push(runId(id))
  }
  return { byRun, ids }
}

/**
 * Records the runs a subscription serves as it serves them, so a subscription
 * that never completes still says which runs it starved.
 */
const recorder = () => {
  const seen: Array<string> = []
  const record = (frame: SyncProtocol.Frame) =>
    Effect.sync(() => {
      if (frame._tag === "Entries") seen.push(frame.runId as string)
    })
  return { seen, record }
}

describe("SyncServer bounded fan-out liveness", () => {
  it.live("serves every covered run when the workspace is larger than the fan-out bound", () =>
    Effect.gen(function*() {
      const { byRun, ids } = workspace(3)
      const { record, seen } = recorder()
      const settled = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLiveWith({ concurrency: 2 })
          return yield* Stream.runDrain(
            server.subscribe({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], credit: 3 }).pipe(
              Stream.tap(record)
            )
          )
        }).pipe(
          Effect.provide(Layer.mergeAll(
            followingJournal(byRun),
            RunCatalog.layerStatic(ids),
            SyncPrincipal.layerWorkspace("fan-out-suite")
          )),
          Effect.scoped,
          // A subscription that starves a run also never completes, because a
          // real run stream never ends: bound the wait rather than hang the
          // gate, and report what it did serve.
          Effect.timeoutOption("10 seconds")
        )
      )

      expect(seen.sort()).toEqual(["run-0", "run-1", "run-2"])
      expect(Option.isSome(settled)).toBe(true)
    }))

  it.live("serves every covered run over the real journal when the workspace is larger than the bound", () =>
    Effect.gen(function*() {
      const { ids } = workspace(3)
      const { record, seen } = recorder()
      const database = Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename: ":memory:" }))
      const journal = SqlJournal.layer({ capacity: 64, overflow: "reject" }).pipe(
        Layer.provide(Layer.provideMerge(JournalMigrations.layer, database))
      )
      const settled = yield* (
        Effect.gen(function*() {
          const durable = yield* Journal.Journal
          for (const id of ids) {
            yield* durable.emitDurableUnfenced(
              new JournalEvent.Input({
                runId: id,
                sourceId: sourceId("source"),
                eventType: "created",
                payload: { id }
              }, { disableChecks: true })
            )
          }
          const server = yield* SyncServer.makeLiveWith({ concurrency: 2 })
          return yield* Stream.runDrain(
            server.subscribe({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], credit: 3 }).pipe(
              Stream.tap(record)
            )
          )
        }).pipe(
          Effect.provide(Layer.mergeAll(
            journal,
            RunCatalog.layerStatic(ids),
            SyncPrincipal.layerWorkspace("fan-out-suite")
          )),
          Effect.scoped,
          Effect.timeoutOption("10 seconds")
        )
      )

      expect(seen.sort()).toEqual(["run-0", "run-1", "run-2"])
      expect(Option.isSome(settled)).toBe(true)
    }))

  it.live("serves an entry appended to every covered run after the subscription attached", () =>
    Effect.gen(function*() {
      // Every case above has its entries in place before `subscribe`, so the
      // first round serves them and the live path is never exercised. This is
      // the live path: more covered runs than the fan-out bound, over the real
      // journal, and every run gains an entry AFTER the follower attached. A
      // bound that fills its slots with the first `concurrency` runs serves no
      // run's live entry at all; a round that visits every run serves all of
      // them, on the round after the append.
      const runs = 5
      const concurrency = 2
      const { ids } = workspace(runs)
      const { record, seen } = recorder()
      // What the first round served, read from outside the subscription: a
      // starved subscription never completes, and the counts still have to
      // name the runs it served rather than time out with nothing to say.
      let replayed = 0
      const database = Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename: ":memory:" }))
      const journal = SqlJournal.layer({ capacity: 64, overflow: "reject" }).pipe(
        Layer.provide(Layer.provideMerge(JournalMigrations.layer, database))
      )
      const append = (durable: Journal.Service, id: JournalEvent.RunId, eventType: string) =>
        durable.emitDurableUnfenced(
          new JournalEvent.Input({ runId: id, sourceId: sourceId("source"), eventType, payload: { id } }, {
            disableChecks: true
          })
        )
      const settled = yield* (
        Effect.gen(function*() {
          const durable = yield* Journal.Journal
          for (const id of ids) yield* append(durable, id, "created")
          const server = yield* SyncServer.makeLiveWith({ concurrency, tailIntervalMs: 25 })
          const follower = yield* Effect.forkChild(
            Stream.runDrain(
              server.subscribe({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], credit: runs * 2 })
                .pipe(
                  Stream.tap(record)
                )
            ),
            { startImmediately: true }
          )
          // The first round has to have served every seeded run before the
          // live appends, or the test cannot tell a live entry from a replayed
          // one.
          yield* Effect.sleep("10 millis").pipe(
            Effect.repeat({ until: () => seen.length >= runs, times: 200 })
          )
          replayed = seen.length
          for (const id of ids) yield* append(durable, id, "live")
          return yield* Fiber.join(follower)
        }).pipe(
          Effect.provide(Layer.mergeAll(
            journal,
            RunCatalog.layerStatic(ids),
            SyncPrincipal.layerWorkspace("fan-out-suite")
          )),
          Effect.scoped,
          Effect.timeoutOption("10 seconds")
        )
      )

      // Every run was served twice: its seeded entry, then its live one.
      expect(seen.slice(0, runs).sort()).toEqual(["run-0", "run-1", "run-2", "run-3", "run-4"])
      expect(seen.slice(runs).sort()).toEqual(["run-0", "run-1", "run-2", "run-3", "run-4"])
      expect(replayed).toBe(runs)
      expect(Option.isSome(settled)).toBe(true)
    }))

  it.live("serves an entry committed in this process before the tail interval elapses", () =>
    Effect.gen(function*() {
      // The tail interval is the freshness policy for runs another process
      // owns, which reach this one only through the database. It must not also
      // be what a follower waits for an entry written beside it: the journal
      // publishes every committed entry on `Journal.changes`, so a workspace
      // subscription that covers the run is woken at once, exactly as a
      // run-scoped subscription is. The interval here is two hundred times the
      // budget, so arrival inside the budget cannot come from a tick.
      const runs = 5
      const tailIntervalMs = 5000
      const arrivalBudgetMs = 2000
      const { ids } = workspace(runs)
      const { record, seen } = recorder()
      let elapsed = Number.NaN
      const database = Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename: ":memory:" }))
      const journal = SqlJournal.layer({ capacity: 64, overflow: "reject" }).pipe(
        Layer.provide(Layer.provideMerge(JournalMigrations.layer, database))
      )
      const append = (durable: Journal.Service, id: JournalEvent.RunId, eventType: string) =>
        durable.emitDurableUnfenced(
          new JournalEvent.Input({ runId: id, sourceId: sourceId("source"), eventType, payload: { id } }, {
            disableChecks: true
          })
        )
      const live = yield* (
        Effect.gen(function*() {
          const durable = yield* Journal.Journal
          for (const id of ids) yield* append(durable, id, "created")
          const server = yield* SyncServer.makeLiveWith({ concurrency: 2, tailIntervalMs })
          const follower = yield* Effect.forkChild(
            Stream.runDrain(
              server.subscribe({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], credit: runs * 2 })
                .pipe(
                  Stream.tap(record)
                )
            ),
            { startImmediately: true }
          )
          // The seeded round has to be done, or the wait below would be
          // measuring the first round rather than the wake.
          yield* Effect.sleep("10 millis").pipe(
            Effect.repeat({ until: () => seen.length >= runs, times: 200 })
          )
          const startedAt = Date.now()
          for (const id of ids) yield* append(durable, id, "live")
          const joined = yield* Fiber.join(follower).pipe(Effect.timeoutOption(`${arrivalBudgetMs} millis`))
          elapsed = Date.now() - startedAt
          return joined
        }).pipe(
          Effect.provide(Layer.mergeAll(
            journal,
            RunCatalog.layerStatic(ids),
            SyncPrincipal.layerWorkspace("fan-out-suite")
          )),
          Effect.scoped
        )
      )

      expect(seen.slice(runs).sort()).toEqual(["run-0", "run-1", "run-2", "run-3", "run-4"])
      expect(Option.isSome(live)).toBe(true)
      expect(elapsed).toBeLessThan(tailIntervalMs)
    }))

  it.live("walks one run's backlog across pages inside a single round", () =>
    Effect.gen(function*() {
      // A run with more unserved entries than one page must not be served one
      // page per round: the tail walks it to its durable tail before the round
      // moves on, so a follower that reattaches to a busy run catches up in
      // one round rather than in one round per page.
      const backlog = Array.from({ length: 5 }, (_, index) => entry("busy", index))
      const { record, seen } = recorder()
      const settled = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLiveWith({ concurrency: 2 })
          return yield* Stream.runDrain(
            server.subscribe({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], credit: 5 }).pipe(
              Stream.tap(record)
            )
          )
        }).pipe(
          Effect.provide(Layer.mergeAll(
            // One entry per page, and the page says so.
            Journal.layerNoop({
              entries: ({ after }: any) => {
                const all = backlog.filter((value) => after === undefined || value.seq > after)
                return Effect.succeed({ entries: all.slice(0, 1), hasMore: all.length > 1 })
              }
            } as any),
            RunCatalog.layerStatic([runId("busy")]),
            SyncPrincipal.layerWorkspace("fan-out-suite")
          )),
          Effect.scoped,
          Effect.timeoutOption("10 seconds")
        )
      )

      expect(seen).toEqual(["busy", "busy", "busy", "busy", "busy"])
      expect(Option.isSome(settled)).toBe(true)
    }))

  it.live("ends a run's page walk on an empty page even when the journal claims more", () =>
    Effect.gen(function*() {
      // `hasMore` without an entry is a journal that cannot make progress. The
      // walk has to stop on the page, not on the claim, or one such run spins
      // a round forever and starves every run behind it.
      const { byRun } = workspace(1)
      const { record, seen } = recorder()
      const settled = yield* (
        Effect.gen(function*() {
          const server = yield* SyncServer.makeLiveWith({ concurrency: 2, tailIntervalMs: 25 })
          return yield* Stream.runDrain(
            server.subscribe({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], credit: 1 }).pipe(
              Stream.tap(record)
            )
          )
        }).pipe(
          Effect.provide(Layer.mergeAll(
            Journal.layerNoop({
              entries: ({ runId: id }: any) =>
                id === "stuck"
                  ? Effect.succeed({ entries: [], hasMore: true })
                  : Effect.succeed({ entries: byRun[id] ?? [], hasMore: false })
            } as any),
            RunCatalog.layerStatic([runId("stuck"), runId("run-0")]),
            SyncPrincipal.layerWorkspace("fan-out-suite")
          )),
          Effect.scoped,
          Effect.timeoutOption("10 seconds")
        )
      )

      expect(seen).toEqual(["run-0"])
      expect(Option.isSome(settled)).toBe(true)
    }))

  it.live("serves a re-announced run once, not once per announcement", () =>
    Effect.gen(function*() {
      // A catalog may announce a run the subscription already covers — a
      // second engine re-registering it, a catalog that re-lists on a failed
      // read. Serving it again would replay its whole log into the follower
      // and hold a second read open against the bound for it.
      const { byRun } = workspace(2)
      const { record, seen } = recorder()
      const settled = yield* (
        Effect.gen(function*() {
          // `list` is the authoritative run set and `changes` is a wake, so a
          // catalog registers a run before it announces it. This stub models
          // that ordering: the announcement is delivered only after the run is
          // listable, exactly as `makeMemory` and `makePolling` publish.
          const listed = new Set([runId("run-0")])
          const server = yield* SyncServer.makeLiveWith({ concurrency: 2, tailIntervalMs: 25 }).pipe(
            Effect.provideService(
              RunCatalog.RunCatalog,
              RunCatalog.RunCatalog.of({
                list: Effect.sync(() => Array.from(listed)),
                changes: Stream.tap(
                  Stream.make(runId("run-0"), runId("run-1")),
                  (announced) => Effect.sync(() => listed.add(announced))
                )
              })
            )
          )
          return yield* Stream.runDrain(
            server.subscribe({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], credit: 2 }).pipe(
              Stream.tap(record)
            )
          )
        }).pipe(
          Effect.provide(Layer.mergeAll(
            followingJournal(byRun),
            SyncPrincipal.layerWorkspace("fan-out-suite")
          )),
          Effect.scoped,
          Effect.timeoutOption("10 seconds")
        )
      )

      expect(seen.sort()).toEqual(["run-0", "run-1"])
      expect(Option.isSome(settled)).toBe(true)
    }))

  it.live("serves a run announced after the covered runs already filled the bound", () =>
    Effect.gen(function*() {
      const { byRun } = workspace(3)
      const { record, seen } = recorder()
      const settled = yield* (
        Effect.gen(function*() {
          const memory = yield* RunCatalog.makeMemory()
          const server = yield* SyncServer.makeLiveWith({ concurrency: 2 }).pipe(
            Effect.provideService(RunCatalog.RunCatalog, memory.catalog)
          )
          const follower = yield* Effect.forkChild(
            Stream.runDrain(
              server.subscribe({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], credit: 3 }).pipe(
                Stream.tap(record)
              )
            ),
            { startImmediately: true }
          )
          // Let the subscription attach to the announcement feed before the
          // workspace gains any run, so every run below arrives as a change.
          yield* Effect.sleep("50 millis")
          for (const id of Object.keys(byRun)) {
            yield* memory.register(runId(id))
            yield* Effect.sleep("50 millis")
          }
          return yield* Fiber.join(follower)
        }).pipe(
          Effect.provide(Layer.mergeAll(
            followingJournal(byRun),
            SyncPrincipal.layerWorkspace("fan-out-suite")
          )),
          Effect.scoped,
          Effect.timeoutOption("10 seconds")
        )
      )

      expect(seen.sort()).toEqual(["run-0", "run-1", "run-2"])
      expect(Option.isSome(settled)).toBe(true)
    }))
})
