/**
 * `DoSqliteShard` over an in-memory double of a SQLite-backed Durable
 * Object's storage: `sql.exec` over `node:sqlite` that refuses transaction
 * SQL as the real one does, `transaction()` for the Effect client, and
 * `transactionSync()` committing when its closure returns and rolling back
 * when it throws. The database lives in a file, so closing it and opening the
 * same file again is a hibernated object waking with its disk.
 */
import { SqliteClient } from "@effect/sql-sqlite-do"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as SqlClient from "effect/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { DoSqliteShard, type ObjectDatabase } from "../src/index.ts"

const shard = "repo:acme/widgets"
const stream = "repo:acme/widgets"

/** A Durable Object's storage over one SQLite file, until `hibernate` closes it. */
const openStorage = (path: string) => {
  const db = new DatabaseSync(path)
  let depth = 0
  const cursor = (query: string, params: ReadonlyArray<unknown>) => {
    if (/^\s*(BEGIN|SAVEPOINT|COMMIT|ROLLBACK|RELEASE)\b/i.test(query)) {
      throw new Error("To execute a transaction, please use the state.storage.transaction() API")
    }
    const statement = db.prepare(query)
    const columnNames = statement.columns().map((column) => column.name)
    const rows = columnNames.length === 0
      ? (statement.run(...(params as Array<SQLInputValue>)), [])
      : statement.all(...(params as Array<SQLInputValue>)) as Array<Record<string, unknown>>
    return {
      columnNames,
      toArray: () => rows,
      raw: function*() {
        for (const row of rows) yield columnNames.map((name) => row[name])
      }
    }
  }
  const enter = () => {
    const level = depth++
    db.exec(level === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT level_${level}`)
    return (commit: boolean) => {
      depth--
      if (level === 0) db.exec(commit ? "COMMIT" : "ROLLBACK")
      else db.exec(commit ? `RELEASE level_${level}` : `ROLLBACK TO level_${level}; RELEASE level_${level}`)
    }
  }
  const transactionSync = <T>(closure: () => T): T => {
    const end = enter()
    try {
      const value = closure()
      end(true)
      return value
    } catch (cause) {
      end(false)
      throw cause
    }
  }
  const transaction = async <T>(closure: (txn: { rollback(): void }) => Promise<T>): Promise<T> => {
    const end = enter()
    let rolledBack = false
    try {
      const value = await closure({ rollback: () => void (rolledBack = true) })
      end(!rolledBack)
      return value
    } catch (cause) {
      end(false)
      throw cause
    }
  }
  return {
    storage: {
      sql: { exec: (query: string, ...params: Array<unknown>) => cursor(query, params) },
      transaction,
      transactionSync
    } as unknown as ObjectDatabase.Storage,
    count: (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
    hibernate: () => db.close()
  }
}

const withObject = <A, E>(
  options: Partial<DoSqliteShard.Options> & { readonly path: string },
  body: Effect.Effect<A, E, DoSqliteShard.DoSqliteShard | SqlClient.SqlClient>
) =>
  Effect.gen(function*() {
    const object = openStorage(options.path)
    const result = yield* Effect.provide(body, DoSqliteShard.layer(object.storage, { shard, ...options }))
    return { result, object }
  })

const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "do-sqlite-shard-"))
  return { path: join(dir, "object.sqlite"), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const command = (node: string, id: string, payload: DoSqliteShard.Json): DoSqliteShard.Command => ({
  key: [node, id],
  stream,
  payload
})

const submit = (cmd: DoSqliteShard.Command, epoch = 0) =>
  Effect.flatMap(DoSqliteShard.DoSqliteShard, (object) => object.submit({ version: 2, shard, epoch, command: cmd }))

const pull = (after: number, limit = 100, epoch = 0) =>
  Effect.flatMap(DoSqliteShard.DoSqliteShard, (object) => object.pull({ version: 2, shard, epoch, after, limit }))

describe("DoSqliteShard", () => {
  it.effect("builds the Effect client from { storage }, so its transactions work where BEGIN is refused", () => {
    const { path, cleanup } = scratch()
    return withObject(
      { path },
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        expect(SqliteClient.TypeId in sql).toBe(true)
        expect((sql as SqliteClient.SqliteClient).config.storage).toBeDefined()
        expect((sql as SqliteClient.SqliteClient).config.db).toBeUndefined()
        // A `{ db }` client would fail here: its withTransaction is unsupported.
        yield* sql.withTransaction(sql`SELECT 1`)
        yield* Effect.flip(sql`BEGIN IMMEDIATE`)
      })
    ).pipe(Effect.ensuring(Effect.sync(cleanup)))
  })

  it.effect("rolls back a submit whose transaction faults before commit", () => {
    const { path, cleanup } = scratch()
    let fault = true
    return withObject(
      {
        path,
        beforeCommit: (entry) => {
          if (fault && entry.seq === 2) throw new Error("pre-commit fault")
        }
      },
      Effect.gen(function*() {
        yield* submit(command("a", "1", "one"))
        const failed = yield* Effect.exit(submit(command("a", "2", "two")))
        expect(Exit.isFailure(failed)).toBe(true)
        expect(yield* (yield* DoSqliteShard.DoSqliteShard).head).toEqual({ shard, epoch: 0, seq: 1 })
        fault = false
        // Nothing of the failed submit survived: not its entry, not its receipt.
        expect(yield* submit(command("a", "2", "two"))).toMatchObject({ _tag: "Accepted", position: { seq: 2 } })
      })
    ).pipe(
      Effect.tap(({ object }) =>
        Effect.sync(() => {
          expect(object.count("shard_entries")).toBe(2)
          expect(object.count("shard_receipts")).toBe(2)
        })
      ),
      Effect.ensuring(Effect.sync(cleanup))
    )
  })

  it.effect("writes no duplicate row when a command is replayed", () => {
    const { path, cleanup } = scratch()
    return withObject(
      {
        path,
        decide: (cmd) =>
          cmd.payload === "bad" ? { _tag: "Refused", reason: "bad" } : { _tag: "Accepted", events: [cmd.payload] }
      },
      Effect.gen(function*() {
        const first = yield* submit(command("a", "1", { n: 1, m: 2 }))
        for (let i = 0; i < 5; i++) {
          // Same content, keys in another order: the same command.
          expect(yield* submit(command("a", "1", { m: 2, n: 1 }))).toEqual({ ...first, _tag: "Duplicate" })
        }
        expect(yield* submit(command("a", "1", { n: 9 }))).toEqual({
          _tag: "IdempotencyConflict",
          key: ["a", "1"],
          position: { shard, epoch: 0, seq: 1 }
        })
        expect(yield* submit(command("a", "2", "bad"))).toEqual({ _tag: "Refused", key: ["a", "2"], reason: "bad" })
        // Every JSON shape hashes: null and arrays included.
        expect(yield* submit(command("a", "3", [null, { z: [true] }]))).toMatchObject({
          _tag: "Accepted",
          position: { seq: 2 }
        })
        expect(yield* submit(command("a", "3", [null, { z: [true] }]))).toMatchObject({
          _tag: "Duplicate",
          position: { seq: 2 }
        })
        expect(yield* submit(command("a", "2", "bad"))).toEqual({ _tag: "Refused", key: ["a", "2"], reason: "bad" })
        expect(yield* submit(command("a", "2", "good"))).toEqual({
          _tag: "IdempotencyConflict",
          key: ["a", "2"],
          position: null
        })
      })
    ).pipe(
      Effect.tap(({ object }) => Effect.sync(() => expect(object.count("shard_entries")).toBe(2))),
      Effect.ensuring(Effect.sync(cleanup))
    )
  })

  it.effect("keeps its order, receipts and a reader's cursor across hibernation", () => {
    const { path, cleanup } = scratch()
    return Effect.gen(function*() {
      const before = yield* withObject(
        { path },
        Effect.gen(function*() {
          for (const id of ["1", "2", "3"]) yield* submit(command("w", id, Number(id)))
          return yield* pull(0, 2)
        })
      )
      expect(before.result).toMatchObject({ _tag: "Page", through: 2, head: 3, done: false })
      const cursor = (before.result as { through: number }).through
      before.object.hibernate()

      const after = yield* withObject(
        { path },
        Effect.gen(function*() {
          const object = yield* DoSqliteShard.DoSqliteShard
          expect(yield* object.head).toEqual({ shard, epoch: 0, seq: 3 })
          expect(yield* submit(command("w", "2", 2))).toMatchObject({ _tag: "Duplicate", position: { seq: 2 } })
          expect(yield* submit(command("w", "4", 4))).toMatchObject({ _tag: "Accepted", position: { seq: 4 } })
          return yield* pull(cursor)
        })
      )
      expect(after.result).toEqual({
        _tag: "Page",
        shard,
        epoch: 0,
        entries: [
          { seq: 3, epoch: 0, key: ["w", "3"], stream, events: [3] },
          { seq: 4, epoch: 0, key: ["w", "4"], stream, events: [4] }
        ],
        through: 4,
        head: 4,
        done: true
      })
      expect(after.object.count("shard_entries")).toBe(4)
      after.object.hibernate()
    }).pipe(Effect.ensuring(Effect.sync(cleanup)))
  })

  it.effect("fences an old epoch, resyncs a cursor it never issued, and refuses another shard", () => {
    const { path, cleanup } = scratch()
    return withObject(
      { path },
      Effect.gen(function*() {
        const object = yield* DoSqliteShard.DoSqliteShard
        yield* submit(command("a", "1", 1))
        expect(yield* pull(5)).toEqual({ _tag: "Resync", shard, epoch: 0, snapshotSeq: 0 })
        expect(yield* object.advanceEpoch).toEqual({ shard, epoch: 1, seq: 1 })
        expect(yield* submit(command("a", "2", 2))).toEqual({ _tag: "StaleEpoch", key: ["a", "2"], shard, epoch: 1 })
        expect(yield* pull(1)).toEqual({ _tag: "Resync", shard, epoch: 1, snapshotSeq: 0 })
        expect(yield* object.snapshot(shard)).toEqual({ position: { shard, epoch: 1, seq: 0 }, state: null })
        expect(yield* submit(command("a", "2", 2), 1)).toMatchObject({
          _tag: "Accepted",
          position: { epoch: 1, seq: 2 }
        })
        for (
          const misrouted of [
            object.submit({ version: 2, shard: "repo:other", epoch: 1, command: command("a", "3", 3) }),
            object.pull({ version: 2, shard: "repo:other", epoch: 1, after: 0, limit: 1 }),
            object.snapshot("repo:other")
          ] as ReadonlyArray<Effect.Effect<unknown, unknown>>
        ) {
          expect(Exit.isFailure(yield* Effect.exit(misrouted))).toBe(true)
        }
      })
    ).pipe(Effect.ensuring(Effect.sync(cleanup)))
  })
})
