/**
 * One run's entry that outgrows the frame ceiling stops that run and no other
 * (#4558).
 *
 * A workspace read and a workspace subscription merge many runs. Both used to
 * fail whole on the first entry no frame can carry: the cursors did not move,
 * `frame_too_large` is not retried, and the next read carried the same cursors
 * and failed identically, so one runaway entry wedged every follower of the
 * workspace on every run. These cases run over the real SQL journal. Its
 * entries are larger than the SERVER's ceiling here, which is what a row
 * written before the journal bounded its entries looks like to a server with
 * the default ceiling.
 *
 * @since 1.0.0
 */
import { describe, expect, it } from "@effect/vitest"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Journal, JournalEvent } from "@smthrs/journal"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Deferred, Effect, Exit, Fiber, Layer, Logger, Stream } from "effect"
import * as RunCatalog from "../src/RunCatalog.ts"
import { SyncError } from "../src/SyncError.ts"
import * as SyncPrincipal from "../src/SyncPrincipal.ts"
import * as SyncProtocol from "../src/SyncProtocol.ts"
import * as SyncServer from "../src/SyncServer.ts"

const runId = (value: string) => value as JournalEvent.RunId
const sourceId = (value: string) => value as JournalEvent.SourceId
const seq = (value: number) => value as JournalEvent.Seq

/** The server's ceiling in these cases; `huge` alone outgrows it. */
const maxFrameBytes = 2048
const huge = "SECRET-PAYLOAD-".repeat(400)

const prefixed = runId("a-prefix-then-huge")
const healthy = runId("b-healthy")
const blocked = runId("c-huge-first")
const runs = [prefixed, healthy, blocked]

const journal = (options: Partial<SqlJournal.SqlJournalOptions> = {}) =>
  SqlJournal.layer({ capacity: 64, overflow: "reject", ...options }).pipe(
    Layer.provide(Layer.provideMerge(
      JournalMigrations.layer,
      Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename: ":memory:" }))
    ))
  )

const append = (durable: Journal.Service, id: JournalEvent.RunId, payload: unknown) =>
  durable.emitDurableUnfenced(
    new JournalEvent.Input({ runId: id, sourceId: sourceId("source"), eventType: "event", payload }, {
      disableChecks: true
    })
  )

/**
 * `a-prefix-then-huge`: 0 small, 1 huge, 2 small. `b-healthy`: 0 and 1 small.
 * `c-huge-first`: 0 huge.
 */
const seed = Effect.gen(function*() {
  const durable = yield* Journal.Journal
  yield* append(durable, prefixed, "a0")
  yield* append(durable, prefixed, huge)
  yield* append(durable, prefixed, "a2")
  yield* append(durable, healthy, "b0")
  yield* append(durable, healthy, "b1")
  yield* append(durable, blocked, huge)
  return durable
})

const services = Layer.mergeAll(
  journal(),
  RunCatalog.layerStatic(runs),
  SyncPrincipal.layerWorkspace("oversized-suite")
)

/** Every warning logged, as the message parts the server passed. */
const warnings = () => {
  const logged: Array<ReadonlyArray<unknown>> = []
  const layer = Logger.layer([
    Logger.make((options) => {
      if (options.logLevel === "Warn") logged.push(Array.isArray(options.message) ? options.message : [options.message])
    })
  ])
  return { logged, layer }
}

const keys = (entries: ReadonlyArray<JournalEvent.Entry>) => entries.map((value) => `${value.runId}:${value.seq}`)

const workspaceRead = (server: SyncServer.Service, cursors: SyncProtocol.WorkspaceCursor = [], limit = 16) =>
  server.read({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors, limit })

