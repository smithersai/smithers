import { ShapeSource } from "@smthrs/effect-electric"
import { Persistence } from "@smthrs/effect-tanstack-db"
import { Effect, Layer } from "effect"
import { expect, test } from "vitest"
import { AuthStore } from "../auth/store"
import { adminShapeSource } from "./source.vibe"

// Electric uses this metadata before calling request: a wrapper that drops it shares global replay state.
test.each([undefined, "admin-device-realm"])("Admin permission checks retain the source replay realm %s", async (cacheNamespace) => {
  await Effect.runPromise(Effect.gen(function* () {
    const source = { ...ShapeSource.fetchSource, cacheNamespace }
    const guarded = adminShapeSource(source, yield* AuthStore, new Map())
    expect(guarded.cacheNamespace).toBe(cacheNamespace)
  }).pipe(
    Effect.provide(AuthStore.layer.pipe(Layer.provide(Persistence.memory))),
  ))
})
