/**
 * The run catalog a workspace follower actually learns from.
 *
 * Every `RunCatalog` implementation was static (`layerStatic`, `layerNoop`) or
 * in-process (`makeMemory`, which only ever hears about runs the same process
 * registered). A follower composed against any of them subscribed once to the
 * runs that existed at that moment and never learned of another run again:
 * `changes` was `Stream.empty` for the static ones, and silent for anything a
 * second engine wrote to the same workspace. These cases pin the durable
 * shape: the catalog reads its workspace on an interval, announces what is
 * new exactly once, and keeps serving its last good view when a read fails.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import type { JournalEvent } from "@smthrs/journal"
import { Cause, Deferred, Effect, Exit, Fiber, Logger, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as RunCatalog from "../src/RunCatalog.ts"

const runId = (value: string) => value as JournalEvent.RunId

const intervalMs = 50

/** A workspace another process writes to, and the reads this one makes of it. */
const workspace = (initial: ReadonlyArray<string>) => {
  let ids: ReadonlyArray<string> = initial
  let failures = 0
  let reads = 0
  return {
    read: Effect.suspend(() => {
      reads += 1
      if (failures > 0) {
        failures -= 1
        return Effect.fail("read failed" as const)
      }
      return Effect.succeed(ids.map(runId))
    }),
    write: (...added: ReadonlyArray<string>) => {
      ids = [...ids, ...added]
    },
    collect: (removed: string) => {
      ids = ids.filter((id) => id !== removed)
    },
    failNext: (count: number) => {
      failures = count
    },
    get reads() {
      return reads
    }
  }
}

/** Attaches a follower to `changes` and waits until it is really subscribed. */
const follow = (catalog: RunCatalog.Service, take: number) =>
  Effect.gen(function*() {
    const attached = yield* Deferred.make<void>()
    const fiber = yield* Stream.runCollect(
      Stream.take(catalog.changes.pipe(Stream.onStart(Deferred.succeed(attached, undefined))), take)
    ).pipe(Effect.forkChild({ startImmediately: true }))
    yield* Deferred.await(attached)
    return fiber
  })

