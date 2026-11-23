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
