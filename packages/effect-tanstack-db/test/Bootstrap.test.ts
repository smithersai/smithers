import { createBrowserWASQLitePersistence } from "@tanstack/browser-db-sqlite-persistence"
import { createPersistedTableName } from "@tanstack/db-sqlite-persistence-core"
import { Effect, Exit } from "effect"
import { DatabaseSync, type SQLInputValue } from "node:sqlite"
import { expect, test } from "vitest"
import { Collection, Persistence } from "../src/index.ts"
import { databaseFile, id, Note, note, persistenceOn } from "./fixtures.ts"

const databaseLayer = (path: string, before: (sql: string, transaction: boolean) => void) =>
  Persistence.layer({
    open: () => {
      const database = new DatabaseSync(path)
      return {
        execute: async <T>(sql: string, params: ReadonlyArray<unknown> = []): Promise<ReadonlyArray<T>> => {
          before(sql, database.isTransaction)
          const statement = database.prepare(sql)
          if (statement.columns().length > 0) return statement.all(...params as Array<SQLInputValue>) as Array<T>
          statement.run(...params as Array<SQLInputValue>)
          return []
        },
        close: () => database.close()
      }
    },
    make: (database) => createBrowserWASQLitePersistence({ database })
  })

const stored = (name: string) =>
  Collection.persisted({ id: name, schema: Note, getKey: (row) => row.id, schemaVersion: 1 })

test("schema bootstrap groups tables and triggers in transactions before the first write", async () => {
  const path = databaseFile()
  const name = id("bootstrap")
  const atomic: boolean[] = []
  await Effect.runPromise(
    Effect.scoped(Effect.gen(function*() {
      const collection = yield* stored(name)
      yield* collection.restored
      yield* collection.insert(note("a", 1)).pipe(Effect.flatMap((write) => write.persisted))
    })).pipe(Effect.provide(databaseLayer(path, (sql, transaction) => {
      if (/^CREATE\s+(?:TABLE|TRIGGER)\b/i.test(sql.trim())) atomic.push(transaction)
    })))
  )
  expect(atomic.length).toBeGreaterThan(0)
  expect(atomic.every(Boolean)).toBe(true)
  const restored = await Effect.runPromise(
    Effect.scoped(Effect.gen(function*() {
      const collection = yield* stored(name)
      yield* collection.restored
      return yield* collection.toArray
    })).pipe(Effect.provide(persistenceOn(path)))
  )
  expect(restored).toEqual([expect.objectContaining(note("a", 1))])
})

test("a failed collection bootstrap rolls its tables back and a later open can persist rows", async () => {
  const path = databaseFile()
  const name = id("bootstrap-failure")
  let injected = false
  const result = await Effect.runPromise(
    Effect.scoped(Effect.gen(function*() {
      const collection = yield* stored(name)
      return yield* Effect.exit(collection.restored)
    })).pipe(Effect.provide(databaseLayer(path, (sql) => {
      if (!injected && /^CREATE\s+TRIGGER\b/i.test(sql.trim())) {
        injected = true
        throw new Error("schema write refused")
      }
    })))
  )
  expect(injected).toBe(true)
  expect(Exit.isFailure(result)).toBe(true)
  const database = new DatabaseSync(path)
  try {
    expect(
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get(createPersistedTableName(name))
    ).toBeUndefined()
  } finally {
    database.close()
  }
  const restored = await Effect.runPromise(
    Effect.scoped(Effect.gen(function*() {
      const collection = yield* stored(name)
      yield* collection.restored
      yield* collection.insert(note("recovered", 2)).pipe(Effect.flatMap((write) => write.persisted))
      return yield* collection.toArray
    })).pipe(Effect.provide(persistenceOn(path)))
  )
  expect(restored).toEqual([expect.objectContaining(note("recovered", 2))])
})
