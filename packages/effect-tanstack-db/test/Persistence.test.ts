import { createBrowserWASQLitePersistence } from "@tanstack/browser-db-sqlite-persistence"
import { Effect, Exit, Layer, Metric, Option, Schedule, Scope } from "effect"
import { describe, expect, test } from "vitest"
import { Collection, Persistence } from "../src/index.ts"
import { databaseFile, id, Note, note, persistenceOn, sqlite, withLogs } from "./fixtures.ts"

// Persisted collections against a real SQLite file in Node, through TanStack DB's own browser persistence: the host
// hands it a database whose `execute` runs on node:sqlite, as a tab hands it OPFS. Each program is its own scope, so
// closing one and opening the next is a reload.

const ownMetrics = () => Layer.succeed(Metric.MetricRegistry, new Map())

const program = <A, E>(path: string, effect: Effect.Effect<A, E, Persistence.Persistence | Scope.Scope>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(persistenceOn(path)), Effect.provide(ownMetrics())))

const notes = (collection: string) =>
  Collection.persisted({ id: collection, schema: Note, getKey: (row) => row.id, schemaVersion: 1 })

// A sync source that writes `rows` once started, and is ready only if `ready`: a network that answers, or doesn't.
const source = (rows: ReadonlyArray<Note>, ready: boolean) => ({
  sync: ({ begin, write, commit, markReady }: {
    readonly begin: () => void
    readonly write: (message: { readonly type: "insert"; readonly value: Note }) => void
    readonly commit: () => void
    readonly markReady: () => void
  }) => {
    if (rows.length > 0) {
      begin()
      for (const row of rows) write({ type: "insert", value: row })
      commit()
    }
    if (ready) markReady()
  }
})

const synced = (collection: string, rows: ReadonlyArray<Note>, ready: boolean, schemaVersion = 1) =>
  Collection.make(Note, { id: collection, getKey: (row: Note) => row.id, sync: source(rows, ready) } as never, {
    persist: { schemaVersion }
  }) as Effect.Effect<Collection.Collection<Note, string>, never, Scope.Scope | Persistence.Persistence>

const texts = (rows: ReadonlyArray<Note>) => rows.map(({ id, text }) => `${id}:${text}`).sort()

