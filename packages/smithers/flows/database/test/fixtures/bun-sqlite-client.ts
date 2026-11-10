// Runs under real Bun (spawned by NativeBunSqliteClient.test.ts): no shim or Node SQLite.
import { Effect, Exit, Layer } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as BunDatabase from "../../src/bun/BunDatabase.ts"
import * as DurableWriter from "../../src/DurableWriter.vibe"

const root = mkdtempSync(join(tmpdir(), "flows-bun-native-"))
const filename = join(root, "native.sqlite")

const writable = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const writer = yield* DurableWriter.DurableWriter
  yield* sql`PRAGMA foreign_keys = ON`
  // The ledger table is what lets the guard open this file a second time.
  yield* sql`CREATE TABLE flows_migrations (migration_id INTEGER PRIMARY KEY)`
  yield* sql`CREATE TABLE parent (id INTEGER PRIMARY KEY)`
  yield* sql`CREATE TABLE child (parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)`
  // A deferred foreign key rejects the COMMIT itself, after the body succeeded.
  const rejected = yield* Effect.flip(writer.write(sql`INSERT INTO child VALUES (999)`))
  const afterRejected = yield* sql`SELECT * FROM child`
  const nested = yield* writer.write(
    writer.write(sql`INSERT INTO parent VALUES (1)`.raw.pipe(Effect.flatMap(DurableWriter.affectedRows)))
  )
  const journal = yield* sql`PRAGMA journal_mode`
  return { rejected: rejected.code, afterRejected, nested, journal }
}).pipe(
  Effect.provide(Layer.provideMerge(DurableWriter.layer(), BunDatabase.layer({ filename }))),
  Effect.scoped
)

const readOnly = (name: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql.withTransaction(sql`SELECT id FROM parent`)
    const write = yield* Effect.exit(sql`INSERT INTO parent VALUES (2)`)
    return { rows, writeRefused: Exit.isFailure(write) }
  }).pipe(Effect.provide(BunDatabase.layer({ filename: name, readOnly: true })), Effect.scoped)

const unopened = Effect.exit(
  Effect.scoped(Effect.provide(Effect.asVoid(SqlClient.SqlClient), BunDatabase.layer({ filename: root })))
)

try {
  const result = await Effect.runPromise(Effect.gen(function*() {
    return {
      writable: yield* writable,
      readOnly: yield* readOnly(filename),
      readOnlyUri: yield* readOnly(`file:${filename}?mode=ro`),
      // A directory is not a database: the open fails, and fails as a defect.
      unopened: Exit.isFailure(yield* unopened)
    }
  }))
  console.log(JSON.stringify(result))
} finally {
  rmSync(root, { recursive: true, force: true })
}
