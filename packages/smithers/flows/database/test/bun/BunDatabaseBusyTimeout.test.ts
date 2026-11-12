// The adapter configures Bun's native synchronous driver, so its busy timeout
// is read back from a real Bun connection.
import { Database } from "bun:sqlite"
import { afterAll, describe, expect, test } from "bun:test"
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
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("Bun database busy timeout under real Bun", () => {
  test("matches Node defaults and honors explicit timeout precedence", async () => {
    const filename = join(root, "database.sqlite")
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
    expect(result).toEqual({
      writable: [{ timeout: 0 }],
      readOnly: [{ timeout: 1_000 }],
      sqliteReadOnly: [{ timeout: 1_000 }],
      explicitWritable: [{ timeout: 0 }],
      readOnlyWins: [{ timeout: 1_000 }],
      topLevelDuration: [{ timeout: 7 }],
      nestedDuration: [{ timeout: 11 }],
      topLevelWins: [{ timeout: 13 }],
      topLevelZeroWins: [{ timeout: 0 }],
      readOnlyOverride: [{ timeout: 19 }],
      readOnlyNestedOverride: [{ timeout: 23 }],
      sqliteReadOnlyOverride: [{ timeout: 29 }],
      readOnlyZeroWins: [{ timeout: 0 }]
    })
  }, 30_000)
})
