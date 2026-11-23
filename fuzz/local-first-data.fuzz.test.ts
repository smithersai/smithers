import { Collection, LiveQuery, Query } from "@smthrs/effect-tanstack-db"
import { it } from "@smthrs/testing/Vitest"
import { Effect, Schema } from "effect"
import { describe, expect } from "vitest"

const RowSchema = Schema.Struct({
  id: Schema.String,
  group: Schema.Literals(["a", "b", "c"]),
  score: Schema.Int.check(Schema.isBetween({ minimum: -50, maximum: 50 }))
})
type Row = typeof RowSchema.Type

const DbOp = Schema.Struct({
  kind: Schema.Literals(["insert", "update", "delete"]),
  id: Schema.Literals(["r1", "r2", "r3", "r4", "r5"]),
  group: Schema.Literals(["a", "b", "c"]),
  score: Schema.Int.check(Schema.isBetween({ minimum: -50, maximum: 50 }))
})

describe("@smthrs/effect-tanstack-db differential fuzz", () => {
  it.effect.fuzz(
    "Collection.local + LiveQuery matches naive Map full-scan oracle across arbitrary insert/update/delete sequences",
    [
      Schema.Array(DbOp).check(Schema.isMinLength(1), Schema.isMaxLength(25)),
      Schema.Literals(["a", "b", "c"])
    ],
    ([ops, filterGroup]) =>
      Effect.scoped(
        Effect.gen(function*() {
          const col = yield* Collection.local({
            id: `fuzz-col-${filterGroup}`,
            schema: RowSchema,
            getKey: (r) => r.id
          })
          const live = yield* LiveQuery.make((q) =>
            q
              .from({ row: col.tanstack })
              .where(({ row }) => Query.eq(row.group, filterGroup))
              .orderBy(({ row }) => row.id, "asc")
          )

          yield* live.preload
          const oracle = new Map<string, Row>()

          for (const op of ops) {
            if (op.kind === "insert") {
              if (!oracle.has(op.id)) {
                const row: Row = { id: op.id, group: op.group, score: op.score }
                yield* col.insert(row)
                oracle.set(op.id, row)
              }
            } else if (op.kind === "update") {
              if (oracle.has(op.id)) {
                yield* col.update(op.id, (draft) => {
                  draft.group = op.group
                  draft.score = op.score
                })
                oracle.set(op.id, { id: op.id, group: op.group, score: op.score })
              }
            } else {
              if (oracle.has(op.id)) {
                yield* col.delete(op.id)
                oracle.delete(op.id)
              }
            }

            const expected = [...oracle.values()]
              .filter((r) => r.group === filterGroup)
              .sort((a, b) => a.id.localeCompare(b.id))
            const actual = yield* live.toArray
            expect(actual.map(({ id, group, score }) => ({ id, group, score }))).toEqual(expected)
          }
          return true
        })
      )
  )
})
