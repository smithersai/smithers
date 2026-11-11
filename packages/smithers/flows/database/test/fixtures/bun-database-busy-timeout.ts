// Runs in real Bun so the adapter configures the native synchronous driver.
import { Database } from "bun:sqlite"
import { Duration, Effect } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as BunDatabase from "../../src/bun/BunDatabase.ts"

const configurations: ReadonlyArray<{
  readonly name: string
  readonly options: Omit<BunDatabase.BunDatabaseOptions, "filename">
}> = [
  { name: "writable", options: {} },
  { name: "readOnly", options: { readOnly: true } },
  { name: "sqliteReadOnly", options: { sqlite: { readonly: true } } },
  { name: "explicitWritable", options: { sqlite: { readonly: false } } },
  { name: "readOnlyWins", options: { readOnly: true, sqlite: { readonly: false } } },
  { name: "topLevelDuration", options: { busyTimeout: Duration.millis(7) } },
  { name: "nestedDuration", options: { sqlite: { busyTimeout: Duration.millis(11) } } },
  { name: "topLevelWins", options: { busyTimeout: 13, sqlite: { busyTimeout: 17 } } },
  { name: "topLevelZeroWins", options: { busyTimeout: 0, sqlite: { busyTimeout: 17 } } },
  { name: "readOnlyOverride", options: { readOnly: true, busyTimeout: 19 } },
  { name: "readOnlyNestedOverride", options: { readOnly: true, sqlite: { busyTimeout: 23 } } },
  { name: "sqliteReadOnlyOverride", options: { sqlite: { readonly: true, busyTimeout: 29 } } },
  { name: "readOnlyZeroWins", options: { readOnly: true, busyTimeout: 0, sqlite: { busyTimeout: 31 } } }
]

const root = mkdtempSync(join(tmpdir(), "flows-bun-busy-timeout-"))
const filename = join(root, "database.sqlite")
try {
  const db = new Database(filename)
  db.run("CREATE TABLE flows_migrations (migration_id INTEGER PRIMARY KEY)")
  db.close()
  const result: Record<string, unknown> = {}
  for (const { name, options } of configurations) {
    result[name] = await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(SqlClient.SqlClient, (sql) => sql`PRAGMA busy_timeout`).pipe(
          Effect.provide(BunDatabase.layer({ ...options, filename }))
        )
      )
    )
  }
  console.log(JSON.stringify(result))
} finally {
  rmSync(root, { recursive: true, force: true })
}
