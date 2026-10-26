import { Persistence } from "@smthrs/effect-tanstack-db"
import { AuthStore, SESSION } from "../features/auth/store"
import { Effect, Option } from "effect"
import { FetchHttpClient } from "effect/http"
import { expect, test } from "vitest"
import { renewed, renewalOf } from "./bearer"

const payload = Buffer.from(JSON.stringify({ run: "run", chain: ["parent", "issue/create"] })).toString("base64url")

test.each([payload + "x", payload + ".", ".signature", "!invalid.signature"])("malformed credential preserves shared forbidden status: %s", async (token) => {
  expect(renewalOf(token)).toEqual(Option.none())
  expect(await Effect.runPromise(Effect.result(renewed("http://127.0.0.1:1", token)).pipe(Effect.provide(FetchHttpClient.layer)))).toMatchObject({ _tag: "Failure", failure: { status: 403 } })
})

test("renewal routes by the last flow in a separated token", () => {
  expect(renewalOf(payload + ".signature")).toEqual(Option.some({ run: "run", flow: "issue/create" }))
})

test("signed-out renewal is refused locally with the real sign-in store", async () => {
  const result = await Effect.runPromise(Effect.gen(function* () {
    const auth = yield* AuthStore
    yield* auth.session.update(SESSION, (row) => void (row.status = "signed_out"))
    return yield* Effect.result(renewed("http://127.0.0.1:1", payload + ".signature"))
  }).pipe(Effect.provide(AuthStore.layer), Effect.provide(Persistence.memory), Effect.provide(FetchHttpClient.layer), Effect.scoped))
  expect(result).toMatchObject({ _tag: "Failure", failure: { status: 401 } })
})
