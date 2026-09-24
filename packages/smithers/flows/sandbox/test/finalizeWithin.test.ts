import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { finalizeWithin } from "../src/internal/finalizeWithin.ts"
import { stalledFinalizer } from "./stalledFinalizer.ts"

describe("provider finalizer deadline", () => {
  for (const phase of ["acquire", "release"] as const) {
    it.effect(
      `does not await an uninterruptible transport ${phase}`,
      () =>
        stalledFinalizer((stall) =>
          Effect.gen(function*() {
            let continued = false
            yield* Effect.scoped(Effect.gen(function*() {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  continued = true
                })
              )
              yield* Effect.addFinalizer(() =>
                finalizeWithin(
                  Effect.scoped(
                    Effect.asVoid(Effect.acquireRelease(
                      phase === "acquire" ? stall : Effect.void,
                      () => phase === "release" ? stall : Effect.void
                    ))
                  ),
                  "stuck transport"
                )
              )
            }))
            expect(continued).toBe(true)
          }), "stuck transport")
    )
  }
})