describe("SyncServer with one run holding an entry no frame can carry", () => {
  it.live("a workspace read keeps the healthy runs' entries and stops each oversized run below its entry", () =>
    Effect.gen(function*() {
      const { layer, logged } = warnings()
      const { first, second } = yield* Effect.gen(function*() {
        yield* seed
        const server = yield* SyncServer.makeLiveWith({ maxFrameBytes })
        const first = yield* workspaceRead(server)
        // The follower's next read carries the cursors it was given. It used
        // to carry the same ones as before, and fail the same way, forever.
        const second = yield* workspaceRead(server, first.cursors)
        return { first, second }
      }).pipe(Effect.provide(services), Effect.provide(layer), Effect.scoped)

      expect(keys(first.entries)).toEqual([`${prefixed}:0`, `${healthy}:0`, `${healthy}:1`])
      // `c-huge-first` served nothing, so it has no cursor: its position is
      // still the one the follower asked from.
      expect(first.cursors).toEqual([
        { runId: prefixed, afterSeq: 0, generation: 0 },
        { runId: healthy, afterSeq: 1, generation: 0 }
      ])
      // Nothing a later page can serve is left, so the follower goes live.
      expect(first.done).toBe(true)
      expect(second.entries).toEqual([])
      expect(second.cursors).toEqual(first.cursors)
      expect(second.done).toBe(true)

      const withheld = logged.filter(([message]) =>
        message === "sync withheld a run whose next entry exceeds the frame ceiling"
      )
      // Each read records each run it withheld, in the order it visited them.
      const byRun = (left: unknown, right: unknown) =>
        (left as { runId: string }).runId.localeCompare((right as { runId: string }).runId)
      expect(withheld.map(([, facts]) => facts).sort(byRun)).toEqual([
        expect.objectContaining({ surface: "read", runId: prefixed, seq: 1, maxFrameBytes }),
        expect.objectContaining({ surface: "read", runId: prefixed, seq: 1, maxFrameBytes }),
        expect.objectContaining({ surface: "read", runId: blocked, seq: 0, maxFrameBytes }),
        expect.objectContaining({ surface: "read", runId: blocked, seq: 0, maxFrameBytes })
      ])
      for (const [, facts] of withheld) {
        expect((facts as { entryBytes: number }).entryBytes).toBeGreaterThan(maxFrameBytes)
      }
      // The record names the entry and never carries it.
      expect(JSON.stringify(logged)).not.toContain("SECRET-PAYLOAD")
    }))

  it.live("a run whose share ran out before its oversized entry does not hold the page open", () =>
    Effect.gen(function*() {
      const response = yield* Effect.gen(function*() {
        const durable = yield* Journal.Journal
        yield* append(durable, prefixed, "a0")
        yield* append(durable, prefixed, "a1")
        yield* append(durable, prefixed, huge)
        yield* append(durable, healthy, "b0")
        const server = yield* SyncServer.makeLiveWith({ maxFrameBytes })
        // Two runs and four slots: the first pass serves two entries of the
        // first run, which reports more, and the second pass meets the entry.
        return yield* workspaceRead(server, [], 4)
      }).pipe(
        Effect.provide(Layer.mergeAll(
          journal(),
          RunCatalog.layerStatic([prefixed, healthy]),
          SyncPrincipal.layerWorkspace("oversized-suite")
        )),
        Effect.scoped
      )

      expect(keys(response.entries)).toEqual([`${prefixed}:0`, `${prefixed}:1`, `${healthy}:0`])
      expect(response.cursors).toEqual([
        { runId: prefixed, afterSeq: 1, generation: 0 },
        { runId: healthy, afterSeq: 0, generation: 0 }
      ])
      expect(response.done).toBe(true)
    }))

  it.live("a healthy run that still has more keeps the page open beside a withheld one", () =>
    Effect.gen(function*() {
      const response = yield* Effect.gen(function*() {
        const durable = yield* Journal.Journal
        yield* append(durable, blocked, huge)
        for (let index = 0; index < 6; index++) yield* append(durable, healthy, `b${index}`)
        const server = yield* SyncServer.makeLiveWith({ maxFrameBytes })
        return yield* workspaceRead(server, [], 4)
      }).pipe(
        Effect.provide(Layer.mergeAll(
          journal(),
          RunCatalog.layerStatic([healthy, blocked]),
          SyncPrincipal.layerWorkspace("oversized-suite")
        )),
        Effect.scoped
      )

      expect(keys(response.entries)).toEqual([0, 1, 2, 3].map((index) => `${healthy}:${index}`))
      expect(response.done).toBe(false)
    }))

  it.live("a run-scoped read of the oversized run still fails frame_too_large", () =>
    Effect.gen(function*() {
      const { fromStart, fromPrefix, other } = yield* Effect.gen(function*() {
        yield* seed
        const server = yield* SyncServer.makeLiveWith({ maxFrameBytes })
        const read = (id: JournalEvent.RunId, cursors: SyncProtocol.WorkspaceCursor) =>
          server.read({ protocolVersion: 1, scope: { _tag: "Run", runId: id }, cursors, limit: 16 })
        return {
          fromStart: yield* Effect.flip(read(prefixed, [])),
          fromPrefix: yield* Effect.flip(read(prefixed, [{ runId: prefixed, afterSeq: seq(0) }])),
          other: yield* read(healthy, [])
        }
      }).pipe(Effect.provide(services), Effect.scoped)

      for (const failure of [fromStart, fromPrefix]) {
        expect(failure).toBeInstanceOf(SyncError)
        expect(failure.code).toBe("frame_too_large")
        expect(failure.message).toContain(`exceed the ${maxFrameBytes}-byte frame ceiling`)
      }
      expect(keys(other.entries)).toEqual([`${healthy}:0`, `${healthy}:1`])
    }))

  it.live("a workspace subscription keeps following the healthy runs and reads the oversized run once", () =>
    Effect.gen(function*() {
      const { layer, logged } = warnings()
      const reads = new Map<string, number>()
      const frames: Array<string> = []
      const replayed = yield* Deferred.make<void>()
      const exit = yield* Effect.gen(function*() {
        const durable = yield* seed
        // Counts the page reads the server makes, per run, over the real journal.
        const counted = Journal.Journal.of({
          ...durable,
          entries: (options) => {
            reads.set(options.runId, (reads.get(options.runId) ?? 0) + 1)
            return durable.entries(options)
          }
        })
        const server = yield* SyncServer.makeLiveWith({ maxFrameBytes, tailIntervalMs: 20 }).pipe(
          Effect.provideService(Journal.Journal, counted)
        )
        const follower = yield* Effect.forkChild(
          Stream.runDrain(
            server.subscribe({ protocolVersion: 1, scope: { _tag: "Workspace" }, cursors: [], credit: 5 }).pipe(
              Stream.tap((frame) =>
                Effect.suspend(() => {
                  if (frame._tag !== "Entries") return Effect.void
                  frames.push(`${frame.runId}:${frame.fromSeq}-${frame.toSeq}`)
                  return frames.length === 3 ? Deferred.succeed(replayed, undefined) : Effect.void
                })
              )
            )
          ),
          { startImmediately: true }
        )
        yield* Deferred.await(replayed)
        // Live entries on every run, the withheld ones included, across
        // several catalog-wide rounds.
        yield* append(durable, prefixed, "a3")
        yield* append(durable, blocked, "c1")
        yield* append(durable, healthy, "b2")
        yield* Effect.sleep("100 millis")
        yield* append(durable, healthy, "b3")
        return yield* Fiber.await(follower)
      }).pipe(Effect.provide(services), Effect.provide(layer), Effect.scoped, Effect.timeout("20 seconds"))

      // The subscription spent its five frames and ended; it did not fail.
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(frames.slice(0, 3).sort()).toEqual([`${prefixed}:0-0`, `${healthy}:0-0`, `${healthy}:1-1`])
      expect(frames.slice(3)).toEqual([`${healthy}:2-2`, `${healthy}:3-3`])
      // Neither withheld run is read again, whatever is appended to it.
      expect(reads.get(prefixed)).toBe(1)
      expect(reads.get(blocked)).toBe(1)
      expect(reads.get(healthy)).toBeGreaterThan(1)
      const withheld = logged.filter(([message]) =>
        message === "sync withheld a run whose next entry exceeds the frame ceiling"
      ).map(([, facts]) => facts as { runId: string })
      expect(withheld.sort((left, right) => left.runId.localeCompare(right.runId))).toEqual([
        expect.objectContaining({ surface: "subscription", runId: prefixed, seq: 1, maxFrameBytes }),
        expect.objectContaining({ surface: "subscription", runId: blocked, seq: 0, maxFrameBytes })
      ])
      expect(JSON.stringify(logged)).not.toContain("SECRET-PAYLOAD")
    }))

  it.live("a run-scoped subscription to the oversized run still fails frame_too_large after its prefix", () =>
    Effect.gen(function*() {
      const frames: Array<string> = []
      const exit = yield* Effect.gen(function*() {
        yield* seed
        const server = yield* SyncServer.makeLiveWith({ maxFrameBytes })
        return yield* Effect.exit(Stream.runDrain(
          server.subscribe({ protocolVersion: 1, scope: { _tag: "Run", runId: prefixed }, cursors: [], credit: 8 })
            .pipe(Stream.tap((frame) =>
              Effect.sync(() => {
                if (frame._tag === "Entries") frames.push(`${frame.runId}:${frame.toSeq}`)
              })
            ))
        ))
      }).pipe(Effect.provide(services), Effect.scoped, Effect.timeout("20 seconds"))

      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("frame_too_large")
      expect(frames).toEqual([])
    }))
})

