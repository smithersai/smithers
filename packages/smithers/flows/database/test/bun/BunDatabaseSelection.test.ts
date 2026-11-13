import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import * as BunDatabase from "../../src/bun/BunDatabase.ts"

const keys = ["SMITHERS_BACKEND", "SMITHERS_POSTGRES_URL", "DATABASE_URL", "SMITHERS_POSTGRES_SCHEMA"] as const
const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
afterEach(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})
const clear = () => {
  for (const key of keys) delete process.env[key]
}

for (const url of ["", "mysql://secret@host/database", "postgres://["]) {
  test(`defers invalid PostgreSQL selection and exposes its defect (${url ? "invalid URL" : "missing URL"})`, async () => {
    clear()
    process.env.SMITHERS_BACKEND = "postgres"
    process.env.SMITHERS_POSTGRES_URL = url
    const layer = BunDatabase.layer({ filename: "selection.db" })
    const code = await Effect.runPromise(
      Effect.provide(SqlClient, layer).pipe(
        Effect.catchDefect((defect) => {
          expect(BunDatabase.isUnsupportedDatabase(defect)).toBe(true)
          expect(String(defect)).not.toContain("secret")
          return Effect.succeed(BunDatabase.isUnsupportedDatabase(defect) ? defect.code : "unknown")
        })
      )
    )
    expect(code).toBe(url ? "postgres_url_invalid" : "postgres_url_missing")
  })
}

test("reads the PostgreSQL environment when building a previously constructed layer", async () => {
  clear()
  const layer = BunDatabase.layer({ filename: ":memory:" })
  // A SQLite-owned filename stays local even after PostgreSQL is selected.
  process.env.SMITHERS_BACKEND = "postgres"
  expect(await Effect.runPromise(Effect.provide(Effect.map(SqlClient, (sql) => sql.driver), layer))).toBe("sqlite-bun")

  clear()
  const selectedLater = BunDatabase.layer({ filename: "selection.db" })
  process.env.SMITHERS_BACKEND = "postgres"
  const code = await Effect.runPromise(
    Effect.provide(SqlClient, selectedLater).pipe(
      Effect.catchDefect((defect) =>
        Effect.succeed(BunDatabase.isUnsupportedDatabase(defect) ? defect.code : "unknown")
      )
    )
  )
  expect(code).toBe("postgres_url_missing")
})
