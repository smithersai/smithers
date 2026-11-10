/**
 * The identifier port the branch handlers mint through: the Web Crypto
 * default, and the deterministic counter a reproducible composition supplies
 * in its place.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as BranchIds from "../src/BranchIds.vibe"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

describe("BranchIds", () => {
  it.effect("mints unguessable, never-repeating ids by default", () =>
    Effect.gen(function*() {
      const ids = BranchIds.makeWebCrypto()
      const first = yield* (ids.fresh)
      const second = yield* (ids.fresh)

      expect(first).toMatch(uuid)
      expect(second).not.toBe(first)
    }))

  it.effect("provides the default through the layer", () =>
    Effect.gen(function*() {
      const value = yield* (
        Effect.flatMap(BranchIds.BranchIds, (ids) => ids.fresh).pipe(Effect.provide(BranchIds.layer))
      )

      expect(value).toMatch(uuid)
    }))

  it.effect("counts deterministically when a composition asks it to", () =>
    Effect.gen(function*() {
      const values = yield* (
        Effect.flatMap(BranchIds.BranchIds, (ids) => Effect.all([ids.fresh, ids.fresh, ids.fresh])).pipe(
          Effect.provide(BranchIds.layerSequential("branch"))
        )
      )

      expect(values).toEqual(["branch-1", "branch-2", "branch-3"])
    }))
})
