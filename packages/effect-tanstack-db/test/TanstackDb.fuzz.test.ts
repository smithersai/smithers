import { Fuzz } from "@smthrs/fuzz"
import { Arbitrary, Effect, Option, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Collection } from "../src/index.ts"

const executions = Number(process.env.EFFECT_FUZZ_EXECUTIONS ?? (process.env.EFFECT_FUZZ ? "500" : "100"))
const seed = Number(process.env.EFFECT_FUZZ_SEED ?? "20261122")

const Row = Schema.Struct({
  id: Schema.String,
  count: Schema.Int,
  label: Schema.String
})
type Row = typeof Row.Type

const Op = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("insert"),
    id: Schema.Literals(["k1", "k2", "k3", "k4", "k5"]),
    count: Schema.Int.check(Schema.isBetween({ minimum: -100, maximum: 100 })),
    label: Schema.String
  }),
  Schema.Struct({
    _tag: Schema.Literal("update"),
    id: Schema.Literals(["k1", "k2", "k3", "k4", "k5"]),
    delta: Schema.Int.check(Schema.isBetween({ minimum: -10, maximum: 10 })),
    label: Schema.String
  }),
  Schema.Struct({
    _tag: Schema.Literal("delete"),
    id: Schema.Literals(["k1", "k2", "k3", "k4", "k5"])
  })
])

describe("@smthrs/effect-tanstack-db Collection state-machine fuzz invariants", () => {
  it("Collection.local matches a reference Map oracle across arbitrary insert/update/delete sequences", async () => {
    const arb = Arbitrary.schema(Schema.Array(Op))
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        (ops) =>
          Effect.scoped(
            Effect.gen(function*() {
              const col = yield* Collection.local({
                id: "fuzz-items",
                schema: Row,
                getKey: (row) => row.id
              })
              const oracle = new Map<string, Row>()

              for (const op of ops.slice(0, 20)) {
                if (op._tag === "insert") {
                  const row: Row = { id: op.id, count: op.count, label: op.label.slice(0, 32) }
                  if (!oracle.has(op.id)) {
                    yield* col.insert(row)
                    oracle.set(op.id, row)
                  }
                } else if (op._tag === "update") {
                  const existing = oracle.get(op.id)
                  if (existing !== undefined) {
                    const nextLabel = op.label.slice(0, 32)
                    const nextCount = existing.count + op.delta
                    yield* col.update(op.id, (draft) => {
                      draft.count = nextCount
                      draft.label = nextLabel
                    })
                    oracle.set(op.id, { id: op.id, count: nextCount, label: nextLabel })
                  }
                } else if (oracle.has(op.id)) {
                  yield* col.delete(op.id)
                  oracle.delete(op.id)
                }

                // Oracle check after every step.
                const all = yield* col.toArray
                if (all.length !== oracle.size) return false
                for (const [k, expected] of oracle) {
                  const got = yield* col.get(k)
                  if (
                    Option.isNone(got) || got.value.count !== expected.count || got.value.label !== expected.label
                  ) return false
                }
              }
              return true
            })
          ),
        { seed, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})

import { Migrations } from "../src/index.ts"

describe("@smthrs/effect-tanstack-db Migrations registry fuzz invariants", () => {
  it("Migrations.registry epoch is declaration-order invariant, rejects duplicates/invalid versions, and resolves family members without prefix confusion", async () => {
    const RowV1 = Schema.Struct({ id: Schema.String, count: Schema.Int })
    const RowV2 = Schema.Struct({ id: Schema.String, count: Schema.Int, label: Schema.String })
    const arb = Arbitrary.schema(
      Schema.Struct({
        idA: Schema.Literals(["items", "notes", "tasks"]),
        idB: Schema.Literals(["items", "events", "logs"]),
        verB: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: -1, maximum: 5 }))),
        family: Schema.Boolean,
        memberName: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9_-]{1,12}$/)))
      })
    )
    const report = await Effect.runPromise(
      Fuzz.run(
        arb,
        ({ idA, idB, verB, family, memberName }) =>
          Effect.sync(() => {
            const storeA = Migrations.local({
              id: idA,
              versions: [RowV1, RowV2],
              migrations: [Migrations.step(RowV1, RowV2, (r) => ({ ...r, label: "default" }))],
              getKey: (r) => r.id
            })
            if (verB < 1) {
              try {
                Migrations.synced({ id: idB, version: verB, schema: RowV1, family })
                return false
              } catch (err) {
                return err instanceof Migrations.InvalidDeclaration
              }
            }
            const storeB = Migrations.synced({ id: idB, version: verB, schema: RowV1, family })
            if (idA === idB) {
              try {
                Migrations.registry({ stores: [storeA, storeB] })
                return false
              } catch (err) {
                return err instanceof Migrations.InvalidDeclaration
              }
            }
            const r1 = Migrations.registry({ stores: [storeA, storeB] })
            const r2 = Migrations.registry({ stores: [storeB, storeA] })
            // Epoch MUST be order-invariant
            if (r1.epoch !== r2.epoch || !Number.isSafeInteger(r1.epoch)) return false
            if (Migrations.declarationOf(r1, idA)?.id !== idA) return false
            if (Migrations.declarationOf(r1, idB)?.id !== idB) return false
            // Family member resolution without prefix confusion
            const memId = Migrations.member(storeB, memberName)
            const foundMem = Migrations.declarationOf(r1, memId)
            if (family && foundMem?.id !== idB) return false
            if (!family && foundMem !== undefined) return false
            if (Migrations.declarationOf(r1, `${idB}_other`) !== undefined) return false
            return true
          }),
        { seed: seed + 1, executions }
      )
    )
    const failure = Fuzz.formatReport(report)
    if (failure !== undefined) throw new Error(failure)
    expect(report._tag).toBe("Passed")
  })
})
