import { type Effect, Schema, type Scope, type Stream } from "effect"
import { describe, expectTypeOf, test } from "vitest"
import { Collection, LiveQuery, Query } from "../src/index.ts"

// Compile-time checks: `pnpm check` type-checks this file, and vitest runs it as a no-op.

const Note = Schema.Struct({ id: Schema.String, n: Schema.Number })
type Note = typeof Note.Type

describe("types", () => {
  test("a collection's row and key types come from its schema and getKey", () => {
    const notes = Collection.local({ id: "notes", schema: Note, getKey: (row) => row.id })
    expectTypeOf(notes).toEqualTypeOf<Effect.Effect<Collection.Collection<Note, string>, never, Scope.Scope>>()
    const numbered = Collection.local({ id: "numbered", schema: Note, getKey: (row) => row.n })
    expectTypeOf(numbered).toEqualTypeOf<Effect.Effect<Collection.Collection<Note, number>, never, Scope.Scope>>()
  })

  test("mutations and reads are typed Effects with typed errors", () => {
    const notes = {} as Collection.Collection<Note, string>
    expectTypeOf(notes.insert).parameter(0).toEqualTypeOf<Note | ReadonlyArray<Note>>()
    expectTypeOf(notes.insert).returns.toEqualTypeOf<
      Effect.Effect<Collection.Transaction, Collection.MutationRefused>
    >()
    expectTypeOf(notes.get).parameter(0).toEqualTypeOf<string>()
    expectTypeOf(notes.preload).toEqualTypeOf<Effect.Effect<void, Collection.LoadFailed>>()
    expectTypeOf<Collection.Transaction["persisted"]>().toEqualTypeOf<
      Effect.Effect<void, Collection.TransactionFailed>
    >()
    expectTypeOf(notes.changes).returns.toEqualTypeOf<
      Stream.Stream<ReadonlyArray<Collection.Change<Note, string>>>
    >()
  })

  test("a schema that transforms rows is refused: a row schema only checks", () => {
    const transformed = Schema.Struct({ id: Schema.NumberFromString })
    expectTypeOf<typeof transformed>().not.toExtend<Collection.RowSchema<{ readonly id: string }>>()
  })

  test("a live query's rows are typed by its select, and findOne is a single result", () => {
    const notes = {} as Collection.Collection<Note, string>
    const projected = LiveQuery.make((q) =>
      q.from({ note: notes.tanstack }).select(({ note }) => ({ id: note.id, double: note.n }))
    )
    expectTypeOf<Effect.Error<typeof projected>>().toEqualTypeOf<Collection.LoadFailed>()
    type Projected = Effect.Success<Effect.Success<typeof projected>["toArray"]>[number]
    // TanStack DB adds its virtual properties ($synced, $key, ...) to every result row.
    expectTypeOf<Projected>().toExtend<{ readonly id: string; readonly double: number; readonly $synced: boolean }>()
    expectTypeOf<Projected["double"]>().toEqualTypeOf<number>()
    const one = LiveQuery.make((q) =>
      q.from({ note: notes.tanstack }).where(({ note }) => Query.eq(note.id, "a")).findOne()
    )
    expectTypeOf<Effect.Success<typeof one>["tanstack"]["singleResult"]>().toEqualTypeOf<true>()
  })
})