describe("a persisted collection", () => {
  test("keeps its rows for the next program, which restores them and records how long that took", async () => {
    const path = databaseFile()
    const collection = id("notes")
    await program(
      path,
      Effect.gen(function*() {
        const first = yield* notes(collection)
        yield* first.restored
        expect(yield* first.toArray).toEqual([])
        const written = yield* first.insert([note("a", 1), note("b", 2)])
        yield* written.persisted
      })
    )
    const [restored, recorded] = await program(
      path,
      Effect.gen(function*() {
        const second = yield* notes(collection)
        yield* second.restored
        yield* second.restored
        const rows = yield* second.toArray
        // The restore time is recorded in the scope's background, once restored: wait until it is.
        const count = yield* Metric.value(Metric.withAttributes(Persistence.restoreMs, { collection })).pipe(
          Effect.map(({ count }) => count),
          Effect.repeat({ until: (count) => count > 0, schedule: Schedule.spaced("5 millis"), times: 400 })
        )
        return [rows, count] as const
      })
    )
    expect(texts(restored)).toEqual(["a:a", "b:b"])
    expect(recorded).toBe(1)
  })

  test("a write the device couldn't store rolls back, logged by collection, operation and error name, and counted", async () => {
    const path = databaseFile()
    const collection = id("refused")
    const refusing = { now: false }
    const refusingLayer = Persistence.layer({
      open: () => {
        const database = sqlite(path)
        return {
          execute: <T>(sql: string, params?: ReadonlyArray<unknown>) =>
            refusing.now ? Promise.reject(new Error("SENTINEL disk full")) : database.execute<T>(sql, params),
          close: database.close
        }
      },
      make: (database) => createBrowserWASQLitePersistence({ database })
    })
    const { result, logs } = await withLogs(
      Effect.scoped(Effect.gen(function*() {
        const kept = yield* notes(collection)
        yield* kept.restored
        yield* Effect.flatMap(kept.insert(note("a", 1)), (written) => written.persisted)
        refusing.now = true
        const writes = [
          yield* kept.update("a", (row) => {
            row.n = 2
          }),
          yield* kept.delete("a"),
          yield* kept.insert(note("b", 3))
        ]
        for (const write of writes) yield* Effect.flip(write.persisted)
        const failures = (operation: string) =>
          Metric.value(Metric.withAttributes(Persistence.writeFailures, { collection, operation })).pipe(
            Effect.map(({ count }) => count),
            Effect.repeat({ until: (count) => count > 0, schedule: Schedule.spaced("5 millis"), times: 400 })
          )
        return {
          rows: texts(yield* kept.toArray),
          counted: [yield* failures("update"), yield* failures("delete"), yield* failures("insert")]
        }
      })).pipe(Effect.provide(refusingLayer), Effect.provide(ownMetrics()))
    )
    // Each write rolled back: the device has what it stored.
    expect(result).toEqual({ rows: ["a:a"], counted: [1, 1, 1] })
    const failed = logs.filter(({ message }) => (message as Array<unknown>)[0] === "persisted write failed")
    expect(failed.map(({ level, annotations }) => ({ level, ...annotations }))).toEqual(
      ["update", "delete", "insert"].map((operation) =>
        expect.objectContaining({ level: "Warn", collection, operation, error: expect.any(String) })
      )
    )
    expect(JSON.stringify(failed)).not.toContain("SENTINEL")
  })
})

describe("a synced collection made with persist", () => {
  test("restores what its source wrote before the source answers again", async () => {
    const path = databaseFile()
    const collection = id("synced")
    await program(
      path,
      Effect.gen(function*() {
        const online = yield* synced(collection, [note("a", 1), note("b", 2)], true)
        yield* online.preload
        expect(texts(yield* online.toArray)).toEqual(["a:a", "b:b"])
      })
    )
    const [rows, status] = await program(
      path,
      Effect.gen(function*() {
        // The source never answers: the rows come from the device, and the collection isn't ready.
        const offline = yield* synced(collection, [], false)
        yield* offline.restored
        // Already restored: at once.
        yield* offline.restored
        return [yield* offline.toArray, offline.tanstack.status] as const
      })
    )
    expect(texts(rows)).toEqual(["a:a", "b:b"])
    expect(status).not.toBe("ready")
  })

  test("drops what it kept under another schemaVersion", async () => {
    const path = databaseFile()
    const collection = id("versioned")
    await program(path, Effect.flatMap(synced(collection, [note("a", 1)], true), (online) => online.preload))
    const rows = await program(
      path,
      Effect.gen(function*() {
        const next = yield* synced(collection, [], false, 2)
        yield* next.restored
        return yield* next.toArray
      })
    )
    expect(rows).toEqual([])
  })

  test("fails restored with LoadFailed when the database can't be read", async () => {
    const broken = Persistence.layer({
      open: () => ({ execute: () => Promise.reject(new Error("disk")), close: () => undefined }),
      make: (database) => createBrowserWASQLitePersistence({ database })
    })
    const exit = await Effect.runPromiseExit(
      Effect.scoped(Effect.flatMap(synced(id("broken"), [], false), (collection) => collection.restored)).pipe(
        Effect.provide(broken),
        Effect.provide(ownMetrics())
      )
    )
    expect(Exit.isFailure(exit) && exit.cause.toString()).toContain("LoadFailed")
  })

  test("a restore that failed is logged by the collection's kind and the error's name, and counted", async () => {
    const broken = Persistence.layer({
      open: () => ({ execute: () => Promise.reject(new TypeError("SENTINEL disk")), close: () => undefined }),
      make: (database) => createBrowserWASQLitePersistence({ database })
    })
    const kind = id("broken")
    const { result, logs } = await withLogs(
      Effect.scoped(Effect.gen(function*() {
        // The id names a conversation after its kind; only the kind is recorded.
        yield* synced(`${kind}:conversation-1`, [], false)
        return yield* Metric.value(Metric.withAttributes(Persistence.restoreFailures, { collection: kind })).pipe(
          Effect.map(({ count }) => count),
          Effect.repeat({ until: (count) => count > 0, schedule: Schedule.spaced("5 millis"), times: 400 })
        )
      })).pipe(Effect.provide(broken), Effect.provide(ownMetrics()))
    )
    expect(result).toBe(1)
    const failed = logs.filter(({ message }) => (message as Array<unknown>)[0] === "persisted restore failed")
    expect(failed.map(({ level, annotations }) => ({ level, ...annotations }))).toEqual([
      { level: "Warn", collection: kind, error: expect.stringMatching(/^[A-Za-z]+$/) }
    ])
    expect(JSON.stringify(logs)).not.toContain("SENTINEL")
    expect(JSON.stringify(failed)).not.toContain("conversation-1")
  })
})

