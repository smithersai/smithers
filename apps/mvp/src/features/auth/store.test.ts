import { Persistence } from "@smthrs/effect-tanstack-db"
import { Effect, Layer } from "effect"
import { describe, expect, test } from "vitest"
import type { Session } from "./schema"
import { AuthStore, SESSION, signedOut } from "./store"

// `signedOut` (store.ts): what a request only a signed-in person may make reads first, so a visitor's page sends no
// request to be refused (a branch's tracking, a run's credential). Only a sign-in row that says signed out says so.

/** `signedOut` over a real store whose session row says `status`. */
const signedOutWhen = (status: Session["status"]) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const auth = yield* AuthStore
      yield* Effect.orDie(auth.session.update(SESSION, (row) => void (row.status = status)))
      return yield* signedOut
    }).pipe(Effect.provide(AuthStore.layer.pipe(Layer.provide(Persistence.memory)))),
  )

describe("signedOut", () => {
  test("only a sign-in row that says signed out", async () => {
    expect(await signedOutWhen("signed_out")).toBe(true)
    expect(await signedOutWhen("signed_in")).toBe(false)
  })

  test("not while ChatApi hasn't said or couldn't be asked, nor in an app without sign-in", async () => {
    expect(await signedOutWhen("loading")).toBe(false)
    expect(await signedOutWhen("unreachable")).toBe(false)
    expect(await Effect.runPromise(signedOut)).toBe(false)
  })
})
