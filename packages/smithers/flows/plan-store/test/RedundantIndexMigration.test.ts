import { describe, expect, it } from "@effect/vitest"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Plan from "@smthrs/plan/Plan"
import { compile, draft } from "@smthrs/plan/test/PlanFixtures"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as SqlClient from "effect/sql/SqlClient"
import { initial } from "../src/internal/migrations/0001_initial.ts"
import { appendOnlyHardening } from "../src/internal/migrations/0002_append_only_hardening.ts"
import { forwardOnlyIdentity } from "../src/internal/migrations/0003_forward_only_identity.ts"
import * as Migrations from "../src/Migrations.ts"
import * as PlanStore from "../src/PlanStore.ts"
import { withCrypto } from "./Crypto.ts"

const previous: DatabaseMigrations.MigrationSet = {
  namespace: "plan",
  idOffset: 4000,
  migrations: {
    "0001_initial": initial,
    "0002_append_only_hardening": appendOnlyHardening,
    "0003_forward_only_identity": forwardOnlyIdentity
  }
}

const indexes = (sql: SqlClient.SqlClient) =>
  sql<{ name: string; sql: string }>`
    SELECT name, sql FROM ${TestDatabase.catalog(sql)}
    WHERE type = 'index' AND name IN ('flows_plan_nodes_order', 'flows_plan_nodes_ordinal')
    ORDER BY name
  `

const history = (sql: SqlClient.SqlClient) =>
  Effect.gen(function*() {
    return {
      plans: yield* sql`SELECT * FROM flows_plans ORDER BY plan_id`,
      nodes: yield* sql`SELECT * FROM flows_plan_nodes ORDER BY plan_id, ordinal`,
      edges: yield* sql`SELECT * FROM flows_plan_edges ORDER BY plan_id, from_node, to_node`,
      triggers: yield* sql`
        SELECT name, sql FROM ${TestDatabase.catalog(sql)}
        WHERE type = 'trigger' AND tbl_name IN ('flows_plans', 'flows_plan_nodes', 'flows_plan_edges')
        ORDER BY name
      `
    }
  })

describe("redundant plan node index migration", () => {
  for (const upgrade of [false, true]) {
    it.effect(`${upgrade ? "upgrades an existing" : "initializes a fresh"} database with only the unique ordinal index`, () =>
      withCrypto(
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const store = yield* PlanStore.make
          const base = yield* compile([
            draft("root"),
            draft("child", { inputs: [{ _tag: "Pending", from: "root" }] })
          ])
          const before = upgrade
            ? yield* Effect.gen(function*() {
              yield* DatabaseMigrations.run([previous])
              yield* store.record(base, 0)
              expect((yield* indexes(sql)).map((index) => index.name)).toEqual([
                "flows_plan_nodes_order",
                "flows_plan_nodes_ordinal"
              ])
              return yield* history(sql)
            })
            : undefined

          yield* Migrations.run
          const remaining = yield* indexes(sql)
          expect(remaining).toHaveLength(1)
          expect(remaining[0]!.name).toBe("flows_plan_nodes_ordinal")
          expect(remaining[0]!.sql).toMatch(/CREATE UNIQUE INDEX.*\(plan_id, ordinal\)/)
          if (before !== undefined) expect(yield* history(sql)).toEqual(before)
          else yield* store.record(base, 0)

          expect(Option.getOrThrow(yield* store.get(base.planId))).toEqual(base)
          expect(yield* Migrations.run).toEqual([])

          const duplicate = yield* Effect.flip(sql`
            INSERT INTO flows_plan_nodes (plan_id, node_id, generation, ordinal, kind, key_digest, node_json)
            SELECT plan_id, 'duplicate', generation, ordinal, kind, key_digest, node_json
            FROM flows_plan_nodes WHERE plan_id = ${base.planId} AND node_id = 'root'
          `)
          expect(duplicate.reason._tag).toMatch(/ConstraintError|UniqueViolation/)

          const grown = yield* Plan.append(base, [
            draft("late", { inputs: [{ _tag: "Pending", from: "child" }] })
          ])
          yield* store.append(grown)
          expect(Option.getOrThrow(yield* store.get(base.planId))).toEqual(grown)
        }).pipe(Effect.provide(TestDatabase.layer))
      ))
  }
})
