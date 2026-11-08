/**
 * The statement loop both SQLite clients share: which statement of a request
 * is its last, read from SQLite's own text of each, whatever follows it.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Statements from "../src/internal/Statements.ts"
import * as MemorySqlite from "./fixtures/MemorySqlite.ts"

/** Which statements of `sql` `runAll` called last, in order. */
const lasts = (sql: string) =>
  Effect.gen(function*() {
    const database = yield* MemorySqlite.open
    const seen: Array<boolean> = []
    yield* Effect.promise(() =>
      Statements.runAll(database, sql, [], "object", {
        before: async ({ last }) => {
          seen.push(last)
        }
      })
    )
    return seen
  }).pipe(Effect.scoped)

const cases: ReadonlyArray<readonly [string, ReadonlyArray<boolean>]> = [
  ["SELECT 1", [true]],
  ["SELECT 1; SELECT 2", [false, true]],
  ["SELECT 1; -- a comment to the end", [true]],
  ["SELECT 1; -- a comment\n SELECT 2", [false, true]],
  ["SELECT 1; /* a comment */ ;;", [true]],
  ["SELECT 1; /* a comment never closed", [true]],
  ["SELECT 'a;b'; SELECT 'é; ü'", [false, true]],
  [
    "CREATE TEMP TABLE x (a); CREATE TEMP TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; SELECT 2; END; SELECT 3",
    [false, false, true]
  ]
]

describe("Statements.runAll", () => {
  it.effect.each(cases)(
    "tells the last statement of %j",
    ([sql, expected]) => Effect.map(lasts(sql), (seen) => expect(seen).toEqual(expected))
  )
})
