import { Persistence } from "@smthrs/effect-tanstack-db"
import { Effect, Fiber, Layer } from "effect"
import { expect, test } from "vitest"
import { AuthStore, SESSION } from "../auth/store"
import { identityReady } from "./identity"

test.each(["signed_in", "signed_out", "unreachable"] as const)("branch admission waits through loading for %s", async (status) => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const auth = yield* AuthStore
    const waiting = yield* Effect.forkScoped(identityReady, { startImmediately: true })
    expect(waiting.pollUnsafe()).toBeUndefined()
    yield* Effect.orDie(auth.session.update(SESSION, (row) => { row.status = status }))
    yield* Fiber.join(waiting)
    // Opening another route after the answer doesn't wait for a second confirmation.
    yield* identityReady
  })).pipe(Effect.provide(AuthStore.layer.pipe(Layer.provide(Persistence.memory)))))
})

test("a host without sign-in has no session gate", async () => {
  expect(await Effect.runPromise(identityReady)).toBeUndefined()
})
