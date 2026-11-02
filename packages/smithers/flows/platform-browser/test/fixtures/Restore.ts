/**
 * TanStack DB's persisted collections over the shared database, as the app
 * builds them: one browser persistence and TanStack's tab coordinator per
 * program, and the database counted, so a case or a benchmark can tell what
 * restoring them costs in requests to the leader.
 */
import {
  BrowserCollectionCoordinator,
  createBrowserWASQLitePersistence,
  persistedCollectionOptions
} from "@tanstack/browser-db-sqlite-persistence"
import { createCollection } from "@tanstack/db"
import type { SharedSqlite } from "../../src/index.ts"

export interface Row {
  readonly id: string
  readonly value: number
}

/** How a counted database runs a batch: in one request, or one request per statement as before batches. */
export type Batching = "batched" | "one request per statement"

/**
 * The database, counting the requests a tab sends and the statements they
 * carry. Each request waits `latencyMs` first, as a round trip to the leader
 * in a browser does.
 */
export const counted = (
  database: SharedSqlite.Database,
  options: { readonly latencyMs?: number; readonly batching?: Batching } = {}
) => {
  const count = { requests: 0, statements: 0 }
  const latency = () =>
    options.latencyMs === undefined
      ? Promise.resolve()
      : new Promise((resolve) => setTimeout(resolve, options.latencyMs))
  const execute: SharedSqlite.Database["execute"] = async (sql, params) => {
    count.requests++
    count.statements++
    await latency()
    return database.execute(sql, params)
  }
  const batched = {
    execute,
    executeBatch: async (statements: ReadonlyArray<SharedSqlite.Statement>) => {
      count.requests++
      count.statements += statements.length
      await latency()
      return database.executeBatch(statements)
    },
    close: database.close
  }
  return {
    count,
    // Without `executeBatch`, TanStack DB's persistence sends each statement on its own.
    database: options.batching === "one request per statement" ? { execute, close: database.close } : batched
  }
}

/** A program over `database` with the collections `ids`, persisted with schema version 1. */
export const program = (
  database: Pick<SharedSqlite.Database, "execute" | "close"> & Partial<SharedSqlite.Database>,
  dbName: string,
  ids: ReadonlyArray<string>
) => {
  const coordinator = new BrowserCollectionCoordinator({ dbName })
  const persistence = createBrowserWASQLitePersistence({ database, coordinator })
  const collections = ids.map((id) =>
    createCollection(
      persistedCollectionOptions<Row, string>({ id, getKey: (row) => row.id, persistence, schemaVersion: 1 })
    )
  )
  return {
    collections,
    /** Restores every collection. */
    restore: () => Promise.all(collections.map((collection) => collection.preload())),
    /** Each collection's rows, by id. */
    rows: () =>
      collections.map((collection) =>
        [...collection.values()].map(({ id, value }) => ({ id, value })).sort((a, b) => a.id.localeCompare(b.id))
      ),
    /** Stores `rows` in each collection, one array per collection. */
    store: async (rows: ReadonlyArray<ReadonlyArray<Row>>) => {
      for (const [index, collection] of collections.entries()) {
        await collection.insert([...rows[index]!]).isPersisted.promise
      }
    },
    dispose: async () => {
      await Promise.all(collections.map((collection) => collection.cleanup()))
      coordinator.dispose()
    }
  }
}

/** `count` collection ids and `rows` rows for each. */
export const fixture = (count: number, rows: number) => {
  const ids = Array.from({ length: count }, (_, index) => `collection-${index}`)
  const expected = ids.map((_, index) =>
    Array.from({ length: rows }, (_, row) => ({ id: `row-${String(row).padStart(4, "0")}`, value: index * 1000 + row }))
  )
  return { ids, expected }
}
