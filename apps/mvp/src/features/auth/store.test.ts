import { Persistence } from "@smthrs/effect-tanstack-db"
import { Effect, Layer, Fiber, Stream } from "effect"
import { describe, expect, test } from "vitest"
import type { Session } from "./schema"
import { AuthStore, SESSION, signedOut, anonymousRun } from "./store"

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


test("a run never asks for a session credential before confirmed sign-in", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const auth = yield* AuthStore
    for (const status of ["loading", "signed_out", "unreachable", "signed_in"] as const) {
      yield* Effect.orDie(auth.session.update(SESSION, (row) => { row.status = status }))
      expect(yield* anonymousRun).toBe(status !== "signed_in")
    }
    yield* Effect.orDie(auth.session.delete(SESSION))
    expect(yield* anonymousRun).toBe(true)
  }).pipe(Effect.provide(AuthStore.layer.pipe(Layer.provide(Persistence.memory)))))
  expect(await Effect.runPromise(anonymousRun)).toBe(false)
})


test("a confirmed session keeps identity and publishes each successful confirmation", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const auth = yield* AuthStore
    yield* Effect.ignore(auth.confirmed.restored)
    yield* auth.confirmed.insert({ id: SESSION, login: "member", role: "member" })
    expect(yield* auth.confirmed.get(SESSION)).toMatchObject({ value: { login: "member", role: "member" } })
    const received = yield* auth.confirmations.pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped({ startImmediately: true }))
    expect(yield* auth.confirmation).toBe(0)
    yield* auth.sessionConfirmed
    yield* auth.sessionConfirmed
    expect(yield* Fiber.join(received)).toEqual([1, 2])
    expect(yield* auth.confirmation).toBe(2)
  })).pipe(Effect.provide(AuthStore.layer.pipe(Layer.provide(Persistence.memory)))))
})
