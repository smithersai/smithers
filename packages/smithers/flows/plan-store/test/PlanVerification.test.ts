import { describe, expect, it } from "@effect/vitest"
import * as Dialect from "@smthrs/database/Dialect"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Plan from "@smthrs/plan/Plan"
import { compile, draft } from "@smthrs/plan/test/PlanFixtures"
import { Effect, Layer, Option, Schema } from "effect"
import * as SqlClient from "effect/sql/SqlClient"
import * as Migrations from "../src/Migrations.vibe"
import * as PlanStore from "../src/PlanStore.vibe"
import { withCrypto } from "./Crypto.ts"

const stores = PlanStore.layer.pipe(Layer.provideMerge(Migrations.layer.pipe(Layer.provideMerge(TestDatabase.layer))))
const key = `key1_${"0".repeat(64)}`

describe("plan integrity admission", () => {
  for (const table of ["flows_plan_nodes", "flows_plan_edges"] as const) {
    it.effect(`rolls back a rejected append to ${table} and permits retry`, () =>
      withCrypto(
        Effect.gen(function*() {
          const base = yield* compile([draft("root")])
          const grown = yield* Plan.append(base, [
            draft("first", { inputs: [{ _tag: "Pending", from: "root" }] }),
            draft("second", { inputs: [{ _tag: "Pending", from: "first" }] })
          ])
          const store = yield* PlanStore.PlanStore
          const sql = yield* SqlClient.SqlClient
          yield* store.record(base, 0)
          yield* Dialect.trigger(sql, {
            name: "refuse_appended_row",
            table,
            event: "BEFORE INSERT",
            when: table === "flows_plan_nodes" ? "NEW.node_id = 'second'" : "NEW.to_node = 'second'",
            reject: "storage constraint"
          })

          expect((yield* Effect.flip(store.append(grown))).code).toBe("constraint")
          expect(Option.getOrThrow(yield* store.get(base.planId))).toEqual(base)
          expect((yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM flows_plan_nodes`)[0]!.count).toBe(1)
          expect((yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM flows_plan_edges`)[0]!.count).toBe(0)

          yield* TestDatabase.dropTrigger(sql, "refuse_appended_row")
          yield* store.append(grown)
          expect(Option.getOrThrow(yield* store.get(base.planId))).toEqual(grown)
          expect((yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM flows_plan_nodes`)[0]!.count).toBe(3)
          expect((yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM flows_plan_edges`)[0]!.count).toBe(2)
        }).pipe(Effect.provide(stores))
      ))
  }

  for (
    const timestamp of [
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1
    ]
  ) {
    it.effect(`rejects invalid creation timestamp ${timestamp} without persisting rows`, () =>
      withCrypto(
        Effect.gen(function*() {
          const plan = yield* compile([draft("root")])
          const store = yield* PlanStore.PlanStore
          expect((yield* Effect.flip(store.record(plan, timestamp))).code).toBe("constraint")
          expect(Option.isNone(yield* store.get(plan.planId))).toBe(true)
          expect(yield* store.record(plan, Number.MAX_SAFE_INTEGER)).toEqual({ _tag: "Recorded" })
          expect(Option.getOrThrow(yield* store.get(plan.planId))).toEqual(plan)
        }).pipe(Effect.provide(stores))
      ))
  }

  it.effect("refuses forged store admission without writing or misreporting ExistingSame", () =>
    withCrypto(
      Effect.gen(function*() {
        const plan = yield* compile([draft("a")])
        const store = yield* PlanStore.PlanStore
        const sql = yield* SqlClient.SqlClient
        const forged = { ...plan, digest: key, baseDigest: key } as Plan.Plan
        expect((yield* Effect.flip(store.record(forged, 0))).code).toBe("invalid_plan")
        expect((yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM flows_plans`)[0]!.count).toBe(0)
        expect((yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM flows_plan_nodes`)[0]!.count).toBe(0)
        expect(yield* store.record(plan, 0)).toEqual({ _tag: "Recorded" })
        const changed = {
          ...plan,
          nodes: [{ ...plan.nodes[0]!, material: { ...plan.nodes[0]!.material, body: "changed" } }]
        }
        expect((yield* Effect.flip(store.record(changed, 1))).code).toBe("invalid_plan")
        expect(Option.getOrThrow(yield* store.get(plan.planId))).toEqual(plan)
      }).pipe(Effect.provide(stores))
    ))

  it.effect("detects schema-valid stored corruption on read and duplicate admission", () =>
    withCrypto(
      Effect.gen(function*() {
        const plan = yield* compile([draft("a")])
        const store = yield* PlanStore.PlanStore
        const sql = yield* SqlClient.SqlClient
        yield* store.record(plan, 0)
        yield* TestDatabase.dropTrigger(sql, "flows_plan_nodes_append_only")
        const json = yield* Schema.encodeEffect(Schema.fromJsonString(Plan.PlanNode))({
          ...plan.nodes[0]!,
          key: key as Plan.PlanNode["key"]
        })
        yield* sql`UPDATE flows_plan_nodes SET node_json = ${json}`
        expect((yield* Effect.flip(store.get(plan.planId))).code).toBe("decode_failed")
        expect((yield* Effect.flip(store.record(plan, 1))).code).toBe("decode_failed")
      }).pipe(Effect.provide(stores))
    ))

  it.effect("round-trips an empty plan and rolls back rejected storage metadata", () =>
    withCrypto(
      Effect.gen(function*() {
        const empty = yield* compile([])
        const store = yield* PlanStore.PlanStore
        expect((yield* Effect.flip(store.record(empty, -1))).code).toBe("constraint")
        expect(Option.isNone(yield* store.get(empty.planId))).toBe(true)
        yield* store.record(empty, 0)
        expect(Option.getOrThrow(yield* store.get(empty.planId))).toEqual(empty)
      }).pipe(Effect.provide(stores))
    ))

  it.effect("rolls back the envelope when SQL refuses a verified node", () =>
    withCrypto(
      Effect.gen(function*() {
        const plan = yield* compile([draft("a")])
        const store = yield* PlanStore.PlanStore
        const sql = yield* SqlClient.SqlClient
        yield* Dialect.trigger(sql, {
          name: `refuse_plan_node`,
          table: `flows_plan_nodes`,
          event: `BEFORE INSERT`,
          reject: "storage constraint"
        })
        const failure = yield* Effect.flip(store.record(plan, 0))
        expect(failure.code).toBe("constraint")
        expect(Option.isNone(yield* store.get(plan.planId))).toBe(true)
        expect((yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM flows_plan_nodes`)[0]!.count).toBe(0)
      }).pipe(Effect.provide(stores))
    ))
})