describe("the journal's default entry bound and the sync frame ceiling", () => {
  it.live("an entry at the journal's default bound, with the longest envelope, fits a default frame", () =>
    Effect.gen(function*() {
      // U+0001 is the widest a character of an identifier encodes to: six
      // bytes of `\u0001` in JSON text.
      const widest = "\u0001".repeat(JournalEvent.maxIdentifierLength)
      const id = runId(widest)
      const { atBound, over, served } = yield* Effect.gen(function*() {
        const durable = yield* Journal.Journal
        const input = (blob: string) =>
          new JournalEvent.Input({
            runId: id,
            sourceId: sourceId(widest),
            eventType: widest,
            // `{"blob":""}` is 11 bytes around the string and a `null` meta is 4.
            payload: { blob },
            meta: null
          })
        const fits = "x".repeat(SqlJournal.defaultMaxEntryBytes - 15)
        const over = yield* Effect.flip(durable.emitDurableUnfenced(input(`${fits}x`)))
        yield* durable.emitDurableUnfenced(input(fits))
        const page = yield* durable.entries({ runId: id, limit: 1 })
        const server = yield* SyncServer.makeLive
        const served = yield* server.read({
          protocolVersion: 1,
          scope: { _tag: "Run", runId: id },
          cursors: [],
          limit: 2
        })
        return { atBound: page.entries[0]!, over, served }
      }).pipe(
        Effect.provide(Layer.mergeAll(
          journal(),
          RunCatalog.layerStatic([id]),
          SyncPrincipal.layerWorkspace("oversized-suite")
        )),
        Effect.scoped
      )

      expect(over.code).toBe("invalid_event")
      const bytes = SyncProtocol.encodedByteLength(atBound)
      expect(bytes).toBeGreaterThan(SqlJournal.defaultMaxEntryBytes)
      expect(bytes).toBeLessThanOrEqual(SyncProtocol.defaultMaxFrameBytes)
      expect(served.entries).toHaveLength(1)
      expect(served.done).toBe(true)
    }))
})
