import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Option, Scope } from "effect"
import { type Implementation, Implementations, layerImplementations } from "../src/Action/Implementations.vibe"

const closeOrders = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0]
] as const

describe("implementation scope ownership", () => {
  for (const order of closeOrders) {
    it.effect(`keeps only live registrations when scopes close ${order.join(", ")}`, () =>
      Effect.gen(function*() {
        const table = yield* Implementations
        const scopes = yield* Effect.forEach([0, 1, 2], () => Scope.make())
        const disposed = new Set<number>()
        const closed = new Set<number>()
        const entries: Array<Implementation> = []
        for (const index of [0, 1, 2]) {
          const entry: Implementation = {
            name: "overlapping",
            action: () =>
              Effect.sync(() => {
                expect(disposed.has(index)).toBe(false)
                return index
              })
          }
          entries.push(entry)
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              disposed.add(index)
            })
          ).pipe(
            Effect.andThen(table.add(entry, { override: true })),
            Scope.provide(scopes[index]!)
          )
        }
        for (const index of order) {
          yield* Scope.close(scopes[index]!, Exit.void)
          closed.add(index)
          const newest = [2, 1, 0].find((candidate) => !closed.has(candidate))
          const found = yield* table.get("overlapping")
          expect(found).toEqual(Option.fromNullishOr(newest === undefined ? undefined : entries[newest]))
          // Exercise the retained resource as well as checking table identity.
          if (Option.isSome(found)) {
            expect(yield* found.value.action(undefined) as Effect.Effect<number>).toBe(newest)
          }
        }
        expect(disposed.size).toBe(3)
      }).pipe(Effect.provide(layerImplementations)))
  }

  it.effect("tracks repeated registrations of the same implementation independently", () =>
    Effect.gen(function*() {
      const table = yield* Implementations
      const first = yield* Scope.make()
      const second = yield* Scope.make()
      const entry: Implementation = { name: "same-object", action: () => Effect.void }
      yield* table.add(entry).pipe(Scope.provide(first))
      yield* table.add(entry).pipe(Scope.provide(second))
      yield* Scope.close(first, Exit.void)
      expect(yield* table.get(entry.name)).toEqual(Option.some(entry))
      yield* Scope.close(second, Exit.void)
      expect(yield* table.get(entry.name)).toEqual(Option.none())
    }).pipe(Effect.provide(layerImplementations)))
})