describe("polling run catalog", () => {
  it.effect("learns of a run another engine created after the follower attached", () =>
    Effect.gen(function*() {
      // A run that already exists, twice: the workspace read is a set, and a
      // catalog that announced a duplicate would open two streams for it.
      const source = workspace(["run-a", "run-a"])
      const catalog = yield* RunCatalog.makePolling({ read: source.read, intervalMs })

      // Primed at construction: a follower that subscribes before the first
      // tick already sees the workspace, without waiting an interval for it.
      expect(yield* catalog.list).toEqual([runId("run-a")])

      const follower = yield* follow(catalog, 1)
      // Three quiet intervals: a run is announced when it appears, not on
      // every pass over it.
      yield* TestClock.adjust(intervalMs * 3)
      source.write("run-b")
      yield* TestClock.adjust(intervalMs)

      expect(Array.from(yield* Fiber.join(follower))).toEqual([runId("run-b")])
      expect(yield* catalog.list).toEqual([runId("run-a"), runId("run-b")])
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())))

  it.effect("keeps its view and keeps polling when one read fails", () =>
    Effect.gen(function*() {
      const source = workspace(["run-a"])
      const catalog = yield* RunCatalog.makePolling({ read: source.read, intervalMs })
      const follower = yield* follow(catalog, 1)

      // A workspace whose database is momentarily unreadable must not tear
      // down every subscription attached to it.
      source.failNext(1)
      source.write("run-b")
      yield* TestClock.adjust(intervalMs)
      expect(yield* catalog.list).toEqual([runId("run-a")])

      yield* TestClock.adjust(intervalMs)
      expect(Array.from(yield* Fiber.join(follower))).toEqual([runId("run-b")])
      expect(yield* catalog.list).toEqual([runId("run-a"), runId("run-b")])
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())))

  // With the default one-second interval an unreadable workspace database
  // produced one identical warning per second per catalog for the length of
  // the outage. The log now follows the transitions: the first failure with
  // its cause, silence while the outage lasts, and one line when a read
  // succeeds again. The poll cadence is unchanged.
  it.effect("logs an outage when it starts and when it ends, not on every failed poll", () =>
    Effect.gen(function*() {
      const logs: Array<{ level: string; message: unknown; cause: Cause.Cause<unknown> }> = []
      const capture = Logger.make((options) => {
        logs.push({ level: options.logLevel, message: options.message, cause: options.cause })
      })
      const source = workspace(["run-a"])
      const catalog = yield* RunCatalog.makePolling({ read: source.read, intervalMs }).pipe(
        Effect.provide(Logger.layer([capture]))
      )
      const readsBefore = source.reads

      source.failNext(5)
      yield* TestClock.adjust(intervalMs * 5)
      expect(source.reads - readsBefore).toBe(5)
      expect(logs.map((log) => log.level)).toEqual(["Warn"])
      expect(Cause.pretty(logs[0]!.cause)).toContain("read failed")

      source.write("run-b")
      yield* TestClock.adjust(intervalMs * 3)
      expect(yield* catalog.list).toEqual([runId("run-a"), runId("run-b")])
      expect(logs.map((log) => log.level)).toEqual(["Warn", "Info"])
      expect(String(logs[1]!.message)).toContain("5")

      // A second outage is a new transition, and is logged again.
      source.failNext(1)
      yield* TestClock.adjust(intervalMs * 2)
      expect(logs.map((log) => log.level)).toEqual(["Warn", "Info", "Warn", "Info"])
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())))

  it.effect("drops a run retention collected", () =>
    Effect.gen(function*() {
      const source = workspace(["run-a", "run-b"])
      const catalog = yield* RunCatalog.makePolling({ read: source.read, intervalMs, changesCapacity: 8 })

      source.collect("run-a")
      yield* TestClock.adjust(intervalMs)

      // The catalog is the workspace's run set, not an append-only log of
      // every run it ever had: a collected run stops being followable.
      expect(yield* catalog.list).toEqual([runId("run-b")])
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())))

  it.effect("polls on the default interval", () =>
    Effect.gen(function*() {
      const source = workspace([])
      const catalog = yield* RunCatalog.makePolling({ read: source.read })

      source.write("run-a")
      yield* TestClock.adjust(RunCatalog.defaultPollIntervalMs)

      expect(yield* catalog.list).toEqual([runId("run-a")])
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())))

  it.effect("fails at construction when the workspace cannot be read at all", () =>
    Effect.gen(function*() {
      // A composition that cannot read its own runs serves an empty workspace
      // to every follower. That fails loudly at build time instead.
      const exit = yield* Effect.exit(
        Effect.scoped(RunCatalog.makePolling({ read: Effect.fail("no database" as const) }))
      )

      expect(exit).toStrictEqual(Exit.fail("no database"))
    }))

  it.effect("stops polling when its scope closes", () =>
    Effect.gen(function*() {
      const source = workspace([])
      yield* Effect.scoped(
        Effect.gen(function*() {
          yield* RunCatalog.makePolling({ read: source.read, intervalMs })
          yield* TestClock.adjust(intervalMs)
        })
      )
      const afterClose = source.reads

      yield* TestClock.adjust(intervalMs * 5)

      expect(source.reads).toBe(afterClose)
    }).pipe(Effect.provide(TestClock.layer())))

  // `list` is typed `ReadonlyArray`, which TypeScript enforces and JavaScript
  // does not. `SyncServer` sorts what it receives and a host may keep it, so a
  // shared instance let one reader reorder or truncate the authoritative run
  // set under the poll fiber that owns it, and under every other reader.
  it.effect("answers each read with a fresh array, in every implementation", () =>
    Effect.gen(function*() {
      const source = workspace(["run-a", "run-b"])
      const polling = yield* RunCatalog.makePolling({ read: source.read, intervalMs })
      const memory = yield* RunCatalog.makeMemory()
      yield* memory.register(runId("run-a"))
      yield* memory.register(runId("run-b"))
      const statics = yield* Effect.provide(
        Effect.service(RunCatalog.RunCatalog),
        RunCatalog.layerStatic([runId("run-a"), runId("run-b")])
      )

      for (const catalog of [polling, memory.catalog, statics]) {
        const first = yield* catalog.list
        ;(first as Array<JournalEvent.RunId>).length = 0
        expect(yield* catalog.list).toEqual([runId("run-a"), runId("run-b")])
      }
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())))

  it.effect("provides the catalog as a layer", () => {
    const source = workspace(["run-a"])
    return Effect.gen(function*() {
      const catalog = yield* RunCatalog.RunCatalog

      expect(yield* catalog.list).toEqual([runId("run-a")])
      source.write("run-b")
      yield* TestClock.adjust(intervalMs)
      expect(yield* catalog.list).toEqual([runId("run-a"), runId("run-b")])
    }).pipe(
      Effect.provide(RunCatalog.layerPolling({ read: source.read, intervalMs })),
      Effect.provide(TestClock.layer())
    )
  })
})