describe("without a database", () => {
  test("a database that can't open leaves rows in memory, logged and counted, and never fails", async () => {
    const unavailable = Persistence.layer({
      open: () => Promise.reject(new Error("no OPFS")),
      make: () => {
        throw new Error("never built")
      }
    })
    const { result, logs } = await withLogs(
      Effect.scoped(Effect.gen(function*() {
        const local = yield* notes(id("memory"))
        yield* local.insert(note("a", 1))
        const sync = yield* synced(id("memory-synced"), [note("b", 2)], true)
        yield* sync.restored
        return {
          local: texts(yield* local.toArray),
          sync: texts(yield* sync.toArray),
          counted: (yield* Metric.value(Persistence.unavailable)).count,
          persistence: (yield* Persistence.Persistence).persistence
        }
      })).pipe(Effect.provide(unavailable), Effect.provide(ownMetrics()))
    )
    expect(result).toEqual({ local: ["a:a"], sync: ["b:b"], counted: 1, persistence: Option.none() })
    expect(logs).toContainEqual(
      expect.objectContaining({
        message: ["persistence unavailable"],
        level: "Warn",
        // What `open` rejected with, by its name, never its message.
        annotations: { error: "Error" }
      })
    )
    expect(JSON.stringify(logs)).not.toContain("no OPFS")
  })

  test("memory keeps every persisted collection in memory", async () => {
    const rows = await Effect.runPromise(
      Effect.scoped(Effect.gen(function*() {
        const local = yield* notes(id("memory"))
        yield* local.insert(note("a", 1))
        return yield* local.toArray
      })).pipe(Effect.provide(Persistence.memory))
    )
    expect(texts(rows)).toEqual(["a:a"])
  })
})

describe("the layer", () => {
  test("disposes the coordinator, then closes the database, when it closes; a close that fails is ignored", async () => {
    const closed: Array<string> = []
    const path = databaseFile()
    const layer = (failClose: boolean) =>
      Persistence.layer({
        open: () => {
          const database = sqlite(path)
          return {
            execute: database.execute,
            close: () => {
              database.close()
              closed.push("database")
              if (failClose) throw new Error("close failed")
            }
          }
        },
        coordinator: () => ({ dispose: () => void closed.push("coordinator") }) as unknown as Persistence.Coordinator,
        make: (database) => createBrowserWASQLitePersistence({ database })
      })
    await Effect.runPromise(Effect.scoped(Layer.build(layer(false))))
    expect(closed).toEqual(["coordinator", "database"])
    const exit = await Effect.runPromiseExit(Effect.scoped(Layer.build(layer(true))))
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})
