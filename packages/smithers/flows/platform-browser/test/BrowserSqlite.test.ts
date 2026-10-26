import { describe, expect, it } from "@effect/vitest"
import { affectedRows } from "@smthrs/database/DurableWriter"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as SqlClient from "effect/sql/SqlClient"
import * as Stream from "effect/Stream"
import { afterEach, beforeEach } from "vitest"
import { BrowserSqlite } from "../src/index.ts"
import * as MemoryOpfs from "./fixtures/MemoryOpfs.ts"
import * as MemorySqlite from "./fixtures/MemorySqlite.ts"

const sql = SqlClient.SqlClient

describe("BrowserSqlite.make", () => {
  it.effect("reads rows as objects and as arrays", () =>
    Effect.gen(function*() {
      const client = yield* sql
      yield* client`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)`
      yield* client`INSERT INTO t (id, name) VALUES (${1}, ${"a"}), (${2}, ${"b"})`
      expect(yield* client`SELECT id, name FROM t ORDER BY id`).toEqual([{ id: 1, name: "a" }, { id: 2, name: "b" }])
      expect(yield* client`SELECT id, name FROM t ORDER BY id`.values).toEqual([[1, "a"], [2, "b"]])
      expect(yield* client.unsafe("SELECT name FROM t WHERE id = ?", [2])).toEqual([{ name: "b" }])
    }).pipe(Effect.provide(MemorySqlite.layer)))

  it.effect("reports a write's changes through .raw, as DurableWriter.affectedRows reads them", () =>
    Effect.gen(function*() {
      const client = yield* sql
      yield* client`CREATE TABLE t (id INTEGER PRIMARY KEY)`
      yield* client`INSERT INTO t (id) VALUES (1), (2), (3)`
      const deleted = yield* client`DELETE FROM t WHERE id < 3`.raw
      expect(deleted).toEqual({ changes: 2 })
      expect(yield* affectedRows(deleted)).toBe(2)
      expect(yield* client`SELECT id FROM t`.raw).toEqual([{ id: 3 }])
    }).pipe(Effect.provide(MemorySqlite.layer)))

  it.effect("binds an integer wider than 32 bits as a SQLite integer", () =>
    Effect.gen(function*() {
      const client = yield* sql
      const epochMs = 1_760_000_000_000
      const [row] = yield* client<{ readonly kind: string; readonly value: number }>`
        SELECT typeof(${epochMs}) AS kind, ${epochMs} AS value`
      expect(row).toEqual({ kind: "integer", value: epochMs })
      const [fraction] = yield* client<{ readonly kind: string }>`SELECT typeof(${1.5}) AS kind`
      expect(fraction).toEqual({ kind: "real" })
    }).pipe(Effect.provide(MemorySqlite.layer)))

  it.effect("commits a transaction, and rolls back a failed one", () =>
    Effect.gen(function*() {
      const client = yield* sql
      yield* client`CREATE TABLE t (id INTEGER PRIMARY KEY)`
      yield* client.withTransaction(client`INSERT INTO t (id) VALUES (1)`)
      const failed = yield* client.withTransaction(
        client`INSERT INTO t (id) VALUES (2)`.pipe(Effect.andThen(Effect.fail("abandon" as const)))
      ).pipe(Effect.flip)
      expect(failed).toBe("abandon")
      expect(yield* client`SELECT id FROM t`).toEqual([{ id: 1 }])
    }).pipe(Effect.provide(MemorySqlite.layer)))

  it.effect("rolls back a transaction whose COMMIT fails, and lends the connection again", () =>
    Effect.gen(function*() {
      const client = yield* sql
      yield* client`PRAGMA foreign_keys = ON`
      yield* client`CREATE TABLE parent (id INTEGER PRIMARY KEY)`
      yield* client`CREATE TABLE child (parent INTEGER REFERENCES parent (id) DEFERRABLE INITIALLY DEFERRED)`
      const refused = yield* client.withTransaction(client`INSERT INTO child (parent) VALUES (9)`).pipe(Effect.flip)
      expect(refused._tag).toBe("SqlError")
      expect(yield* client`SELECT parent FROM child`).toEqual([])
      yield* client.withTransaction(client`INSERT INTO parent (id) VALUES (9)`)
      expect(yield* client`SELECT id FROM parent`).toEqual([{ id: 9 }])
    }).pipe(Effect.provide(MemorySqlite.layer)))

  it.effect("fails a statement SQLite refuses with a SqlError, and refuses to stream", () =>
    Effect.gen(function*() {
      const client = yield* sql
      const refused = yield* client`SELECT * FROM missing`.pipe(Effect.flip)
      expect(refused._tag).toBe("SqlError")
      expect(refused.message).toContain("Failed to execute statement")
      const streamed = yield* Stream.runCollect(client`SELECT 1`.stream).pipe(Effect.exit)
      expect(Exit.isFailure(streamed)).toBe(true)
    }).pipe(Effect.provide(MemorySqlite.layer)))
})

