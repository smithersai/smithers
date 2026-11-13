import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit } from "effect"
import { SqlClient } from "effect/sql/SqlClient"
import * as Migrations from "../src/Migrations.ts"
import * as TestDatabase from "../src/test/TestDatabase.ts"

describe("migration ledger integer bounds", () => {
  for (const [offset, local] of [[3_000_000_000, 1], [2_147_484_000, 0], [2_147_483_000, 648], [2_147_483_000, 999]]) {
    it.effect(`rejects ${offset} + ${local} before running a migration`, () =>
      Effect.gen(function*() {
        let ran = false
        const exit = yield* Effect.exit(Migrations.run([{
          namespace: "bounds",
          idOffset: offset!,
          migrations: {
            [`${local}_overflow`]: Effect.sync(() => {
              ran = true
            })
          }
        }]))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(String(Cause.squash(exit.cause))).toContain("2147483647")
          expect(String(Cause.squash(exit.cause))).toContain("bounds")
        }
        expect(ran).toBe(false)
      }).pipe(Effect.provide(TestDatabase.layer)))
  }

  it.effect("records the largest PostgreSQL INTEGER id and reopens it idempotently", () =>
    Effect.gen(function*() {
      const set: Migrations.MigrationSet = {
        namespace: "bounds",
        idOffset: 2_147_483_000,
        migrations: { "0647_last": Effect.void }
      }
      expect(yield* Migrations.run([set])).toEqual([[2_147_483_647, "bounds_last"]])
      expect(yield* Migrations.run([set])).toEqual([])
      const sql = yield* SqlClient
      expect(yield* sql`SELECT migration_id FROM flows_migrations`).toEqual([{ migration_id: 2_147_483_647 }])
    }).pipe(Effect.provide(TestDatabase.layer)))
})
