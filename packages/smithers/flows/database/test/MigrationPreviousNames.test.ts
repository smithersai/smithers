/** Exact package-owned rename compatibility preserves applied migration history. */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"
import * as TestDatabase from "../src/test/TestDatabase.ts"

const initial = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE retained (value TEXT NOT NULL)`
  yield* sql`INSERT INTO retained VALUES ('receipt')`
})
const old: Migrations.MigrationSet = {
  namespace: "owned",
  idOffset: 0,
  migrations: { "0001_original": initial }
}
const current: Migrations.MigrationSet = {
  ...old,
  migrations: { "0001_current": initial },
  previousNames: { "0001_current": ["original"] }
}

describe("explicit previous migration names", () => {
  it.effect("keeps historical identities and data without rerunning the migration", () =>
    Effect.gen(function*() {
      yield* Migrations.run([old])
      expect(yield* Migrations.run([current])).toEqual([])
      expect(yield* Migrations.run([current])).toEqual([])
      const sql = yield* SqlClient.SqlClient
      expect(yield* sql`SELECT name FROM flows_migrations`).toEqual([{ name: "owned_original" }])
      expect(yield* sql`SELECT value FROM retained`).toEqual([{ value: "receipt" }])
    }).pipe(Effect.provide(TestDatabase.layer)))

  it.effect("records only the current name on fresh databases", () =>
    Effect.gen(function*() {
      expect(yield* Migrations.run([current])).toEqual([[1, "owned_current"]])
      expect(yield* Migrations.run([current])).toEqual([])
    }).pipe(Effect.provide(TestDatabase.layer)))

  it.effect("refuses unknown names and other namespaces before applying new work", () =>
    Effect.gen(function*() {
      yield* Migrations.run([old])
      const sql = yield* SqlClient.SqlClient
      for (const previousNames of [undefined, { "0001_current": ["different"] }]) {
        const exit = yield* Effect.exit(Migrations.run([{
          ...old,
          migrations: current.migrations,
          ...(previousNames === undefined ? {} : { previousNames })
        }]))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(JSON.stringify(exit)).toContain("was recorded as owned_original")
      }
      const exit = yield* Effect.exit(Migrations.run([{ ...current, namespace: "other" }]))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(yield* sql`SELECT name FROM flows_migrations`).toEqual([{ name: "owned_original" }])
      expect(yield* sql`SELECT value FROM retained`).toEqual([{ value: "receipt" }])
    }).pipe(Effect.provide(TestDatabase.layer)))

  it.effect("does not accept a known name at another migration id", () =>
    Effect.gen(function*() {
      yield* Migrations.run([old])
      const exit = yield* Effect.exit(Migrations.run([{
        ...current,
        migrations: { "0001_current": initial, "0002_later": Effect.void },
        previousNames: { "0002_later": ["original"] }
      }]))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(JSON.stringify(exit)).toContain("was recorded as owned_original")
    }).pipe(Effect.provide(TestDatabase.layer)))

  it.effect("snapshots alias arrays and their keys before caller mutation", () =>
    Effect.gen(function*() {
      yield* Migrations.run([old])
      const names = ["original"]
      const previousNames = { "0001_current": names }
      const run = Migrations.run([{ ...current, previousNames }])
      names[0] = "different"
      previousNames["0001_current"] = []
      expect(yield* run).toEqual([])
    }).pipe(Effect.provide(TestDatabase.layer)))

  it.effect("refuses aliases for absent migrations and blank or padded names", () =>
    Effect.gen(function*() {
      for (
        const previousNames of [
          { "0002_absent": ["original"] },
          { "0001_current": [""] },
          { "0001_current": [" original"] }
        ]
      ) {
        const exit = yield* Effect.exit(Migrations.run([{ ...current, previousNames }]))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(JSON.stringify(exit)).toContain("Invalid previous migration names")
      }
    }).pipe(Effect.provide(TestDatabase.layer)))
})
