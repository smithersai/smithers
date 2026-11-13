/** Native configuration selection shared by Node and Bun.
 * @since 1.0.0
 */

import { Effect, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { createHash } from "node:crypto"
import { basename, resolve } from "node:path"
import * as PostgresDatabase from "../postgres/PostgresDatabase.ts"
import { forStore } from "../TestSchemas.ts"
import { UnsupportedDatabase } from "./UnsupportedDatabase.ts"

/** Recognizes PostgreSQL connection strings.
 * @since 1.0.0
 * @private
 */
export const isUrl = (value: string): boolean => /^postgres(?:ql)?:\/\//.test(value)

/** SQLite keeps memory and URI opens; an environment never redirects them to a
 * persistent shared schema.
 * @since 1.0.0
 * @private
 */
const sqliteOwned = (filename: string): boolean =>
  filename === "" || filename === ":memory:" || filename.startsWith("file:")

/** Where a filename's store lives on PostgreSQL: the connection URL (without
 * its `schema` parameter) and the schema the store's tables are in, or
 * `undefined` for a store SQLite keeps.
 * Explicit URLs select one schema; environment selection preserves each local store's identity.
 * Only Smithers' own settings select PostgreSQL: `SMITHERS_POSTGRES_URL`, or the generic
 * `DATABASE_URL` when `SMITHERS_BACKEND=postgres` asks for it.
 * @since 1.0.0
 * @private
 */
export const location = (filename: string): { readonly url: string; readonly schema: string } | undefined => {
  const explicit = isUrl(filename)
  const backend = process.env.SMITHERS_BACKEND
  if (!explicit && (backend === "sqlite" || sqliteOwned(filename))) return undefined
  const url = explicit ? filename : process.env.SMITHERS_POSTGRES_URL?.trim() ||
    (backend === "postgres" ? process.env.DATABASE_URL?.trim() : undefined)
  if (!url && backend === "postgres") {
    throw new UnsupportedDatabase({
      code: "postgres_url_missing",
      message: "PostgreSQL requires SMITHERS_POSTGRES_URL or DATABASE_URL"
    })
  }
  if (!url) return undefined
  if (!isUrl(url)) {
    throw new UnsupportedDatabase({
      code: "postgres_url_invalid",
      message: "PostgreSQL configuration requires a postgres:// or postgresql:// URL"
    })
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new UnsupportedDatabase({ code: "postgres_url_invalid", message: "Invalid PostgreSQL connection URL" })
  }
  const schema = explicit ?
    parsed.searchParams.get("schema") ?? "smithers_flows"
    : process.env.SMITHERS_POSTGRES_SCHEMA
    ? forStore(process.env.SMITHERS_POSTGRES_SCHEMA, basename(filename).replaceAll(/[^a-zA-Z0-9_]/g, "_"))
    : `smithers_${createHash("sha256").update(resolve(filename)).digest("hex").slice(0, 32)}`
  parsed.searchParams.delete("schema")
  return { url: parsed.toString(), schema }
}

/** The PostgreSQL client for a filename {@link location} places on PostgreSQL.
 * The driver loads only then: `@effect/sql-pg` is an optional peer, absent
 * where every store stays on SQLite.
 * @since 1.0.0
 * @private
 */
export const layer = (filename: string, readOnly = false): Layer.Layer<SqlClient.SqlClient> | undefined => {
  const selected = location(filename)
  if (selected === undefined) return undefined
  const owner = !isUrl(filename) && process.env.SMITHERS_POSTGRES_SCHEMA ? basename(filename) : undefined
  return Layer.unwrap(
    Effect.promise(() => import("@effect/sql-pg")).pipe(
      Effect.map((driver) => {
        const database = PostgresDatabase.layer({ url: selected.url, schema: selected.schema, readOnly, driver })
        if (owner === undefined) return database
        return Layer.effect(
          SqlClient.SqlClient,
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            const verify = Effect.gen(function*() {
              const [recorded] = yield* sql<
                { readonly basename: string }
              >`SELECT basename FROM flows_store_owner WHERE id = 1`
              if (recorded !== undefined && recorded.basename !== owner) {
                return yield* Effect.die(
                  new UnsupportedDatabase({
                    code: "postgres_schema_collision",
                    message:
                      `PostgreSQL schema "${selected.schema}" belongs to store "${recorded.basename}", not "${owner}"`
                  })
                )
              }
              return recorded !== undefined
            })
            // Catalog visibility is independent of table grants: an unreadable
            // ownership row must fail closed, not look like an unclaimed store.
            const [table] = yield* sql<{ readonly found: boolean }>`
              SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
                JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = ${selected.schema} AND c.relname = 'flows_store_owner') AS found
            `
            // Reopening a claimed schema takes no writer lock, as with direct
            // PostgreSQL opens. Read-only legacy opens never claim ownership.
            if (table!.found && (yield* verify)) return sql
            if (!readOnly) {
              // The schema writer lock serializes concurrent first claims; the row
              // survives pool closure and rejects aliases before any store is exposed.
              yield* sql.withTransaction(Effect.gen(function*() {
                yield* sql`CREATE TABLE IF NOT EXISTS flows_store_owner (
                id INTEGER PRIMARY KEY CHECK (id = 1), basename TEXT NOT NULL
              )`
                yield* sql`INSERT INTO flows_store_owner (id, basename) VALUES (1, ${owner}) ON CONFLICT (id) DO NOTHING`
                yield* verify
              }))
            }
            return sql
          }).pipe(Effect.orDie)
        ).pipe(Layer.provide(database))
      })
    )
  )
}
