import { TestSchemas } from "@smthrs/database"
/** Persistent identity shared by independent processes in the storage matrix. */
import * as Pg from "@effect/sql-pg"
import { PostgresDatabase } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import * as TestStores from "../../src/test/TestStores.ts"

export const filename = (sqlitePath: string): string => {
  if (!process.env.SMITHERS_TEST_PG_URL) return sqlitePath
  const url = new URL(process.env.SMITHERS_TEST_PG_URL)
  url.searchParams.set("schema", TestSchemas.schemaName("test_restart"))
  return url.toString()
}

export const remove = async (filename: string): Promise<void> => {
  if (!/^postgres(?:ql)?:/.test(filename)) return
  const url = new URL(filename)
  const schema = url.searchParams.get("schema")!
  url.searchParams.delete("schema")
  await Effect.runPromise(
    Effect.gen(function*() {
      const sql = yield* SqlClient
      yield* TestDatabase.dropSchema(sql, schema)
    }).pipe(Effect.provide(PostgresDatabase.layer({ url: url.toString(), driver: Pg, schema })))
  )
}

/** `sqlitePath` as the matrix's database identity, its PostgreSQL schema dropped when the scope closes. */
export const scoped = (sqlitePath: string) =>
  Effect.acquireRelease(Effect.sync(() => filename(sqlitePath)), (name) => Effect.promise(() => remove(name)))

/**
 * Every durable engine store over `name`, or, when none is given, over the matrix's private database:
 * in-memory SQLite, or a fresh PostgreSQL schema dropped once the stores have closed.
 */
export const stores = (name?: string, options?: TestStores.TestStoresOptions) =>
  name !== undefined ?
    TestStores.layerAt(name, options) :
    Layer.unwrap(Effect.map(scoped(":memory:"), (memory) => TestStores.layerAt(memory, options)))
