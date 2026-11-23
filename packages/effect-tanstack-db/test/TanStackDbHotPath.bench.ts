import * as Effect from "effect/Effect"
import { describe, test } from "vitest"
import { Collection, Migrations } from "../src/index.ts"
import { id, Note, note } from "./fixtures.ts"

const initialRows: ReadonlyArray<Note> = Array.from({ length: 50 }, (_, i) => note(`n-${i}`, i, `Note body ${i}`))

const declaredStores = Array.from({ length: 25 }, (_, i) =>
  Migrations.local({
    id: `collection-${i}`,
    versions: [Note],
    getKey: (row) => row.id
  }))

const registry = Migrations.registry({ stores: declaredStores })

describe("effect-tanstack-db hot paths", () => {
  test("Collection.local decode + preload + toArray (50 rows)", async ({ bench }) => {
    await bench("create, preload, and read 50 schema-validated rows", async () => {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const collection = yield* Collection.local({
              id: id("bench-notes"),
              schema: Note,
              getKey: (row) => row.id,
              initialData: initialRows
            })
            yield* collection.preload
            return yield* collection.toArray
          })
        )
      )
    }).run({ iterations: 15, warmupIterations: 3, time: 0, warmupTime: 0 })
  })

  test("Migrations.declarationOf lookup", async ({ bench }) => {
    await bench("lookup 25 declared collections in migration registry", () => {
      for (let i = 0; i < 25; i++) {
        Migrations.declarationOf(registry, `collection-${i}`)
      }
    }).run({ time: 120, warmupTime: 30 })
  })
})