describe("BrowserSqlite over OPFS", () => {
  let remove: () => void = () => undefined
  beforeEach(() => {
    remove = MemoryOpfs.install()
  })
  afterEach(() => remove())

  const sqlite = (build: BrowserSqlite.Build = MemorySqlite.build) =>
    BrowserSqlite.layerSqlite({ build, directory: "smithers/test" })
  const database = (filename = "engine.db") => BrowserSqlite.layer({ filename }).pipe(Layer.provide(sqlite()))

  it.effect("keeps what it wrote after the database is closed and opened again", () =>
    Effect.gen(function*() {
      yield* Effect.gen(function*() {
        const client = yield* sql
        yield* client`CREATE TABLE t (id INTEGER PRIMARY KEY)`
        yield* client`INSERT INTO t (id) VALUES (7)`
      }).pipe(Effect.provide(database()))
      const rows = yield* Effect.flatMap(sql, (client) => client`SELECT id FROM t`).pipe(Effect.provide(database()))
      expect(rows).toEqual([{ id: 7 }])
    }))

  it.effect("journals in a write-ahead log under an exclusive lock, syncing the log at every commit", () =>
    Effect.gen(function*() {
      const client = yield* sql
      expect(yield* client`PRAGMA journal_mode`).toEqual([{ journal_mode: "wal" }])
      expect(yield* client`PRAGMA locking_mode`).toEqual([{ locking_mode: "exclusive" }])
      expect(yield* client`PRAGMA synchronous`).toEqual([{ synchronous: 2 }])
    }).pipe(Effect.provide(database())))

  it.effect("keeps every committed transaction through a power loss, syncing the log at each commit", () =>
    Effect.gen(function*() {
      // The worker's pool and a connection it never closes: a power loss takes the process and every unsynced write.
      const worker = yield* Scope.make()
      const pool = yield* Layer.buildWithScope(sqlite(), worker)
      const opened = yield* BrowserSqlite.open("engine.db").pipe(Effect.provideContext(pool), Scope.provide(yield* Scope.make()))
      const exec = (statements: string) => Effect.promise(() => opened.sqlite3.exec(opened.db, statements))
      yield* exec("CREATE TABLE t (id INTEGER PRIMARY KEY); INSERT INTO t (id) VALUES (7)")
      // A commit that skips the sync shows the power loss takes what wasn't synced.
      yield* exec("PRAGMA synchronous = OFF; INSERT INTO t (id) VALUES (8)")
      MemoryOpfs.loseUnflushed()
      yield* Scope.close(worker, Exit.void)
      const rows = yield* Effect.flatMap(sql, (client) => client`SELECT id FROM t`).pipe(Effect.provide(database()))
      expect(rows).toEqual([{ id: 7 }])
    }))

  it.effect("opens a database an earlier build left in a rollback journal, keeping its rows", () =>
    Effect.gen(function*() {
      const shared = yield* Layer.build(sqlite())
      const { sqlite3, vfs } = Context.get(shared, BrowserSqlite.Sqlite)
      // A VFS that isn't exclusive keeps SQLite's rollback journal, as every build before the write-ahead log did.
      const earlier = BrowserSqlite.layer({ filename: "app.db" }).pipe(
        Layer.provide(Layer.succeed(BrowserSqlite.Sqlite)({ sqlite3, vfs }))
      )
      yield* Effect.gen(function*() {
        const client = yield* sql
        yield* client`CREATE TABLE t (id INTEGER PRIMARY KEY)`
        yield* client`INSERT INTO t (id) VALUES (7)`
        expect(yield* client`PRAGMA journal_mode`).toEqual([{ journal_mode: "delete" }])
      }).pipe(Effect.provide(earlier))
      const now = BrowserSqlite.layer({ filename: "app.db" }).pipe(Layer.provide(Layer.succeedContext(shared)))
      yield* Effect.gen(function*() {
        const client = yield* sql
        expect(yield* client`PRAGMA journal_mode`).toEqual([{ journal_mode: "wal" }])
        expect(yield* client`SELECT id FROM t`).toEqual([{ id: 7 }])
      }).pipe(Effect.provide(now))
    }).pipe(Effect.scoped))

  it.effect("fails a database it can't journal, and closes it", () =>
    Effect.gen(function*() {
      const shared = yield* Layer.build(sqlite())
      const real = Context.get(shared, BrowserSqlite.Sqlite)
      let closed = 0
      // The build refuses the journal's statements as a full disk would.
      const faulty = BrowserSqlite.Sqlite.of({
        ...real,
        sqlite3: {
          ...real.sqlite3,
          statements: (db, statements, options) =>
            statements.startsWith("PRAGMA locking_mode")
              ? (async function*(): AsyncGenerator<number> {
                throw new Error("database or disk is full")
              })()
              : real.sqlite3.statements(db, statements, options),
          close: (db) => (closed++, real.sqlite3.close(db))
        }
      })
      const refused = yield* Layer.build(
        BrowserSqlite.layer({ filename: "engine.db" }).pipe(Layer.provide(Layer.succeed(BrowserSqlite.Sqlite)(faulty)))
      ).pipe(Effect.scoped, Effect.flip)
      expect(refused.message).toContain("Failed to journal database")
      expect(closed).toBe(1)
    }).pipe(Effect.scoped))

  it.effect("opens two databases on one build and one VFS, each with its own connection", () =>
    Effect.gen(function*() {
      const shared = yield* Layer.build(sqlite())
      const write = (filename: string, id: number) =>
        Effect.flatMap(sql, (client) =>
          client`CREATE TABLE t (id INTEGER)`.pipe(
            Effect.andThen(client`INSERT INTO t (id) VALUES (${id})`),
            Effect.andThen(client`SELECT id FROM t`)
          )).pipe(Effect.provide(BrowserSqlite.layer({ filename }).pipe(Layer.provide(Layer.succeedContext(shared)))))
      expect(yield* write("engine.db", 1)).toEqual([{ id: 1 }])
      expect(yield* write("collections.db", 2)).toEqual([{ id: 2 }])
    }).pipe(Effect.scoped))

  it.effect("opens two databases at once on one build, each with a handle of its own", () =>
    Effect.gen(function*() {
      // wa-sqlite hands each new handle back through one shared pointer.
      const [engine, app] = yield* Effect.all([BrowserSqlite.open("engine.db"), BrowserSqlite.open("app.db")], {
        concurrency: "unbounded"
      })
      expect(engine.db).not.toBe(app.db)
    }).pipe(Effect.scoped, Effect.provide(sqlite())))

  it.live("waits for a worker that still holds the files to let them go", () =>
    Effect.gen(function*() {
      const holder = yield* Scope.make()
      yield* Layer.buildWithScope(sqlite(), holder)
      const next = yield* Effect.flatMap(sql, (client) => client`SELECT 1 AS one`).pipe(
        Effect.provide(database()),
        Effect.forkChild
      )
      yield* Effect.sleep("100 millis")
      yield* Scope.close(holder, Exit.void)
      expect(yield* Fiber.join(next)).toEqual([{ one: 1 }])
    }))

  it.live("recovers when another worker holds OPFS beyond the former retry deadline", () =>
    Effect.gen(function*() {
      const holder = yield* Scope.make()
      yield* Layer.buildWithScope(sqlite(), holder)
      const next = yield* Effect.flatMap(sql, (client) => client`SELECT 1 AS one`).pipe(
        Effect.provide(database()),
        Effect.forkChild
      )
      yield* Effect.sleep("6 seconds")
      yield* Scope.close(holder, Exit.void)
      expect(yield* Fiber.join(next)).toEqual([{ one: 1 }])
    }), 15_000)

  it.live("cancels an OPFS acquisition waiting for another worker without retaining handles", () =>
    Effect.gen(function*() {
      const holder = yield* Scope.make()
      yield* Layer.buildWithScope(sqlite(), holder)
      const waiting = yield* Layer.build(sqlite()).pipe(Effect.scoped, Effect.forkChild)
      yield* Effect.sleep("100 millis")
      yield* Fiber.interrupt(waiting)
      yield* Scope.close(holder, Exit.void)
      expect(yield* Effect.flatMap(sql, (client) => client`SELECT 1 AS one`).pipe(Effect.provide(database())))
        .toEqual([{ one: 1 }])
    }).pipe(Effect.scoped))

  it.effect("fails an OPFS that cannot be opened at all without retrying", () =>
    Effect.gen(function*() {
      Object.defineProperty(navigator, "storage", {
        configurable: true,
        value: { getDirectory: () => Promise.reject(new TypeError("no OPFS here")) }
      })
      const refused = yield* Layer.build(sqlite()).pipe(Effect.scoped, Effect.flip)
      expect(refused.message).toContain("Failed to open the OPFS directory")
    }))

  it.effect("fails bytes that are not WebAssembly, before they reach the build", () =>
    Effect.gen(function*() {
      let built = 0
      const refused = yield* Layer.build(sqlite({
        module: async () => ({
          default: (options) => (built++, MemorySqlite.build.module().then((m) => m.default(options)))
        }),
        wasm: () => Promise.resolve(new Uint8Array([0, 1, 2]))
      })).pipe(Effect.scoped, Effect.flip)
      expect(refused.message).toContain("Failed to load wa-sqlite")
      expect(built).toBe(0)
    }))

  it.effect("fails a build whose JavaScript or bytes cannot be loaded", () =>
    Effect.gen(function*() {
      const noModule = yield* Layer.build(
        sqlite({ ...MemorySqlite.build, module: () => Promise.reject(new TypeError("offline")) })
      )
        .pipe(Effect.scoped, Effect.flip)
      expect(noModule.message).toContain("Failed to load wa-sqlite")
      const noBytes = yield* Layer.build(
        sqlite({ ...MemorySqlite.build, wasm: () => Promise.reject(new TypeError("offline")) })
      )
        .pipe(Effect.scoped, Effect.flip)
      expect(noBytes.message).toContain("Failed to load wa-sqlite")
    }))

  it.effect("fails a database name the pool cannot hold", () =>
    Effect.gen(function*() {
      const refused = yield* Layer.build(database("x".repeat(600))).pipe(Effect.scoped, Effect.flip)
      expect(refused.message).toContain("Failed to open database")
    }))
})
